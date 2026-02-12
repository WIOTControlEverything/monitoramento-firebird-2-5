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
};

// --- DEFINIÇÃO DAS MÉTRICAS ---

// 1. Totais
const connectionsActive = new client.Gauge({
    name: 'firebird_connections_total',
    help: 'Total de conexoes ativas no momento'
});
const transactionsActive = new client.Gauge({
    name: 'firebird_transactions_total',
    help: 'Total de transacoes ativas'
});
const oldestTransaction = new client.Gauge({
    name: 'firebird_oldest_transaction_seconds',
    help: 'Idade da transacao ativa mais antiga em segundos'
});

// 2. Detalhe da Conexão (Tempo Online)
const connectionDetail = new client.Gauge({
    name: 'firebird_connection_duration_seconds',
    help: 'Tempo de duracao da conexao em segundos',
    labelNames: ['ip', 'process', 'user', 'id']
});

// 3. Detalhe da Conexão (Quantidade de Transações) -- NOVA METRICA --
const connectionTxCount = new client.Gauge({
    name: 'firebird_connection_tx_count',
    help: 'Numero de transacoes ativas por esta conexao especifica',
    labelNames: ['ip', 'process', 'user', 'id']
});

const connectionTxAge = new client.Gauge({
    name: 'firebird_connection_tx_age_seconds',
    help: 'Idade em segundos da transacao ativa mais antiga desta conexao',
    labelNames: ['ip', 'process', 'user', 'id']
});

// 4. Lista de IDs (Hack para exibir texto no Grafana)
const connectionTxList = new client.Gauge({
    name: 'firebird_connection_tx_ids_info',
    help: 'Métrica dummy usada apenas para levar a lista de IDs como label',
    labelNames: ['ip', 'process', 'user', 'id', 'tx_ids']
});

// 5. Detalhe das Queries
const statementSeqReads = new client.Gauge({
    name: 'firebird_statement_seq_reads',
    help: 'Leituras sequenciais (Full Scan) da query atual - ALERTA DE LENTIDAO',
    labelNames: ['ip', 'sql_text', 'id']
});
const statementIdxReads = new client.Gauge({
    name: 'firebird_statement_idx_reads',
    help: 'Leituras via indice da query atual',
    labelNames: ['ip', 'sql_text', 'id']
});

register.registerMetric(connectionsActive);
register.registerMetric(transactionsActive);
register.registerMetric(oldestTransaction);
register.registerMetric(connectionDetail);
register.registerMetric(connectionTxCount);
register.registerMetric(connectionTxAge);
register.registerMetric(connectionTxList);
register.registerMetric(statementSeqReads);
register.registerMetric(statementIdxReads);

// Função auxiliar de Query
const query = (db, sql) => {
    return new Promise((resolve, reject) => {
        db.query(sql, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
    });
};

app.get('/metrics', async (req, res) => {
    Firebird.attach(options, async (err, db) => {
        if (err) {
            console.error("Erro ao conectar no Firebird:", err.message);
            return res.status(500).send(err.message);
        }

        try {
            const now = new Date();

            // A. Coleta Totais
            const resConn = await query(db, 'SELECT count(*) as CNT FROM MON$ATTACHMENTS WHERE MON$STATE = 1');
            connectionsActive.set(resConn[0].CNT);

            const resTrans = await query(db, 'SELECT count(*) as CNT FROM MON$TRANSACTIONS WHERE MON$STATE = 1');
            transactionsActive.set(resTrans[0].CNT);

            // B. Transação Mais Antiga
            const sqlOldest = 'SELECT MIN(MON$TIMESTAMP) as OLD_TS FROM MON$TRANSACTIONS WHERE MON$STATE = 1';
            const resOldest = await query(db, sqlOldest);
            if (resOldest[0].OLD_TS) {
                const oldest = new Date(resOldest[0].OLD_TS);
                const diffSeconds = (now - oldest) / 1000;
                oldestTransaction.set(diffSeconds);
            } else {
                oldestTransaction.set(0);
            }

            // C. Detalhes de Conexão + Contagem de Transações por Conexão
            connectionDetail.reset();
            connectionTxCount.reset();
            connectionTxList.reset();
            connectionTxAge.reset();

            // Query aprimorada: Traz os dados da conexão E conta quantas transações ela tem
            const sqlConnDetails = `
                SELECT
                    A.MON$ATTACHMENT_ID as ID,
                    A.MON$REMOTE_ADDRESS as IP,
                    A.MON$REMOTE_PROCESS as PROC,
                    A.MON$USER as USR,
                    A.MON$TIMESTAMP as TS, -- Hora que CONECTOU

                    -- Conta quantas transações ativas tem
                    (SELECT COUNT(*)
                     FROM MON$TRANSACTIONS T
                     WHERE T.MON$ATTACHMENT_ID = A.MON$ATTACHMENT_ID AND T.MON$STATE = 1) as TX_COUNT,

                    -- CRUCIAL: Calcula a idade da transação mais velha em SEGUNDOS
                    (SELECT DATEDIFF(SECOND, MIN(T.MON$TIMESTAMP), CURRENT_TIMESTAMP)
                     FROM MON$TRANSACTIONS T
                     WHERE T.MON$ATTACHMENT_ID = A.MON$ATTACHMENT_ID AND T.MON$STATE = 1) as TX_AGE_SEC,

                    -- Lista os IDs para auditoria
                    (SELECT LIST(T.MON$TRANSACTION_ID, ', ')
                     FROM MON$TRANSACTIONS T
                     WHERE T.MON$ATTACHMENT_ID = A.MON$ATTACHMENT_ID AND T.MON$STATE = 1) as TX_LIST_STR
                FROM MON$ATTACHMENTS A
                WHERE A.MON$STATE = 1
            `;

            const rowsConn = await query(db, sqlConnDetails);

            rowsConn.forEach(row => {
                const connStart = new Date(row.TS);
                const duration = (now - connStart) / 1000;

                let cleanIp = row.IP ? row.IP.toString().replace('IPv4:', '').split('/')[0].trim() : 'Internal';
                let rawProc = row.PROC ? row.PROC.toString().trim() : 'Unknown';
                let cleanProc = rawProc;

                // Regra: Se começar com "\\" (caminho de rede), pega tudo depois da última barra
                if (rawProc.startsWith('\\\\')) {
                    cleanProc = rawProc.split('\\').pop();
                }
                let cleanUser = row.USR ? row.USR.toString().trim() : 'Unknown';

                // Métrica de Duração
                connectionDetail.labels(cleanIp, cleanProc, cleanUser, row.ID).set(duration);

                // Métrica de Transações Ativas (Novo)
                connectionTxCount.labels(cleanIp, cleanProc, cleanUser, row.ID).set(row.TX_COUNT);

                let txAge = row.TX_AGE_SEC !== null ? row.TX_AGE_SEC : 0;
                connectionTxAge.labels(cleanIp, cleanProc, cleanUser, row.ID).set(txAge);

                // Se tiver transação, pega a lista. Se não, deixa vazio.
                let txListString = row.TX_LIST_STR ? row.TX_LIST_STR.toString() : '-';

                // O valor é 1 (dummy), o que importa é a label tx_ids
                connectionTxList.labels(cleanIp, cleanProc, cleanUser, row.ID, txListString).set(1);
            });

            // D. Queries Executando AGORA
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

            const rowsStmt = await query(db, sqlStatements);

            rowsStmt.forEach(row => {
                let cleanIp = row.IP ? row.IP.toString().replace('IPv4:', '').split('/')[0].trim() : 'Internal';
                let cleanSql = row.SQL_TEXT ? row.SQL_TEXT.toString().trim().replace(/\s+/g, ' ') : 'Empty';

                statementSeqReads.labels(cleanIp, cleanSql, row.ID).set(row.SEQ_READS);
                statementIdxReads.labels(cleanIp, cleanSql, row.ID).set(row.IDX_READS);
            });

            db.detach();
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());

        } catch (e) {
            console.error("Erro na query:", e);
            if (db) db.detach();
            res.status(500).send(e.message);
        }
    });
});

app.listen(9399, () => {
    console.log('Exporter Full v2 rodando na porta 9399');
});