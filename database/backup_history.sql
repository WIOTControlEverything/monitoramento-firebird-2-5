USE monitor_firebird;

CREATE TABLE IF NOT EXISTS backup_history (
                                              id INT AUTO_INCREMENT PRIMARY KEY,
                                              data_evento DATETIME DEFAULT CURRENT_TIMESTAMP,
                                              status VARCHAR(20),      -- Ex: 'INICIADO', 'SUCESSO', 'ERRO'
    etapa VARCHAR(50),       -- Ex: 'BACKUP_LOCAL', 'UPLOAD', 'RESTORE'
    tamanho_arquivo VARCHAR(20),
    mensagem TEXT,
    duracao_segundos INT DEFAULT 0
    );

-- Índice para o Grafana filtrar rápido por data
CREATE INDEX idx_backup_data ON backup_history(data_evento);