/************************************************************
 *                 YOUTUBE MONITOR (v2.6.2)                 *
 *      Suporte a lives diretas (watch?v=ID) e canais       *
 *      Otimizações nas requisições ao Supabase             *
 *      Filtra alvos com hidden = TRUE                      *
 *      Redução de chamadas REST                            *
 *      Correção para porta em uso (EADDRINUSE)             *
 *      Removida dependência do update_peak (usa SELECT+UPSERT) *
 ************************************************************/

const { Cluster } = require('puppeteer-cluster');
const puppeteer = require('puppeteer');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const portfinder = require('portfinder');

// -------------------------------------------------------------------
// Configurações
// -------------------------------------------------------------------
const supabaseUrl = 'https://ohgotjdtfssacuscaums.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9oZ290amR0ZnNzYWN1c2NhdW1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzY1NTE3NzcsImV4cCI6MjA1MjEyNzc3N30.X0cG-usHl9r649oPT6XL1xhis3CLd3gnM70KMWqWMsU';
const supabase = createClient(supabaseUrl, supabaseKey);

const WAIT_BETWEEN_FULL_LOOP_MS = 40000;
const TIMEOUT_GOTO_MS = 60000;
const MAX_FAILS = 2;
const BLOCK_OFFLINE_MS = 10 * 60_000;
const MAX_CONCURRENCY = 5;
const RETRY_LIMIT = 2;
const MAX_BATCH_SIZE = 50;
const MAX_BATCH_BUFFER = 200;
const CACHE_TTL_MS = 30 * 1000; // Reduzido para 30 segundos para facilitar atualização rápida
const BASE_PORT = 3010;
const MIN_UPDATE_INTERVAL_MS = 30 * 1000; // Reduzido para 30 segundos para permitir atualizações mais frequentes
const VIEWERS_CHANGE_THRESHOLD = 0; // Considera qualquer alteração como válida

function isVideoId(userId) {
  return /^[A-Za-z0-9_-]{11}$/.test(userId) && !/^[a-z]+$/.test(userId);
}

/************************************************************
 * Ajuste para debug: Captura print e HTML da view-count   *
 ************************************************************/
async function getViewersText(page) {
  for (let i = 0; i < 5; i++) {
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

    const html = await page.evaluate(() => {
      const el = document.querySelector('.view-count');
      return el ? el.outerHTML : 'nada encontrado';
    });
    console.log(`HTML capturado: ${html}`);

    await page.screenshot({ path: `debug-${Date.now()}.png` });

    if (result) return result;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

/************************************************************
 *     1. Funções de persistência no Supabase               *
 ************************************************************/
const lastUpdateTimes = {};

async function savePeakToSupabase(userId, lastViewers) {
  try {
    const viewers = parseInt(lastViewers, 10) || 0; // Garante que seja um inteiro
    let currentMaxPeak = 0;

    // Busca o max_peak atual
    const { data: currentData, error: fetchError } = await supabase
      .from('user_peaks')
      .select('max_peak')
      .eq('user_id', userId)
      .eq('platform', 'youtube')
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error(`Erro ao buscar max_peak para ${userId}:`, fetchError);
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
      console.error(`Erro ao salvar pico para ${userId}:`, error);
      return;
    }
    console.log(`Pico para ${userId} salvo com sucesso. Visualizadores: ${viewers}`);
  } catch (err) {
    console.error(`Exceção em savePeakToSupabase para ${userId}:`, err);
  }
}

const historicalBatch = [];
async function flushHistoricalBatch() {
  if (historicalBatch.length === 0) return;

  const batchToInsert = historicalBatch.slice(0, MAX_BATCH_SIZE);
  historicalBatch.splice(0, batchToInsert.length);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { error } = await supabase
        .from('historical_data')
        .insert(batchToInsert);

      if (error) {
        console.error(`Erro ao inserir batch (tentativa ${attempt}):`, error);
        if (attempt === 2) {
          console.error(`Falha final ao inserir batch:`, batchToInsert);
        } else {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
      } else {
        console.log(`Inserido batch com ${batchToInsert.length} registros de histórico.`);
        break;
      }
    } catch (err) {
      console.error(`Exceção no flushHistoricalBatch (tentativa ${attempt}):`, err);
      if (attempt === 2) {
        console.error(`Falha final no batch:`, batchToInsert);
      }
    }
  }

  if (historicalBatch.length > MAX_BATCH_BUFFER) {
    console.warn(`Buffer histórico muito grande (${historicalBatch.length}). Limpando registros antigos.`);
    historicalBatch.splice(0, historicalBatch.length - MAX_BATCH_BUFFER);
  }
}

/************************************************************
 *  2. Buscar e tratar lista de usuários do Supabase        *
 ************************************************************/
let cachedUsers = null;
let cacheTimestamp = 0;

async function fetchUsersFromSupabase() {
  if (cachedUsers && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    console.log('Retornando usuários do cache:', cachedUsers.length);
    return cachedUsers;
  }

  try {
    const { data, error } = await supabase
      .from('user_peaks')
      .select('user_id')
      .eq('platform', 'youtube')
      .eq('hidden', false);

    if (error) {
      console.error('Erro ao buscar usuários do Supabase:', error);
      return cachedUsers || [];
    }

    cachedUsers = data.map((user) => user.user_id);
    cacheTimestamp = Date.now();
    console.log('Usuários atualizados do Supabase:', cachedUsers);
    return cachedUsers;
  } catch (err) {
    console.error('Exceção ao buscar usuários do Supabase:', err);
    return cachedUsers || [];
  }
}

/************************************************************
 *  3. Funções de scraping e fallback                       *
 ************************************************************/
async function getViewersText(page) {
  for (let i = 0; i < 5; i++) {
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
  }
  return null;
}

function parseViewers(viewersHTML) {
  const numericStr = viewersHTML.replace(/[^\d.,]/g, '');
  if (!numericStr) return 0;

  if (/mil/i.test(viewersHTML)) {
    const number = numericStr.replace('.', '').replace(',', '.');
    return Math.round(parseFloat(number) * 1000);
  } else {
    let temp = numericStr;
    if (temp.includes('.') && temp.includes(',')) {
      temp = temp.replace(/\./g, '').replace(',', '.');
    } else if (temp.includes('.') && !temp.includes(',')) {
      temp = temp.replace(/\./g, '');
    } else if (temp.includes(',') && !temp.includes('.')) {
      temp = temp.replace(',', '.');
    }
    return parseInt(temp, 10) || 0;
  }
}

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
    console.log(
      `Pulando verificação para ${stateKey} até ${new Date(waitTimes[stateKey]).toLocaleTimeString()}`
    );
    return;
  }

  let successGoto = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`(Goto attempt #${attempt}) -> ${targetUrl} (${type})`);
      await page.goto(targetUrl, {
        waitUntil: 'networkidle2',
        timeout: TIMEOUT_GOTO_MS,
      });
      successGoto = true;
      break;
    } catch (err) {
      console.error(`Goto falhou (tentativa ${attempt}) para ${targetUrl}:`, err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!successGoto) {
    failCounts[stateKey] = (failCounts[stateKey] || 0) + 1;
    console.log(`Não foi possível carregar ${targetUrl} após 2 tentativas. Falha #${failCounts[stateKey]}`);
    if (failCounts[stateKey] >= MAX_FAILS) {
      const timestamp = new Date().toISOString();
      console.log(`Interpretando ${stateKey} como offline (goto).`);
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
      console.log(`Visualizadores para ${stateKey}:`, viewers);

      const previousViewers = lastViewers[stateKey] || 0;
      const lastUpdate = lastUpdateTimes[userId] || 0;
      const timeSinceLastUpdate = Date.now() - lastUpdate;
      const viewersChangedSignificantly =
        previousViewers === 0 ||
        viewers === 0 ||
        Math.abs(viewers - previousViewers) / (previousViewers || 1) >= VIEWERS_CHANGE_THRESHOLD;

      if (
        viewersChangedSignificantly ||
        timeSinceLastUpdate >= MIN_UPDATE_INTERVAL_MS
      ) {
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
      console.log(
        `Tentativa ${failCounts[stateKey]}: .view-count não encontrado para ${stateKey}.`
      );
      if (failCounts[stateKey] >= MAX_FAILS) {
        console.log(
          `Interpretando ${stateKey} como offline após ${MAX_FAILS} falhas consecutivas.`
        );
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
    console.error(
      `Erro ao processar ${stateKey}:`,
      error,
      `| Falha #${failCounts[stateKey]}`
    );
    if (failCounts[stateKey] >= MAX_FAILS) {
      console.log(`Interpretando ${stateKey} como offline (exceção).`);
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
async function runClusterMonitor() {
  let userIds = await fetchUsersFromSupabase();
  if (userIds.length === 0) {
    throw new Error('Nenhum alvo encontrado para monitorar.');
  }

  const lastViewers = {};
  const waitTimes = {};
  const failCounts = {};

  const cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_PAGE,
    maxConcurrency: MAX_CONCURRENCY,
    retryLimit: RETRY_LIMIT,
    puppeteerOptions: {
      executablePath: 'C:\\Users\\Sam\\.cache\\puppeteer\\chrome\\win64-137.0.7151.55\\chrome-win64\\chrome.exe',
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
      ],
    },
    timeout: 3 * 60 * 1000,
  });

  cluster.on('taskerror', (err, data) => {
    console.error(`Erro na tarefa do alvo ${data}:`, err);
  });

  cluster.task(async ({ page, data }) => {
    await processChannel({
      page,
      data,
      waitTimes,
      lastViewers,
      failCounts,
    });
  });

  setInterval(async () => {
    try {
      userIds = await fetchUsersFromSupabase();
      console.log('Lista de alvos atualizada:', userIds);
    } catch (error) {
      console.error('Erro ao atualizar lista de alvos:', error);
    }
  }, 60_000);

  while (true) {
    for (const userId of userIds) {
      cluster.queue(userId);
    }
    await new Promise((r) => setTimeout(r, WAIT_BETWEEN_FULL_LOOP_MS));
  }
}

/************************************************************
 *  6. Wrapper + Health Check + Start                       *
 ************************************************************/
async function start() {
  const app = express();
  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  portfinder.basePort = BASE_PORT;
  portfinder.highestPort = BASE_PORT + 10;

  try {
    const port = await portfinder.getPortPromise();
    app.listen(port, () => {
      console.log(`Health-check rodando em http://localhost:${port}/health`);
    });
  } catch (err) {
    console.error('Erro ao encontrar uma porta disponível:', err);
    process.exit(1);
  }

  while (true) {
    try {
      await runClusterMonitor();
    } catch (error) {
      console.error('Erro no monitor principal, reiniciando em 40s...', error);
      await new Promise((r) => setTimeout(r, 40000));
    }
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

start();