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
    timeout: 5000 // Timeout de 5s para não encavalar
};

// --- MÉTRICAS ---
const connectionsActive = new client.Gauge({ name: 'firebird_connections_total', help: 'Total de conexoes ativas' });
const transactionsActive = new client.Gauge({ name: 'firebird_transactions_total', help: 'Total de transacoes ativas' });
const oldestTransaction = new client.Gauge({ name: 'firebird_oldest_transaction_seconds', help: 'Idade da transacao mais antiga' });
const connectionDetail = new client.Gauge({ name: 'firebird_connection_duration_seconds', help: 'Tempo conexao', labelNames: ['ip', 'process', 'user', 'id'] });
const connectionTxCount = new client.Gauge({ name: 'firebird_connection_tx_count', help: 'Qtd transacoes', labelNames: ['ip', 'process', 'user', 'id'] });
const connectionTxAge = new client.Gauge({ name: 'firebird_connection_tx_age_seconds', help: 'Idade transacao', labelNames: ['ip', 'process', 'user', 'id'] });
const connectionTxList = new client.Gauge({ name: 'firebird_connection_tx_ids_info', help: 'Lista IDs', labelNames: ['ip', 'process', 'user', 'id', 'tx_ids'] });

const dbInfo = new client.Gauge({ name: 'firebird_database_info', help: 'Info Banco', labelNames: ['engine_version', 'ods_version', 'dialect', 'db_path'] });
const dbPageSize = new client.Gauge({ name: 'firebird_db_page_size_bytes', help: 'Page Size' });
const dbForcedWrites = new client.Gauge({ name: 'firebird_db_forced_writes', help: 'Forced Writes' });
const dbSweepInterval = new client.Gauge({ name: 'firebird_db_sweep_interval', help: 'Sweep Interval' });
const dbPageBuffers = new client.Gauge({ name: 'firebird_db_page_buffers', help: 'Buffers' });

register.registerMetric(connectionsActive);
register.registerMetric(transactionsActive);
register.registerMetric(oldestTransaction);
register.registerMetric(connectionDetail);
register.registerMetric(connectionTxCount);
register.registerMetric(connectionTxAge);
register.registerMetric(connectionTxList);
register.registerMetric(dbInfo);
register.registerMetric(dbPageSize);
register.registerMetric(dbForcedWrites);
register.registerMetric(dbSweepInterval);
register.registerMetric(dbPageBuffers);

const query = (db, sql, stepName) => {
    return new Promise((resolve, reject) => {
        console.time(stepName);
        db.query(sql, (err, result) => {
            console.timeEnd(stepName);
            if (err) {
                console.error(`❌ ERRO ${stepName}: ${err.message}`);
                return reject(err);
            }
            resolve(result);
        });
    });
};

app.get('/metrics', async (req, res) => {
    // console.log(`--- REQ METRICS ---`); // Comentei para limpar o log

    Firebird.attach(options, async (err, db) => {
        if (err) {
            console.error("❌ ERRO CONEXAO:", err.message);
            return res.status(500).send(err.message);
        }

        try {
            const now = new Date();

            // 1. Totais
            const resConn = await query(db, 'SELECT count(*) as CNT FROM MON$ATTACHMENTS WHERE MON$STATE = 1', '1.Count_Attach');
            connectionsActive.set(resConn[0].CNT);

            const resTrans = await query(db, 'SELECT count(*) as CNT FROM MON$TRANSACTIONS WHERE MON$STATE = 1', '2.Count_Trans');
            transactionsActive.set(resTrans[0].CNT);

            // 2. Oldest
            const sqlOldest = 'SELECT MIN(MON$TIMESTAMP) as OLD_TS FROM MON$TRANSACTIONS WHERE MON$STATE = 1';
            const resOldest = await query(db, sqlOldest, '3.Oldest_Trans');
            if (resOldest[0].OLD_TS) {
                oldestTransaction.set((now - new Date(resOldest[0].OLD_TS)) / 1000);
            } else {
                oldestTransaction.set(0);
            }

            // 3. Detalhes Conexão (Isso funcionou no seu log)
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

            const rowsConn = await query(db, sqlConnDetails, '4.Details_Attach');

            rowsConn.forEach(row => {
                const duration = (now - new Date(row.TS)) / 1000;
                let cleanIp = row.IP ? row.IP.toString().replace('IPv4:', '').split('/')[0].trim() : 'Internal';
                let rawProc = row.PROC ? row.PROC.toString().trim() : 'Unknown';
                let cleanProc = rawProc.startsWith('\\\\') ? rawProc.split('\\').pop() : rawProc;
                let cleanUser = row.USR ? row.USR.toString().trim() : 'Unknown';

                connectionDetail.labels(cleanIp, cleanProc, cleanUser, row.ID).set(duration);
                connectionTxCount.labels(cleanIp, cleanProc, cleanUser, row.ID).set(row.TX_COUNT);

                let txAge = row.TX_AGE_SEC !== null ? row.TX_AGE_SEC : 0;
                connectionTxAge.labels(cleanIp, cleanProc, cleanUser, row.ID).set(txAge);

                let txListString = '-';
                if (row.TX_LIST_STR) {
                    if (Buffer.isBuffer(row.TX_LIST_STR)) txListString = row.TX_LIST_STR.toString('utf8');
                    else txListString = row.TX_LIST_STR.toString();
                }
                connectionTxList.labels(cleanIp, cleanProc, cleanUser, row.ID, txListString).set(1);
            });

            // 6. Info Banco (Leve e rápido)
            dbInfo.reset();
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

            const resInfo = await query(db, sqlInfo, '6.DB_Info');
            if (resInfo.length > 0) {
                const row = resInfo[0];
                dbInfo.labels(row.ENGINE_VER, row.ODS_VER, row.DIALECT.toString(), row.DB_PATH).set(1);
                dbPageSize.set(row.PAGE_SIZE);
                dbPageBuffers.set(row.BUFFERS);
                dbForcedWrites.set(row.FW);
                dbSweepInterval.set(row.SWEEP);
            }

            db.detach();
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());

        } catch (e) {
            console.error("❌ ERRO GERAL:", e);
            if (db) db.detach();
            res.status(500).send(e.message);
        }
    });
});

app.listen(9399, () => {
    console.log('Exporter V5 (Stable) rodando na porta 9399');
});