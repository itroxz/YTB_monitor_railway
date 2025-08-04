# Railway Dockerfile otimizado para Puppeteer
FROM node:18-slim

# Instalar dependências do sistema necessárias para Puppeteer
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Configurar Puppeteer para usar o Chromium instalado
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copiar package files primeiro para melhor cache
COPY package*.json ./

# Instalar dependências
RUN npm ci --only=production --silent

# Copiar código da aplicação
COPY . .

# Criar usuário não-root para executar o Puppeteer
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app

USER pptruser

EXPOSE 3000

CMD ["npm", "start"]
