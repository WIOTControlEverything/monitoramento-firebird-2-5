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

// 1. Métricas Globais (Contadores Simples)
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

// 2. Métrica Detalhada (Com Labels para o Grafana filtrar por IP)
const connectionDetail = new client.Gauge({
    name: 'firebird_connection_duration_seconds',
    help: 'Detalhes de cada conexao ativa',
    labelNames: ['ip', 'process', 'user', 'id'] // <--- O SEGREDO ESTÁ AQUI
});

register.registerMetric(connectionsActive);
register.registerMetric(transactionsActive);
register.registerMetric(oldestTransaction);
register.registerMetric(connectionDetail);

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

            // A. Coleta Totais (Rápido)
            const resConn = await query(db, 'SELECT count(*) as CNT FROM MON$ATTACHMENTS WHERE MON$STATE = 1');
            connectionsActive.set(resConn[0].CNT);

            const resTrans = await query(db, 'SELECT count(*) as CNT FROM MON$TRANSACTIONS WHERE MON$STATE = 1');
            transactionsActive.set(resTrans[0].CNT);

            // B. Coleta Transação Mais Antiga
            const sqlOldest = 'SELECT MIN(MON$TIMESTAMP) as OLD_TS FROM MON$TRANSACTIONS WHERE MON$STATE = 1';
            const resOldest = await query(db, sqlOldest);
            if (resOldest[0].OLD_TS) {
                const oldest = new Date(resOldest[0].OLD_TS);
                const diffSeconds = (now - oldest) / 1000;
                oldestTransaction.set(diffSeconds);
            } else {
                oldestTransaction.set(0);
            }

            // C. Coleta Detalhada por Conexão (Para tabela no Grafana)
            // IMPORTANTE: Limpar dados anteriores para não sobrar lixo de conexões fechadas
            connectionDetail.reset();

            const sqlDetails = `
                SELECT 
                    MON$ATTACHMENT_ID as ID, 
                    MON$REMOTE_ADDRESS as IP, 
                    MON$REMOTE_PROCESS as PROC, 
                    MON$USER as USR, 
                    MON$TIMESTAMP as TS
                FROM MON$ATTACHMENTS 
                WHERE MON$STATE = 1
            `;

            const rows = await query(db, sqlDetails);

            rows.forEach(row => {
                const connStart = new Date(row.TS);
                const duration = (now - connStart) / 1000;

                // Tratamento básico para limpar lixo do IP (Firebird às vezes manda IPv4:...)
                let cleanIp = row.IP ? row.IP.toString().replace('IPv4:', '').trim() : 'Internal';
                let cleanProc = row.PROC ? row.PROC.toString().trim() : 'Unknown';
                let cleanUser = row.USR ? row.USR.toString().trim() : 'Unknown';

                // Seta o valor com as etiquetas
                connectionDetail.labels(cleanIp, cleanProc, cleanUser, row.ID).set(duration);
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
    console.log('Exporter Atualizado rodando na porta 9399');
});