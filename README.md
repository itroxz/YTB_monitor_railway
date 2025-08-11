# YouTube Monitor - Docker

Projeto para monitorar visualizações de lives do YouTube com Puppeteer, salvando métricas no Supabase. Esta versão roda apenas com Docker (sem Railway).

## Variáveis de Ambiente

Defina via `.env` ou direto no comando `docker run`:

Obrigatórias:
```
SUPABASE_URL=...
SUPABASE_KEY=...
```

Opcionais (defaults):
```
NODE_ENV=production
LOOP_INTERVAL_MS=40000
TIMEOUT_MS=60000
MAX_FAILS=2
BLOCK_OFFLINE_MS=600000
MAX_CONCURRENCY=3
RETRY_LIMIT=2
MAX_BATCH_SIZE=50
MAX_BATCH_BUFFER=200
CACHE_TTL_MS=30000
MIN_UPDATE_INTERVAL_MS=30000
VIEWERS_CHANGE_THRESHOLD=0
PORT=3000
```

## Como rodar com Docker

Build da imagem:
```bash
docker build -t yt-monitor .
```

Executar o container (Linux/Mac/WSL):
```bash
docker run --rm -p 3000:3000 \
	-e SUPABASE_URL=... \
	-e SUPABASE_KEY=... \
	-e NODE_ENV=production \
	yt-monitor
```

Executar o container (Windows PowerShell):
```powershell
docker run --rm -p 3000:3000 `
	-e SUPABASE_URL=... `
	-e SUPABASE_KEY=... `
	-e NODE_ENV=production `
	yt-monitor
```

Endpoints:
- GET http://localhost:3000/health
- GET http://localhost:3000/status

## Estrutura do Projeto

```
YTB_Live/
├── Dockerfile
├── package.json
├── app.js                # entrypoint (carrega youtube-railway.js)
├── youtube-railway.js    # implementação (genérica p/ Docker)
├── youtube.5.js          # versão original
├── .env.example
└── README.md
```

## Notas
- O Dockerfile instala o Chromium do sistema e configura o Puppeteer para usá-lo.
- Se precisar ajustar concorrência, aumente/diminua `MAX_CONCURRENCY` conforme recursos.
- Logs em produção são estruturados em JSON.
