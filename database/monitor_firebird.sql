CREATE
DATABASE IF NOT EXISTS monitor_firebird;
USE
monitor_firebird;

CREATE TABLE IF NOT EXISTS fb_slow_log
(
    id           BIGINT AUTO_INCREMENT PRIMARY KEY,
    data_evento  DATETIME,
    transacao_id BIGINT,
    usuario      VARCHAR(100),
    ip_origem    VARCHAR(50),
    duracao_ms   INT,
    sql_text     TEXT,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para o Grafana filtrar rápido
CREATE INDEX idx_data ON fb_slow_log (data_evento);
CREATE INDEX idx_duracao ON fb_slow_log (duracao_ms);