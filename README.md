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
PORT=3010
## CORS (opcional)
## CORS_ORIGIN=*                          # ou lista: https://site1.com,https://app.site2.com
## CORS_CREDENTIALS=false                 # true para permitir cookies/credenciais
## CORS_METHODS=GET,POST,OPTIONS
## CORS_HEADERS=Content-Type, Authorization, X-Requested-With
## CORS_MAX_AGE=600
```

## Como rodar com Docker

Build da imagem:
```bash
docker build -t yt-monitor .
```

Executar o container (Linux/Mac/WSL):
```bash
docker run --rm -p 3010:3010 \
	-e SUPABASE_URL=... \
	-e SUPABASE_KEY=... \
	-e NODE_ENV=production \
	yt-monitor
```

Executar o container (Windows PowerShell):
```powershell
docker run --rm -p 3010:3010 `
	-e SUPABASE_URL=... `
	-e SUPABASE_KEY=... `
	-e NODE_ENV=production `
	yt-monitor
```

## API

Base URL: http://localhost:3010

Auth (opcional): defina CONTROL_TOKEN e envie como:
- Header: `Authorization: Bearer <token>`
- Ou `?token=<token>` na query/body

Endpoints
- GET /health
	- 200
	- Exemplo:
```json
{
	"status": "OK",
	"timestamp": "2025-08-12T12:34:56.789Z",
	"environment": "production",
	"isRailway": false,
	"uptime": 123.45
}
```

- GET /status
	- 200
	- Exemplo:
```json
{
	"status": "running",
	"userCount": 3,
	"users": ["UCxxxx", "UCyyyy", "UCzzzz"],
	"timestamp": "2025-08-12T12:34:56.789Z"
}
```

- GET /control/status
	- 200
	- Exemplo:
```json
{
	"state": "running",
	"running": true,
	"lastError": null,
	"lastUserCount": 3,
	"timestamp": "2025-08-12T12:34:56.789Z"
}
```

- POST /control/start
	- 200: `{ "status": "started" }` ou `{ "status": "already running" }`
	- 500 em erro

- POST /control/stop
	- 200: `{ "status": "stopped" }` ou `{ "status": "already stopped" }`
	- 500 em erro

- POST /control/restart (alias: /control/reset)
	- 200: `{ "status": "restarted" }`
	- 500 em erro

Erros comuns
- 401 Unauthorized quando `CONTROL_TOKEN` estiver configurado e não for enviado/for inválido.

Exemplos (PowerShell)
```powershell
# Health
curl http://localhost:3010/health

# Status do monitor
curl http://localhost:3010/control/status

# Start/Stop/Restart
curl -Method POST http://localhost:3010/control/start
curl -Method POST http://localhost:3010/control/stop
curl -Method POST http://localhost:3010/control/restart

# Com token
curl -Headers @{ Authorization = 'Bearer <TOKEN>' } http://localhost:3010/control/status
```

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
