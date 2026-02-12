# Baixar (versão compatível com a maioria dos Linux)
```
wget https://github.com/prometheus/node_exporter/releases/download/v1.7.0/node_exporter-1.7.0.linux-amd64.tar.gz
```

# Descompactar
```
tar xvfz node_exporter-1.7.0.linux-amd64.tar.gz
```

# Mover o binário para /usr/local/bin
```
sudo mv node_exporter-1.7.0.linux-amd64/node_exporter /usr/local/bin/
```

# Criar um usuário de sistema para rodar o serviço (segurança)
```
sudo useradd -rs /bin/false node_exporter
```

# Criar o diretório de métricas e passar as permissões
```
sudo mkdir -p /var/lib/node_exporter/textfile_collector
sudo chown -R latitude:latitude /var/lib/node_exporter # Ajuste para seu usuario
```

# Criar o script de coleta de dados do samba
```aiexclude
nano /usr/local/bin/samba_monitor.sh
```
```aiexclude
#!/bin/bash
TEXTFILE_COLLECTOR_DIR=/var/lib/node_exporter/textfile_collector

# 1. Conta conexões TCP estabelecidas na porta 445 (Samba direto)
SMB_CONNS=$(ss -tn state established sport = :445 | wc -l)
# Ajuste: o comando acima conta o cabeçalho, então subtrai 1. Se der 0, mantém 0.
if [ "$SMB_CONNS" -gt 0 ]; then SMB_CONNS=$((SMB_CONNS-1)); fi

# 2. Conta processos smbd ativos (Carga de CPU/Memória do Samba)
SMB_PROCS=$(pgrep -c smbd)

# Escreve no formato Prometheus
echo "# HELP samba_connected_clients Total de clientes conectados na porta 445 (SMB)" > "$TEXTFILE_COLLECTOR_DIR/samba.prom.$$"
echo "# TYPE samba_connected_clients gauge" >> "$TEXTFILE_COLLECTOR_DIR/samba.prom.$$"
echo "samba_connected_clients $SMB_CONNS" >> "$TEXTFILE_COLLECTOR_DIR/samba.prom.$$"

echo "# HELP samba_active_processes Total de processos smbd rodando" >> "$TEXTFILE_COLLECTOR_DIR/samba.prom.$$"
echo "# TYPE samba_active_processes gauge" >> "$TEXTFILE_COLLECTOR_DIR/samba.prom.$$"
echo "samba_active_processes $SMB_PROCS" >> "$TEXTFILE_COLLECTOR_DIR/samba.prom.$$"

# Move atomicamente para evitar leitura incompleta
mv "$TEXTFILE_COLLECTOR_DIR/samba.prom.$$" "$TEXTFILE_COLLECTOR_DIR/samba.prom"
```

# Permissões e teste
```aiexclude
chmod +x /usr/local/bin/samba_monitor.sh
/usr/local/bin/samba_monitor.sh
cat /var/lib/node_exporter/textfile_collector/samba.prom
```

# Adicionar ao contrab para codar a cada minuto
```aiexclude
crontab -e
```
```aiexclude
* * * * * /usr/local/bin/samba_monitor.sh
```

# Criar o serviço de inicialização (Systemd)
```
sudo nano /etc/systemd/system/node_exporter.service
```

```
[Unit]
Description=Node Exporter
After=network.target

[Service]
User=node_exporter
Group=node_exporter
Type=simple
ExecStart=/usr/local/bin/node_exporter \
  --collector.textfile.directory=/var/lib/node_exporter/textfile_collector \

[Install]
WantedBy=multi-user.target
```

# Comandos para iniciar o serviço e habilitar
```aiexclude
sudo systemctl daemon-reload
sudo systemctl start node_exporter
sudo systemctl enable node_exporter
```

# Para importar uma dash em Português (ruim) para apresentar os dados do node_exporter uso o id
```aiexclude
21180
```

# ou em inglês (melhor)
```aiexclude
1860
```