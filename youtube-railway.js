/************************************************************
 *           YOUTUBE MONITOR FOR RAILWAY (v2.6.2)          *
 *      Versão otimizada para deployment no Railway         *
 *      - Removido caminho hardcoded do Chrome              *
 *      - Configurações de ambiente via variáveis           *
 *      - Otimizações para ambiente containerizado          *
 *      - Health check simplificado                         *
 *      - Logs estruturados                                 *
 ************************************************************/

const { Cluster } = require('puppeteer-cluster');
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

// -------------------------------------------------------------------
// Configurações via Environment Variables
// -------------------------------------------------------------------
const supabaseUrl = process.env.SUPABASE_URL || 'https://ohgotjdtfssacuscaums.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oZ290amR0ZnNzYWN1c2NhdW1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzY1NTE3NzcsImV4cCI6MjA1MjEyNzc3N30.X0cG-usHl9r649oPT6XL1xhis3CLd3gnM70KMWqWMsU';
const supabase = createClient(supabaseUrl, supabaseKey);

// Configurações otimizadas para Railway
const WAIT_BETWEEN_FULL_LOOP_MS = parseInt(process.env.LOOP_INTERVAL_MS) || 40000;
const TIMEOUT_GOTO_MS = parseInt(process.env.TIMEOUT_MS) || 60000;
const MAX_FAILS = parseInt(process.env.MAX_FAILS) || 2;
const BLOCK_OFFLINE_MS = parseInt(process.env.BLOCK_OFFLINE_MS) || (10 * 60_000);
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY) || 3; // Reduzido para Railway
const RETRY_LIMIT = parseInt(process.env.RETRY_LIMIT) || 2;
const MAX_BATCH_SIZE = parseInt(process.env.MAX_BATCH_SIZE) || 50;
const MAX_BATCH_BUFFER = parseInt(process.env.MAX_BATCH_BUFFER) || 200;
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS) || (30 * 1000);
const PORT = parseInt(process.env.PORT) || 3010; // Default port
const HOST = process.env.HOST || '0.0.0.0'; // Bind to all interfaces for external access
const MIN_UPDATE_INTERVAL_MS = parseInt(process.env.MIN_UPDATE_INTERVAL_MS) || (30 * 1000);
const VIEWERS_CHANGE_THRESHOLD = parseFloat(process.env.VIEWERS_CHANGE_THRESHOLD) || 0;

// Ambiente
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Monitor lifecycle state
const monitor = {
  state: 'stopped', // 'stopped' | 'starting' | 'running' | 'stopping'
  stopRequested: false,
  cluster: null,
  loopPromise: null,
  usersRefreshInterval: null,
  lastError: null,
  lastUserCount: 0,
  // observability
  startCount: 0,
  stopCount: 0,
  restartCount: 0,
  lastStartAt: null,
  lastStopAt: null,
  lastRestartAt: null,
};

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    ...data
  };
  
  if (IS_PRODUCTION) {
    console.log(JSON.stringify(logEntry));
  } else {
    console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}`, data);
  }
}

function isVideoId(userId) {
  return /^[A-Za-z0-9_-]{11}$/.test(userId) && !/^[a-z]+$/.test(userId);
}

/************************************************************
 * Otimizado para Railway: sem screenshots de debug        *
 ************************************************************/
async function getViewersText(page) {
  for (let i = 0; i < 5; i++) {
    try {
      const result = await page.evaluate(() => {
        const el = document.querySelector('.view-count');
        if (el) {
          const text1 = el.innerText?.trim() || '';
          if (text1) return text1;
          const aria = el.getAttribute('aria-label');
          if (aria) return aria.trim();
        }
        return null;
      });

      if (result) return result;
      await new Promise((r) => setTimeout(r, 1000));
    } catch (error) {
      log('warn', `Erro ao extrair visualizadores (tentativa ${i + 1})`, { error: error.message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

/************************************************************
 *     1. Funções de persistência no Supabase               *
 ************************************************************/
const lastUpdateTimes = {};

async function savePeakToSupabase(userId, lastViewers) {
  try {
    const viewers = parseInt(lastViewers, 10) || 0;
    let currentMaxPeak = 0;

    // Busca o max_peak atual
    const { data: currentData, error: fetchError } = await supabase
      .from('user_peaks')
      .select('max_peak')
      .eq('user_id', userId)
      .eq('platform', 'youtube')
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      log('error', `Erro ao buscar max_peak para ${userId}`, { error: fetchError });
      return;
    }
    if (currentData) {
      currentMaxPeak = currentData.max_peak || 0;
    }

    const newMaxPeak = Math.max(currentMaxPeak, viewers);

    // Salva ou atualiza
    const { error } = await supabase
      .from('user_peaks')
      .upsert(
        {
          user_id: userId,
          platform: 'youtube',
          max_peak: newMaxPeak,
          last_viewers: viewers,
        },
        { onConflict: ['user_id', 'platform'] }
      );

    if (error) {
      log('error', `Erro ao salvar pico para ${userId}`, { error });
      return;
    }
    log('info', `Pico salvo`, { userId, viewers, newMaxPeak });
  } catch (err) {
    log('error', `Exceção em savePeakToSupabase para ${userId}`, { error: err.message });
  }
}

const historicalBatch = [];
let isFlushingHistorical = false;
async function flushHistoricalBatch() {
  if (isFlushingHistorical) return;
  if (historicalBatch.length === 0) return;

  isFlushingHistorical = true;
  try {
    while (historicalBatch.length > 0) {
      const batchToInsert = historicalBatch.slice(0, MAX_BATCH_SIZE);
      historicalBatch.splice(0, batchToInsert.length);

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const { error } = await supabase
            .from('historical_data')
            .insert(batchToInsert);

          if (error) {
            log('error', `Erro ao inserir batch (tentativa ${attempt})`, { error, batchSize: batchToInsert.length });
            if (attempt === 2) {
              log('error', 'Falha final ao inserir batch', { batchToInsert });
            } else {
              await new Promise((r) => setTimeout(r, 1000));
              continue;
            }
          } else {
            log('info', `Batch inserido com sucesso`, { recordCount: batchToInsert.length });
            break;
          }
        } catch (err) {
          log('error', `Exceção no flushHistoricalBatch (tentativa ${attempt})`, { error: err.message });
          if (attempt === 2) {
            log('error', 'Falha final no batch', { batchToInsert });
          }
        }
      }
    }

    if (historicalBatch.length > MAX_BATCH_BUFFER) {
      log('warn', `Buffer histórico muito grande, limpando registros antigos`, {
        currentSize: historicalBatch.length,
        maxBuffer: MAX_BATCH_BUFFER
      });
      historicalBatch.splice(0, historicalBatch.length - MAX_BATCH_BUFFER);
    }
  } finally {
    isFlushingHistorical = false;
  }
}

// Otimiza rede do puppeteer para reduzir consumo sem afetar scraping
async function optimizePageNetwork(page) {
  try {
    // Define timeouts por página
    if (typeof page.setDefaultNavigationTimeout === 'function') {
      page.setDefaultNavigationTimeout(TIMEOUT_GOTO_MS);
    }
    if (typeof page.setDefaultTimeout === 'function') {
      page.setDefaultTimeout(TIMEOUT_GOTO_MS);
    }

    // Evita duplicar listeners
    if (page._networkOptimized) return;
    page._networkOptimized = true;

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      // Bloqueia recursos pesados que não impactam o texto renderizado
      if (type === 'image' || type === 'media' || type === 'font' || type === 'websocket') {
        return req.abort();
      }
      return req.continue();
    });
  } catch (err) {
    log('warn', 'Falha ao otimizar rede da página', { error: err.message });
  }
}

/************************************************************
 *  2. Buscar e tratar lista de usuários do Supabase        *
 ************************************************************/
let cachedUsers = null;
let cacheTimestamp = 0;

async function fetchUsersFromSupabase() {
  if (cachedUsers && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    log('debug', 'Retornando usuários do cache', { userCount: cachedUsers.length });
    return cachedUsers;
  }

  try {
    const { data, error } = await supabase
      .from('user_peaks')
      .select('user_id')
      .eq('platform', 'youtube')
      .eq('hidden', false);

    if (error) {
      log('error', 'Erro ao buscar usuários do Supabase', { error });
      return cachedUsers || [];
    }

    cachedUsers = data.map((user) => user.user_id);
    cacheTimestamp = Date.now();
    log('info', 'Usuários atualizados do Supabase', { userCount: cachedUsers.length, users: cachedUsers });
    return cachedUsers;
  } catch (err) {
    log('error', 'Exceção ao buscar usuários do Supabase', { error: err.message });
    return cachedUsers || [];
  }
}

const { parseViewers } = require('./parse-viewers');

/************************************************************
 *  4. processChannel: suporta lives diretas e canais       *
 ************************************************************/
async function processChannel({
  page,
  data: userId,
  waitTimes,
  lastViewers,
  failCounts,
}) {
  const isLive = isVideoId(userId);
  const type = isLive ? 'live' : 'channel';
  const stateKey = `${type}:${userId}`;
  const targetUrl = isLive
    ? `https://www.youtube.com/watch?v=${userId}`
    : `https://www.youtube.com/@${userId}/live`;

  if (waitTimes[stateKey] && waitTimes[stateKey] > Date.now()) {
    log('debug', `Pulando verificação`, { 
      stateKey, 
      waitUntil: new Date(waitTimes[stateKey]).toISOString() 
    });
    return;
  }

  let successGoto = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log('debug', `Navegando para URL`, { attempt, targetUrl, type });
      await page.goto(targetUrl, {
        waitUntil: 'networkidle2',
        timeout: TIMEOUT_GOTO_MS,
      });
      successGoto = true;
      break;
    } catch (err) {
      log('warn', `Falha na navegação`, { 
        attempt, 
        targetUrl, 
        error: err.message 
      });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!successGoto) {
    failCounts[stateKey] = (failCounts[stateKey] || 0) + 1;
    log('error', `Não foi possível carregar URL após 2 tentativas`, { 
      targetUrl, 
      failCount: failCounts[stateKey] 
    });
    
    if (failCounts[stateKey] >= MAX_FAILS) {
      const timestamp = new Date().toISOString();
      log('info', `Interpretando como offline (goto)`, { stateKey });
      
      historicalBatch.push({
        user_id: userId,
        timestamp: timestamp,
        viewers: 0,
      });
      
      if (historicalBatch.length >= MAX_BATCH_SIZE) {
        await flushHistoricalBatch();
      }

      await savePeakToSupabase(userId, 0);
      waitTimes[stateKey] = Date.now() + BLOCK_OFFLINE_MS;
      failCounts[stateKey] = 0;
      lastUpdateTimes[userId] = Date.now();
    }
    return;
  }

  const timestamp = new Date().toISOString();
  try {
    const viewersHTML = await getViewersText(page);
    if (viewersHTML) {
      failCounts[stateKey] = 0;
      const viewers = parseViewers(viewersHTML);
      log('info', `Visualizadores extraídos`, { stateKey, viewers, rawHTML: viewersHTML });

      const previousViewers = lastViewers[stateKey] || 0;
      const lastUpdate = lastUpdateTimes[userId] || 0;
      const timeSinceLastUpdate = Date.now() - lastUpdate;
      const viewersChangedSignificantly =
        previousViewers === 0 ||
        viewers === 0 ||
        Math.abs(viewers - previousViewers) / (previousViewers || 1) >= VIEWERS_CHANGE_THRESHOLD;

      if (viewersChangedSignificantly || timeSinceLastUpdate >= MIN_UPDATE_INTERVAL_MS) {
        lastViewers[stateKey] = viewers;
        historicalBatch.push({
          user_id: userId,
          timestamp: timestamp,
          viewers: viewers,
        });
        
        if (historicalBatch.length >= MAX_BATCH_SIZE) {
          await flushHistoricalBatch();
        }

        await savePeakToSupabase(userId, viewers);
        lastUpdateTimes[userId] = Date.now();
      }
    } else {
      failCounts[stateKey] = (failCounts[stateKey] || 0) + 1;
      log('warn', `.view-count não encontrado`, { 
        stateKey, 
        failCount: failCounts[stateKey] 
      });
      
      if (failCounts[stateKey] >= MAX_FAILS) {
        log('info', `Interpretando como offline após ${MAX_FAILS} falhas`, { stateKey });
        
        historicalBatch.push({
          user_id: userId,
          timestamp: timestamp,
          viewers: 0,
        });
        
        if (historicalBatch.length >= MAX_BATCH_SIZE) {
          await flushHistoricalBatch();
        }
        
        await savePeakToSupabase(userId, 0);
        waitTimes[stateKey] = Date.now() + BLOCK_OFFLINE_MS;
        failCounts[stateKey] = 0;
        lastUpdateTimes[userId] = Date.now();
      }
    }
  } catch (error) {
    failCounts[stateKey] = (failCounts[stateKey] || 0) + 1;
    log('error', `Erro ao processar canal/live`, { 
      stateKey, 
      error: error.message, 
      failCount: failCounts[stateKey] 
    });
    
    if (failCounts[stateKey] >= MAX_FAILS) {
      log('info', `Interpretando como offline (exceção)`, { stateKey });
      
      historicalBatch.push({
        user_id: userId,
        timestamp: timestamp,
        viewers: 0,
      });
      
      if (historicalBatch.length >= MAX_BATCH_SIZE) {
        await flushHistoricalBatch();
      }
      
      await savePeakToSupabase(userId, 0);
      waitTimes[stateKey] = Date.now() + BLOCK_OFFLINE_MS;
      failCounts[stateKey] = 0;
      lastUpdateTimes[userId] = Date.now();
    }
  }

  await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
}

/************************************************************
 *  5. Função principal do cluster + loop                   *
 ************************************************************/
async function runClusterMonitor(monitorRef) {
  let userIds = await fetchUsersFromSupabase();
  if (userIds.length === 0) {
    throw new Error('Nenhum alvo encontrado para monitorar.');
  }

  const lastViewers = {};
  const waitTimes = {};
  const failCounts = {};

  // Configurações otimizadas para Railway
  const puppeteerOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage', // Importante para Railway
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
    ],
  };

  // Permite override do path do Chrome via env quando necessário
  if (process.env.CHROME_PATH) {
    puppeteerOptions.executablePath = process.env.CHROME_PATH;
  }

  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_PAGE,
    maxConcurrency: MAX_CONCURRENCY,
    retryLimit: RETRY_LIMIT,
    puppeteerOptions,
    timeout: 3 * 60 * 1000,
  });

  monitorRef.cluster = cluster;
  monitorRef.state = 'running';

  cluster.on('taskerror', (err, data) => {
    log('error', `Erro na tarefa do cluster`, { userId: data, error: err.message });
  });

  cluster.task(async ({ page, data }) => {
  await optimizePageNetwork(page);
    await processChannel({
      page,
      data,
      waitTimes,
      lastViewers,
      failCounts,
    });
  });

  // Atualização periódica da lista de usuários
  if (monitorRef.usersRefreshInterval) clearInterval(monitorRef.usersRefreshInterval);
  monitorRef.usersRefreshInterval = setInterval(async () => {
    try {
      userIds = await fetchUsersFromSupabase();
      monitorRef.lastUserCount = userIds.length;
      log('info', 'Lista de alvos atualizada', { userCount: userIds.length });
    } catch (error) {
      log('error', 'Erro ao atualizar lista de alvos', { error: error.message });
    }
  }, 60_000);

  log('info', 'Monitor iniciado com sucesso', { 
    userCount: userIds.length,
    maxConcurrency: MAX_CONCURRENCY,
    loopInterval: WAIT_BETWEEN_FULL_LOOP_MS
  });

  while (!monitorRef.stopRequested) {
    for (const userId of userIds) {
      if (monitorRef.stopRequested) break;
      cluster.queue(userId);
    }
    await delay(WAIT_BETWEEN_FULL_LOOP_MS);
  }

  // Cleanup on stop
  try { if (monitorRef.usersRefreshInterval) clearInterval(monitorRef.usersRefreshInterval); } catch {}
  try { await cluster.idle(); } catch (e) { log('warn', 'Erro ao aguardar cluster idle', { error: e.message }); }
  try { await cluster.close(); } catch (e) { log('warn', 'Erro ao fechar cluster', { error: e.message }); }
  monitorRef.cluster = null;
  monitorRef.state = 'stopped';
}

/************************************************************
 *  6. Health Check + Start (Otimizado para Railway)        *
 ************************************************************/
async function start() {
  const app = express();
  
  // Middleware básico
  app.use(express.json());
  // Confiar em proxy (X-Forwarded-For) quando atrás de Nginx/Traefik
  app.set('trust proxy', 1);

  // CORS básico para acesso externo (pode ajustar via CORS_ORIGIN)
  app.use((req, res, next) => {
    const origin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
  isRailway: process.env.RAILWAY_ENVIRONMENT_NAME !== undefined,
      uptime: process.uptime()
    });
  });

  // Endpoint para verificar status do monitor
  app.get('/status', async (req, res) => {
    try {
      const userIds = await fetchUsersFromSupabase();
      res.status(200).json({
        status: 'running',
        userCount: userIds.length,
        users: userIds,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Inicia o servidor
  app.listen(PORT, HOST, () => {
    log('info', 'Servidor HTTP iniciado', { 
      port: PORT,
      host: HOST,
      healthEndpoint: `/health`,
      statusEndpoint: `/status`
    });
  });

  // Flush periódico para garantir persistência mesmo com baixo volume
  const periodicFlushMs = Math.max(15_000, Math.min(120_000, parseInt(process.env.FLUSH_INTERVAL_MS || '30000')));
  setInterval(() => {
    flushHistoricalBatch().catch((e) => log('error', 'Erro no flush periódico', { error: e.message }));
  }, periodicFlushMs);

  // Controle de autenticação opcional para endpoints de controle
  function authIfConfigured(req, res, next) {
    const token = process.env.CONTROL_TOKEN;
    if (!token) return next();
    const auth = req.headers['authorization'] || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || req.body?.token);
    if (provided === token) return next();
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Endpoints de controle
  app.get('/control/status', authIfConfigured, (req, res) => {
    res.json({
      state: monitor.state,
      running: monitor.state === 'running',
      lastError: monitor.lastError,
      lastUserCount: monitor.lastUserCount,
  startCount: monitor.startCount,
  stopCount: monitor.stopCount,
  restartCount: monitor.restartCount,
  lastStartAt: monitor.lastStartAt,
  lastStopAt: monitor.lastStopAt,
  lastRestartAt: monitor.lastRestartAt,
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/control/start', authIfConfigured, async (req, res) => {
    if (monitor.state === 'running' || monitor.state === 'starting') {
      return res.status(200).json({ status: 'already running' });
    }
    try {
      await monitorStart();
      return res.status(200).json({ status: 'started' });
    } catch (e) {
      return res.status(500).json({ status: 'error', error: e.message });
    }
  });

  app.post('/control/stop', authIfConfigured, async (req, res) => {
    if (monitor.state === 'stopped' || monitor.state === 'stopping') {
      return res.status(200).json({ status: 'already stopped' });
    }
    try {
      await monitorStop();
      return res.status(200).json({ status: 'stopped' });
    } catch (e) {
      return res.status(500).json({ status: 'error', error: e.message });
    }
  });

  // Reinicia o monitor (stop -> start). Alias: /control/reset
  async function doRestart() {
    try {
      await monitorStop();
    } catch (e) {
      // segue mesmo se falhar parada
      log('warn', 'Falha ao parar durante restart', { error: e.message });
    }
  await monitorStart();
  monitor.lastRestartAt = new Date().toISOString();
  monitor.restartCount += 1;
  log('info', 'Monitor restarted', { restartCount: monitor.restartCount });
  }

  app.post('/control/restart', authIfConfigured, async (req, res) => {
    try {
      await doRestart();
      return res.status(200).json({ 
        status: 'restarted',
        restartCount: monitor.restartCount,
        lastRestartAt: monitor.lastRestartAt,
        state: monitor.state
      });
    } catch (e) {
      return res.status(500).json({ status: 'error', error: e.message });
    }
  });

  app.post('/control/reset', authIfConfigured, async (req, res) => {
    try {
      await doRestart();
      return res.status(200).json({ 
        status: 'restarted',
        restartCount: monitor.restartCount,
        lastRestartAt: monitor.lastRestartAt,
        state: monitor.state
      });
    } catch (e) {
      return res.status(500).json({ status: 'error', error: e.message });
    }
  });

  // Auto-start para manter comportamento atual
  monitorStart().catch((e) => {
    monitor.lastError = e.message;
    log('error', 'Falha ao iniciar monitor automaticamente', { error: e.message });
  });
}

// Tratamento de erros global
process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled Rejection', { reason: reason?.message || reason });
});

process.on('uncaughtException', (error) => {
  log('error', 'Uncaught Exception', { error: error.message });
  process.exit(1);
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  try {
    log('info', `${signal} recebido, iniciando shutdown gracioso`);
    await flushHistoricalBatch();
  } catch (e) {
    log('warn', 'Erro durante shutdown gracioso', { error: e.message });
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});

start();

// Gerenciador: iniciar/parar
async function monitorStart() {
  if (monitor.state === 'running' || monitor.state === 'starting') return;
  monitor.state = 'starting';
  monitor.stopRequested = false;
  monitor.lastError = null;
  monitor.lastStartAt = new Date().toISOString();
  monitor.startCount += 1;
  log('info', 'Monitor starting', { startCount: monitor.startCount });
  monitor.loopPromise = (async () => {
    while (!monitor.stopRequested) {
      try {
        await runClusterMonitor(monitor);
        if (monitor.stopRequested) break;
        // Se saiu sem stop, é porque houve uma conclusão inesperada
        await delay(5_000);
      } catch (error) {
        monitor.lastError = error?.message || String(error);
        if (monitor.stopRequested) break;
        log('error', 'Erro no monitor principal, reiniciando em 40s', { error: monitor.lastError });
        await delay(40_000);
      }
    }
  })();
}

async function monitorStop() {
  if (monitor.state === 'stopped' || monitor.state === 'stopping') return;
  monitor.state = 'stopping';
  monitor.stopRequested = true;
  monitor.lastStopAt = new Date().toISOString();
  monitor.stopCount += 1;
  log('info', 'Monitor stopping', { stopCount: monitor.stopCount });
  try {
    await monitor.loopPromise;
  } catch (e) {
    log('warn', 'Erro ao aguardar loop principal encerrar', { error: e.message });
  }
  try {
    await flushHistoricalBatch();
  } catch (e) {
    log('warn', 'Erro ao flush na parada', { error: e.message });
  }
  monitor.state = 'stopped';
  log('info', 'Monitor stopped');
}
