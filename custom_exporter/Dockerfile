FROM node:18-slim

# 1. Instala dependências do sistema necessárias para o Node e para o Cliente Firebird
RUN apt-get update && apt-get install -y \
    curl \
    libncurses5 \
    libtommath1 \
    libfbclient2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp

# 2. BAIXA O FIREBIRD 3.0 (Para rodar no Linux Novo, mas conecta no 2.5)
# Usamos curl para garantir que o arquivo venha
RUN curl -L -o firebird.tar.gz https://github.com/FirebirdSQL/firebird/releases/download/v3.0.10/Firebird-3.0.10.33601-0.amd64.tar.gz \
    && tar -xzf firebird.tar.gz \
    && cd Firebird-3.0.10.33601-0.amd64 \
    && tar -xzf buildroot.tar.gz \
    # 3. Extrai o fbtracemgr e coloca na pasta binária do sistema
    && cp opt/firebird/bin/fbtracemgr /usr/bin/fbtracemgr \
    && chmod +x /usr/bin/fbtracemgr \
    # Limpeza do lixo de instalação
    && cd /tmp \
    && rm -rf /tmp/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 9399

CMD ["node", "index.js"]