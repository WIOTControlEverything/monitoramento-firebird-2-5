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
ExecStart=/usr/local/bin/node_exporter

[Install]
WantedBy=multi-user.target
```

# Comandos para iniciar o serviço e habilitar
```aiexclude
sudo systemctl daemon-reload
sudo systemctl start node_exporter
sudo systemctl enable node_exporter
```