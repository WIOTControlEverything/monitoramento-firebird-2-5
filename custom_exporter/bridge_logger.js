const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

// CONFIGURAÇÃO DO SEU BANCO EXISTENTE
const mysqlConfig = {
    host: 'mariadb',
    port: 3306,
    user: 'root',
    password: 'At50lcdu@',
    database: 'monitor_firebird',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// CONFIGURAÇÃO DO FIREBIRD
const fbConfig = {
    bin: 'fbtracemgr',
    service: '192.168.0.75:service_mgr',
    user: 'SYSDBA',
    password: 'masterkey',
    conf: './fbtrace.conf'
};

async function startBridge() {
    console.log("Iniciando Bridge Logger...");

    // Cria pool
    const pool = mysql.createPool(mysqlConfig);

    // Inicia fbtracemgr
    const trace = spawn(fbConfig.bin, [
        '-se', fbConfig.service,
        '-user', fbConfig.user,
        '-password', fbConfig.password,
        '-start',
        '-name', 'Bridge_Logger_Node',
        '-config', fbConfig.conf
    ]);

    let buffer = '';

    trace.stdout.on('data', async (data) => {
        buffer += data.toString();
        // Quebra por data (ISO 8601) para processar blocos
        const blocks = buffer.split(/\n(?=\d{4}-\d{2}-\d{2}T)/);

        if (blocks.length > 1) {
            buffer = blocks.pop();
            for (const block of blocks) {
                if (block.trim().length > 10) await processBlock(pool, block);
            }
        }
    });

    trace.stderr.on('data', (data) => {
        const msg = data.toString();
        if (!msg.includes('Trace session ID')) console.error(`[FB Trace]: ${msg}`);
    });

    trace.on('close', (code) => {
        console.log(`Trace fechou (codigo ${code}). Reiniciando em 5s...`);
        setTimeout(startBridge, 5000);
    });
}

async function processBlock(pool, text) {
    try {
        const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{4})/);
        const txMatch = text.match(/\(transaction\s+(\d+)\)/i) || text.match(/Transaction\s+(\d+)/i);
        const durMatch = text.match(/(\d+)\s+ms/);
        const sqlMatch = text.match(/(SELECT|INSERT|UPDATE|DELETE|EXECUTE|WITH)[\s\S]*/i);
        const userMatch = text.match(/user\s+([^\s,]+)/i);
        const ipMatch = text.match(/remote\s+([^\s,]+)/i);

        if (durMatch && sqlMatch) {
            const dataEvento = dateMatch ? new Date(dateMatch[1]) : new Date();
            const transacaoId = txMatch ? txMatch[1] : 0;
            const duracao = parseInt(durMatch[1]);
            const sql = sqlMatch[0].trim();
            const usuario = userMatch ? userMatch[1] : 'Unknown';
            let ip = ipMatch ? ipMatch[1] : 'Unknown';
            ip = ip.replace('IPv4:', '').split('/')[0];

            const query = `INSERT INTO fb_slow_log (data_evento, transacao_id, duracao_ms, sql_text, usuario, ip_origem) VALUES (?, ?, ?, ?, ?, ?)`;
            await pool.execute(query, [dataEvento, transacaoId, duracao, sql, usuario, ip]);
            console.log(`Log salvo: TX ${transacaoId} (${duracao}ms)`);
        }
    } catch (e) {
        console.error("Erro processando bloco:", e.message);
    }
}

startBridge();