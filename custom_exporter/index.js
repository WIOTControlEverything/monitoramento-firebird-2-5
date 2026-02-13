const express = require('express');
const Firebird = require('node-firebird');
const client = require('prom-client');

const app = express();
const register = new client.Registry();

// Configurações do Banco
const options = {
    host: process.env.DB_HOST || '192.168.0.75',
    port: 3050,
    database: process.env.DB_PATH || '/home/latitude/firebird/data/latitude.fdb',
    user: process.env.DB_USER || 'SYSDBA',
    password: process.env.DB_PASSWORD || 'masterkey',
    lowercase_keys: false,
    role: null,
    pageSize: 4096,
    retryConnectionInterval: 1000,
    blobAsText: true,
    encoding: 'UTF8',
    // Timeout de conexão para não ficar preso para sempre
    timeout: 10000
};

// --- DEFINIÇÃO DAS MÉTRICAS ---
const connectionsActive = new client.Gauge({ name: 'firebird_connections_total', help: 'Total de conexoes ativas no momento' });
const transactionsActive = new client.Gauge({ name: 'firebird_transactions_total', help: 'Total de transacoes ativas' });
const oldestTransaction = new client.Gauge({ name: 'firebird_oldest_transaction_seconds', help: 'Idade da transacao ativa mais antiga em segundos' });
const connectionDetail = new client.Gauge({ name: 'firebird_connection_duration_seconds', help: 'Tempo de duracao da conexao em segundos', labelNames: ['ip', 'process', 'user', 'id'] });
const connectionTxCount = new client.Gauge({ name: 'firebird_connection_tx_count', help: 'Numero de transacoes ativas por esta conexao especifica', labelNames: ['ip', 'process', 'user', 'id'] });
const connectionTxAge = new client.Gauge({ name: 'firebird_connection_tx_age_seconds', help: 'Idade em segundos da transacao ativa mais antiga desta conexao', labelNames: ['ip', 'process', 'user', 'id'] });
const connectionTxList = new client.Gauge({ name: 'firebird_connection_tx_ids_info', help: 'Métrica dummy usada apenas para levar a lista de IDs como label', labelNames: ['ip', 'process', 'user', 'id', 'tx_ids'] });
const connectionSqlText = new client.Gauge({ name: 'firebird_connection_current_sql', help: 'SQL que esta sendo executado por esta conexao no momento', labelNames: ['ip', 'process', 'user', 'id', 'sql_text_short'] });
const statementSeqReads = new client.Gauge({ name: 'firebird_statement_seq_reads', help: 'Leituras sequenciais (Full Scan) da query atual - ALERTA DE LENTIDAO', labelNames: ['ip', 'sql_text', 'id'] });
const statementIdxReads = new client.Gauge({ name: 'firebird_statement_idx_reads', help: 'Leituras via indice da query atual', labelNames: ['ip', 'sql_text', 'id'] });
const dbInfo = new client.Gauge({ name: 'firebird_database_info', help: 'Informacoes estaticas de configuracao do banco', labelNames: ['engine_version', 'ods_version', 'dialect', 'db_path'] });
const dbPageSize = new client.Gauge({ name: 'firebird_db_page_size_bytes', help: 'Tamanho da pagina do banco de dados' });
const dbForcedWrites = new client.Gauge({ name: 'firebird_db_forced_writes', help: 'Status do Forced Writes (1 = Ligado/Seguro, 0 = Desligado/Risco)' });
const dbSweepInterval = new client.Gauge({ name: 'firebird_db_sweep_interval', help: 'Intervalo de Sweep automatico configurado' });
const dbPageBuffers = new client.Gauge({ name: 'firebird_db_page_buffers', help: 'Numero de paginas mantidas em cache (Buffers)' });

register.registerMetric(connectionsActive);
register.registerMetric(transactionsActive);
register.registerMetric(oldestTransaction);
register.registerMetric(connectionDetail);
register.registerMetric(connectionTxCount);
register.registerMetric(connectionTxAge);
register.registerMetric(connectionTxList);
register.registerMetric(connectionSqlText);
register.registerMetric(statementSeqReads);
register.registerMetric(statementIdxReads);
register.registerMetric(dbInfo);
register.registerMetric(dbPageSize);
register.registerMetric(dbForcedWrites);
register.registerMetric(dbSweepInterval);
register.registerMetric(dbPageBuffers);

// Função auxiliar de Query com LOG DE TEMPO
const query = (db, sql, stepName) => {
    return new Promise((resolve, reject) => {
        console.time(stepName); // Inicia cronometro
        db.query(sql, (err, result) => {
            console.timeEnd(stepName); // Para cronometro e mostra tempo
            if (err) {
                console.error(`❌ ERRO em ${stepName}: ${err.message}`);
                return reject(err);
            }
            resolve(result);
        });
    });
};

app.get('/metrics', async (req, res) => {
    console.log(`\n--- [${new Date().toISOString()}] NOVA REQUISICAO DE METRICAS ---`);

    Firebird.attach(options, async (err, db) => {
        if (err) {
            console.error("❌ ERRO FATAL ao conectar no Firebird:", err.message);
            return res.status(500).send(err.message);
        }
        console.log("✅ Conectado ao Firebird.");

        try {
            const now = new Date();

            // PASSO 1: Totais
            const resConn = await query(db, 'SELECT count(*) as CNT FROM MON$ATTACHMENTS WHERE MON$STATE = 1', '1.Count_Attachments');
            connectionsActive.set(resConn[0].CNT);

            const resTrans = await query(db, 'SELECT count(*) as CNT FROM MON$TRANSACTIONS WHERE MON$STATE = 1', '2.Count_Transactions');
            transactionsActive.set(resTrans[0].CNT);

            // PASSO 2: Transação Antiga
            const sqlOldest = 'SELECT MIN(MON$TIMESTAMP) as OLD_TS FROM MON$TRANSACTIONS WHERE MON$STATE = 1';
            const resOldest = await query(db, sqlOldest, '3.Oldest_Transaction');
            if (resOldest[0].OLD_TS) {
                const oldest = new Date(resOldest[0].OLD_TS);
                const diffSeconds = (now - oldest) / 1000;
                oldestTransaction.set(diffSeconds);
            } else {
                oldestTransaction.set(0);
            }

            // PASSO 3: Detalhes Complexos (Onde costuma travar)
            connectionDetail.reset();
            connectionTxCount.reset();
            connectionTxList.reset();
            connectionTxAge.reset();

            const sqlConnDetails = `
                SELECT
                    A.MON$ATTACHMENT_ID as ID,
                    A.MON$REMOTE_ADDRESS as IP,
                    A.MON$REMOTE_PROCESS as PROC,
                    A.MON$USER as USR,
                    A.MON$TIMESTAMP as TS,
                    (SELECT COUNT(*) FROM MON$TRANSACTIONS T WHERE T.MON$ATTACHMENT_ID = A.MON$ATTACHMENT_ID AND T.MON$STATE = 1) as TX_COUNT,
                    (SELECT DATEDIFF(SECOND, MIN(T.MON$TIMESTAMP), CURRENT_TIMESTAMP) FROM MON$TRANSACTIONS T WHERE T.MON$ATTACHMENT_ID = A.MON$ATTACHMENT_ID AND T.MON$STATE = 1) as TX_AGE_SEC,
                    (SELECT CAST(LIST(T.MON$TRANSACTION_ID, ', ') AS VARCHAR(1000)) FROM MON$TRANSACTIONS T WHERE T.MON$ATTACHMENT_ID = A.MON$ATTACHMENT_ID AND T.MON$STATE = 1) as TX_LIST_STR
                FROM MON$ATTACHMENTS A
                WHERE A.MON$STATE = 1
            `;

            // AQUI É O TESTE DE FOGO 1
            const rowsConn = await query(db, sqlConnDetails, '4.Details_Attachments');

            rowsConn.forEach(row => {
                const connStart = new Date(row.TS);
                const duration = (now - connStart) / 1000;
                let cleanIp = row.IP ? row.IP.toString().replace('IPv4:', '').split('/')[0].trim() : 'Internal';
                let rawProc = row.PROC ? row.PROC.toString().trim() : 'Unknown';
                let cleanProc = rawProc.startsWith('\\\\') ? rawProc.split('\\').pop() : rawProc;
                let cleanUser = row.USR ? row.USR.toString().trim() : 'Unknown';

                connectionDetail.labels(cleanIp, cleanProc, cleanUser, row.ID).set(duration);
                connectionTxCount.labels(cleanIp, cleanProc, cleanUser, row.ID).set(row.TX_COUNT);
                let txAge = row.TX_AGE_SEC !== null ? row.TX_AGE_SEC : 0;
                connectionTxAge.labels(cleanIp, cleanProc, cleanUser, row.ID).set(txAge);

                // Tratamento seguro de BLOB/Buffer/Function
                let txListString = '-';
                if (row.TX_LIST_STR) {
                    if (typeof row.TX_LIST_STR === 'function') {
                        txListString = 'BLOB_DATA';
                    } else if (Buffer.isBuffer(row.TX_LIST_STR)) {
                        txListString = row.TX_LIST_STR.toString('utf8');
                    } else {
                        txListString = row.TX_LIST_STR.toString();
                    }
                }
                connectionTxList.labels(cleanIp, cleanProc, cleanUser, row.ID, txListString).set(1);
            });

            // PASSO 4: Detalhes de Queries (MON$STATEMENTS) - O GRANDE SUSPEITO
            statementSeqReads.reset();
            statementIdxReads.reset();

            const sqlStatements = `
                SELECT
                    S.MON$ATTACHMENT_ID as ID,
                    SUBSTRING(S.MON$SQL_TEXT FROM 1 FOR 255) as SQL_TEXT,
                    R.MON$RECORD_SEQ_READS as SEQ_READS,
                    R.MON$RECORD_IDX_READS as IDX_READS,
                    A.MON$REMOTE_ADDRESS as IP
                FROM
                    MON$STATEMENTS S
                        JOIN MON$RECORD_STATS R ON R.MON$STAT_ID = S.MON$STAT_ID
                        JOIN MON$ATTACHMENTS A ON A.MON$ATTACHMENT_ID = S.MON$ATTACHMENT_ID
                WHERE
                    S.MON$STATE = 1
            `;

            // AQUI É O TESTE DE FOGO 2
            const rowsStmt = await query(db, sqlStatements, '5.Active_Statements');

            rowsStmt.forEach(row => {
                let cleanIp = row.IP ? row.IP.toString().replace('IPv4:', '').split('/')[0].trim() : 'Internal';

                // Tratamento de BLOB para SQL TEXT também
                let cleanSql = 'Empty';
                if (row.SQL_TEXT) {
                    if (Buffer.isBuffer(row.SQL_TEXT)) cleanSql = row.SQL_TEXT.toString('utf8');
                    else cleanSql = row.SQL_TEXT.toString();
                }
                cleanSql = cleanSql.trim().replace(/\s+/g, ' ');

                statementSeqReads.labels(cleanIp, cleanSql, row.ID).set(row.SEQ_READS);
                statementIdxReads.labels(cleanIp, cleanSql, row.ID).set(row.IDX_READS);
            });

            // PASSO 5: Info do Banco
            dbInfo.reset();
            dbPageSize.reset();
            dbPageBuffers.reset();
            dbForcedWrites.reset();
            dbSweepInterval.reset();

            const sqlInfo = `
                SELECT 
                    M.MON$DATABASE_NAME as DB_PATH,
                    M.MON$PAGE_SIZE as PAGE_SIZE,
                    M.MON$PAGE_BUFFERS as BUFFERS,
                    M.MON$SQL_DIALECT as DIALECT,
                    M.MON$ODS_MAJOR || '.' || M.MON$ODS_MINOR as ODS_VER,
                    M.MON$FORCED_WRITES as FW,
                    M.MON$SWEEP_INTERVAL as SWEEP,
                    rdb$get_context('SYSTEM', 'ENGINE_VERSION') as ENGINE_VER
                FROM MON$DATABASE M
            `;

            const resInfo = await query(db, sqlInfo, '6.Database_Info');

            if (resInfo.length > 0) {
                const row = resInfo[0];
                dbInfo.labels(row.ENGINE_VER, row.ODS_VER, row.DIALECT.toString(), row.DB_PATH).set(1);
                dbPageSize.set(row.PAGE_SIZE);
                dbPageBuffers.set(row.BUFFERS);
                dbForcedWrites.set(row.FW);
                dbSweepInterval.set(row.SWEEP);
            }

            console.log("🏁 Métricas coletadas com sucesso. Desconectando.");
            db.detach();
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());

        } catch (e) {
            console.error("❌ ERRO NO PROCESSO:", e);
            if (db) db.detach();
            res.status(500).send(e.message);
        }
    });
});

app.listen(9399, () => {
    console.log('Exporter Full v4 (DEBUG) rodando na porta 9399');
});