# YouTube Monitor - Railway Deployment

## 🚀 Deploy no Railway

### 1. Preparação do Repositório

```bash
git init
git add .
git commit -m "Initial commit - YouTube Monitor for Railway"
```

### 2. Configuração no Railway

1. **Conecte seu repositório** ao Railway
2. **Configure as variáveis de ambiente** necessárias:

#### Variáveis Obrigatórias:
```bash
SUPABASE_URL=https://ohgotjdtfssacuscaums.supabase.co
SUPABASE_KEY=your_supabase_key_here
NODE_ENV=production
```

#### Variáveis Opcionais (com valores padrão):
```bash
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
```

### 3. Estrutura do Projeto

```
YTB_Live/
├── package.json          # Dependências e scripts
├── youtube-railway.js    # Versão otimizada para Railway
├── youtube.5.js         # Versão original (local)
└── README.md            # Este arquivo
```

## 🔧 Principais Otimizações para Railway

### 1. **Remoção de Dependências Locais**
- ❌ Caminho hardcoded do Chrome Windows removido
- ✅ Usa o Chrome incluído no Railway
- ❌ `portfinder` removido (Railway define PORT automaticamente)

### 2. **Configuração via Environment Variables**
- ✅ Todas as configurações via `process.env`
- ✅ Valores padrão seguros para Railway
- ✅ Detecção automática do ambiente Railway

### 3. **Logs Estruturados**
- ✅ JSON logs em produção para melhor observabilidade
- ✅ Logs legíveis em desenvolvimento
- ✅ Níveis de log apropriados (info, warn, error, debug)

### 4. **Otimizações de Performance**
- ✅ `MAX_CONCURRENCY` reduzida para 3 (melhor para Railway)
- ✅ Argumentos do Puppeteer otimizados para containers
- ✅ `--disable-dev-shm-usage` para evitar problemas de memória

### 5. **Health Checks Melhorados**
- ✅ Endpoint `/health` com informações detalhadas
- ✅ Endpoint `/status` para monitoramento do serviço
- ✅ Graceful shutdown com SIGTERM/SIGINT

### 6. **Remoção de Features Problemáticas**
- ❌ Screenshots de debug removidos (consumo de disco)
- ❌ Arquivos temporários removidos
- ✅ Apenas logs para debugging

## 🚀 Como Fazer Deploy

### Método 1: Railway CLI
```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login no Railway
railway login

# Criar novo projeto
railway new

# Deploy
railway up
```

### Método 2: GitHub Integration
1. Faça push do código para um repositório GitHub
2. Conecte o repositório no Railway Dashboard
3. Configure as variáveis de ambiente
4. Deploy automático será iniciado

## 📊 Monitoramento

### Endpoints Disponíveis:
- `GET /health` - Health check básico
- `GET /status` - Status detalhado do monitor

### Logs Importantes:
```bash
# Ver logs em tempo real
railway logs --follow

# Filtrar por nível
railway logs --follow | grep "ERROR"
```

## 🔧 Configurações Recomendadas

### Para Railway:
- **Memória**: 512MB-1GB
- **CPU**: 0.5-1 vCPU
- **Timeout**: 300s
- **Health Check**: `GET /health`

### Variáveis de Ambiente Recomendadas:
```bash
NODE_ENV=production
MAX_CONCURRENCY=3
LOOP_INTERVAL_MS=45000
TIMEOUT_MS=45000
```

## 🐛 Troubleshooting

### Problema: "Chrome não encontrado"
**Solução**: Remova qualquer configuração de `CHROME_PATH`. O Railway já inclui o Chrome.

### Problema: "Porta em uso"
**Solução**: Use `process.env.PORT` (já configurado na versão Railway).

### Problema: "Memória insuficiente"
**Solução**: Reduza `MAX_CONCURRENCY` para 2 ou menos.

### Problema: "Timeouts frequentes"
**Solução**: Aumente `TIMEOUT_MS` e `LOOP_INTERVAL_MS`.

## 📝 Diferenças da Versão Original

| Feature | Original | Railway |
|---------|----------|---------|
| Chrome Path | Hardcoded Windows | Auto-detectado |
| Port Management | portfinder | process.env.PORT |
| Logs | Console simples | JSON estruturado |
| Screenshots | Habilitado | Removido |
| Concurrency | 5 | 3 |
| Health Check | Básico | Detalhado |
| Environment | Local | Configurável |

## 🚀 Próximos Passos

1. ✅ Fazer deploy no Railway
2. ✅ Configurar variáveis de ambiente
3. ✅ Monitorar logs para verificar funcionamento
4. ✅ Ajustar `MAX_CONCURRENCY` se necessário
5. ✅ Configurar alertas baseados nos endpoints de health

## 📞 Suporte

Se encontrar problemas:
1. Verifique os logs: `railway logs --follow`
2. Teste o health check: `curl https://your-app.railway.app/health`
3. Verifique as variáveis de ambiente no Railway Dashboard
