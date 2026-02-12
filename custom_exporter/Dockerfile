FROM node:18-slim

# Instala utilitários do Firebird (necessário para o fbtracemgr)
RUN apt-get update && apt-get install -y \
    firebird3.0-utils \
    libfbclient2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

# Copia todos os scripts (index.js, bridge_logger.js, configs)
COPY . .

EXPOSE 9399

CMD ["node", "index.js"]