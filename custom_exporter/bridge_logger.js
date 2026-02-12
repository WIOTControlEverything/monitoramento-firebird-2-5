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
    bin: '/usr/bin/fbtracemgr',
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
        // 1. DATA (Padrão: 2026-02-12 15:05:09)
        const dateMatch = text.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);

        // 2. TRANSAÇÃO (Padrão: TRA_8867979)
        const txMatch = text.match(/TRA_(\d+)/);

        // 3. DURAÇÃO (Padrão: 2995 ms)
        const durMatch = text.match(/(\d+)\s+ms/);

        // 4. SQL (Pega a partir de 'Statement ...' até o fim ou até estatísticas)
        const sqlMatch = text.match(/Statement\s+\d+:[\s\S]*/i);

        // 5. USUÁRIO e IP (Padrão: SYSDBA:NONE, NONE, TCPv4:192.168.0.173)
        // Tentamos pegar o IP especificamente
        const ipMatch = text.match(/TCPv4:([\d\.]+)/);
        // Tentamos pegar o usuário antes dos dois pontos
        const userMatch = text.match(/\(ATT_\d+,\s*([^:]+)/);

        if (durMatch && sqlMatch) {
            const dataEvento = dateMatch ? new Date(dateMatch[1]) : new Date();
            const transacaoId = txMatch ? txMatch[1] : 0;
            const duracao = parseInt(durMatch[1]);
            const sql = text; // Salva o texto COMPLETO (incluindo plano e stats) pois é rico em info
            const usuario = userMatch ? userMatch[1] : 'Unknown';
            const ip = ipMatch ? ipMatch[1] : 'Unknown';

            const query = `
                INSERT INTO fb_slow_log 
                (data_evento, transacao_id, duracao_ms, sql_text, usuario, ip_origem) 
                VALUES (?, ?, ?, ?, ?, ?)
            `;

            await pool.execute(query, [dataEvento, transacaoId, duracao, sql, usuario, ip]);
            console.log(`Log salvo: TX ${transacaoId} (${duracao}ms) - IP ${ip}`);
        }
    } catch (e) {
        console.error("Erro processando bloco:", e.message);
    }
}

startBridge();