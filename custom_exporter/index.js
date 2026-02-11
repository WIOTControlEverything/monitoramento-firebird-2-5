const express = require('express');
const Firebird = require('node-firebird');
const client = require('prom-client');

const app = express();
const register = new client.Registry();

// Configurações do Banco (Pega das variaveis de ambiente ou usa padrao)
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

// Definição das Métricas
const connectionsActive = new client.Gauge({
    name: 'firebird_connections_active',
    help: 'Numero de conexoes ativas no momento'
});
const transactionsActive = new client.Gauge({
    name: 'firebird_transactions_active',
    help: 'Numero de transacoes ativas'
});
const oldestTransaction = new client.Gauge({
    name: 'firebird_oldest_transaction_seconds',
    help: 'Idade da transacao ativa mais antiga em segundos'
});

// Registra métricas no registro global
register.registerMetric(connectionsActive);
register.registerMetric(transactionsActive);
register.registerMetric(oldestTransaction);

// Função para rodar Query Promisificada
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
            // Se der erro de conexão, retorna o erro ou mantém a métrica anterior
            return res.status(500).send(err.message);
        }

        try {
            // 1. Conexões Ativas
            const resConn = await query(db, 'SELECT count(*) as CNT FROM MON$ATTACHMENTS WHERE MON$STATE = 1');
            connectionsActive.set(resConn[0].CNT);

            // 2. Transações Ativas
            const resTrans = await query(db, 'SELECT count(*) as CNT FROM MON$TRANSACTIONS WHERE MON$STATE = 1');
            transactionsActive.set(resTrans[0].CNT);

            // 3. Transação Mais Antiga (Cálculo direto no Node para evitar erro de SQL no FB 2.5)
            // Pegamos o Timestamp da transação mais antiga
            const sqlOldest = 'SELECT MIN(MON$TIMESTAMP) as OLD_TS FROM MON$TRANSACTIONS WHERE MON$STATE = 1';
            const resOldest = await query(db, sqlOldest);

            if (resOldest[0].OLD_TS) {
                const now = new Date();
                const oldest = new Date(resOldest[0].OLD_TS);
                const diffSeconds = (now - oldest) / 1000;
                oldestTransaction.set(diffSeconds);
            } else {
                oldestTransaction.set(0);
            }

            db.detach();
            res.set('Content-Type', register.contentType);
            res.end(await register.metrics());

        } catch (e) {
            console.error("Erro na query:", e);
            db.detach();
            res.status(500).send(e.message);
        }
    });
});

app.listen(9399, () => {
    console.log('Exporter rodando na porta 9399');
    console.log(`Alvo: ${options.host}:${options.database}`);
});