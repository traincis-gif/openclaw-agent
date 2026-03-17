import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

const BOT_URL        = process.env.BOT_URL || 'https://polymarket-bot-production-b30b.up.railway.app';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const RAILWAY_TOKEN  = process.env.RAILWAY_TOKEN;
const PROJECT_ID     = '23fef3e7-07bc-402e-8860-ad1f84434598';
const ENV_ID         = 'bd2c6836-e79e-4d71-9a93-e2c352a938b8';
const BOT_SERVICE_ID = 'b112aaad-160a-441a-86f2-318abf82dca5';
const OLLAMA_URL     = process.env.OLLAMA_URL || 'http://ollama.railway.internal:11434';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const HEARTBEAT_MS   = 30 * 60 * 1000;
const ANALYSIS_MS    = 3 * 60 * 60 * 1000;
const EMERGENCY_LOSS = -20;

let lastHourlyPnl = 0, lastHourlyCheck = Date.now(), errCount = 0;

async function tg(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg, parse_mode: 'HTML' })
    });
  } catch(e) { console.error('[TG]', e.message); }
}

async function getBotState() {
  const r = await fetch(BOT_URL + '/api/state', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function stopBot() {
  await fetch(BOT_URL + '/api/bot/stop', { method: 'POST' }).catch(() => {});
}

async function setVar(key, value) {
  const q = 'mutation { variableUpsert(input: { projectId: "' + PROJECT_ID + '", environmentId: "' + ENV_ID + '", serviceId: "' + BOT_SERVICE_ID + '", name: "' + key + '", value: "' + value + '" }) }';
  const r = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RAILWAY_TOKEN },
    body: JSON.stringify({ query: q })
  });
  return r.json();
}

async function redeploy() {
  const q = 'mutation { serviceInstanceRedeploy(environmentId: "' + ENV_ID + '", serviceId: "' + BOT_SERVICE_ID + '") }';
  await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RAILWAY_TOKEN },
    body: JSON.stringify({ query: q })
  }).catch(() => {});
}

async function ollama(prompt) {
  const r = await fetch(OLLAMA_URL + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3:8b', messages: [{ role: 'user', content: prompt }], stream: false, options: { num_ctx: 32768 } }),
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok) throw new Error('Ollama ' + r.status);
  return (await r.json()).message?.content || '';
}

async function claude(prompt) {
  const c = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const m = await c.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] });
  return m.content[0].text;
}

async function heartbeat() {
  console.log('[HB] tick ' + new Date().toISOString());
  let s;
  try { s = await getBotState(); errCount = 0; }
  catch(e) {
    errCount++;
    if (errCount >= 3) await tg('🚨 <b>ALERT</b>: Бот недоступен ' + errCount + 'x\n' + e.message);
    return;
  }
  const trades = s.recentTrades || s.trades || [];
  const pnl = s.totalPnl || 0, exposure = s.totalExposure || 0, maxExp = s.maxExposure || 100;
  const positions = s.positions || [], running = s.isRunning || false, live = s.liveTrading || false;

  const now = Date.now();
  if (now - lastHourlyCheck > 3600000) {
    const drop = pnl - lastHourlyPnl;
    if (drop < EMERGENCY_LOSS) { await stopBot(); await tg('🛑 <b>EMERGENCY STOP</b>\nПотеря: $' + drop.toFixed(2)); }
    lastHourlyPnl = pnl; lastHourlyCheck = now;
  }
  if (maxExp > 0 && exposure / maxExp > 0.85) await tg('⚠️ Высокая экспозиция: $' + exposure.toFixed(0) + '/$' + maxExp);

  let summary;
  try {
    const recent = trades.slice(0,3).map(t => (t.market||'?').slice(0,40) + ' ' + ((t.pnl||0)>=0?'+':'') + '$' + (t.pnl||0).toFixed(2)).join('\n') || 'нет';
    summary = await ollama('Ты мониторинг агент Polymarket бота. Напиши краткий отчёт 5-6 строк на русском.\n\nСтатус: ' + (running?'запущен':'остановлен') + ' ' + (live?'LIVE':'PAPER') + '\nP&L: $' + pnl.toFixed(2) + '\nПозиций: ' + positions.length + ', Экспозиция: $' + exposure.toFixed(0) + '/$' + maxExp + '\nПоследние сделки:\n' + recent + '\n\nТолько факты. ✅ если всё ок, ⚠️ если проблема.');
  } catch(e) {
    console.error('[HB] Ollama unavailable:', e.message);
    summary = (running ? '✅ Работает' : '❌ Остановлен') + ' | ' + (live?'LIVE':'PAPER') + '\nP&L: $' + pnl.toFixed(2) + ' | Позиций: ' + positions.length + '\n[Ollama offline — используется fallback]';
  }
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'UTC', hour12: false });
  await tg('📊 <b>Polymarket — ' + time + ' UTC</b>\n\n' + summary);
}

async function analysis() {
  console.log('[ANALYSIS] running');
  let s;
  try { s = await getBotState(); } catch(e) { return; }
  const trades = s.recentTrades || s.trades || [];
  const pnl = s.totalPnl || 0;
  const wins = trades.filter(t => (t.pnl||0) > 0);
  const wr = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(0) : 0;
  const conf = parseFloat(process.env.MIN_CONFIDENCE || '0.65');
  const edge = parseFloat(process.env.MIN_EDGE_PCT || '2');
  const scan = parseInt(process.env.SCAN_INTERVAL_SECONDS || '120');

  let dec;
  try {
    const raw = await claude('Стратегический анализ Polymarket бота. Отвечай строго JSON без markdown.\n\nПАРАМЕТРЫ: MIN_CONFIDENCE=' + conf + ' MIN_EDGE_PCT=' + edge + ' SCAN_INTERVAL=' + scan + 's\nРЕЗУЛЬТАТЫ: ' + trades.length + ' сделок, win_rate=' + wr + '%, P&L=$' + pnl.toFixed(2) + '\nСДЕЛКИ: ' + JSON.stringify(trades.slice(0,6).map(t=>({m:(t.market||'?').slice(0,40),conf:t.confidence,pnl:parseFloat((t.pnl||0).toFixed(2))}))) + '\n\nПРАВИЛА: win_rate<40% повысить conf на 0.03-0.05 | win_rate>65% снизить conf на 0.02 | мало сделок снизить conf или edge\n\nJSON: {"action":"none|increase_confidence|decrease_confidence|increase_edge|decrease_edge","new_min_confidence":null,"new_min_edge_pct":null,"new_scan_interval":null,"reasoning":"1-2 предложения","telegram_report":"6-8 строк с эмодзи"}');
    const m = raw.match(/\{[\s\S]*\}/);
    dec = m ? JSON.parse(m[0]) : null;
  } catch(e) { console.error('[ANALYSIS]', e.message); return; }
  if (!dec) return;

  const changes = [];
  if (dec.new_min_confidence != null) { const v = Math.min(0.85, Math.max(0.50, parseFloat(dec.new_min_confidence))); await setVar('MIN_CONFIDENCE', String(v)); changes.push('MIN_CONFIDENCE → ' + v); }
  if (dec.new_min_edge_pct != null)   { const v = Math.min(8, Math.max(1, parseFloat(dec.new_min_edge_pct)));     await setVar('MIN_EDGE_PCT', String(v));    changes.push('MIN_EDGE_PCT → ' + v); }
  if (dec.new_scan_interval != null)  { const v = Math.min(600, Math.max(60, parseInt(dec.new_scan_interval)));   await setVar('SCAN_INTERVAL_SECONDS', String(v)); changes.push('SCAN_INTERVAL → ' + v + 's'); }
  if (changes.length > 0) { await redeploy(); console.log('[ANALYSIS] applied:', changes); }

  const cs = changes.length > 0 ? '\n\n🔧 <b>Изменено:</b>\n' + changes.map(c=>'  • '+c).join('\n') + '\n♻️ Бот перезапущен' : '\n\n✅ Параметры без изменений';
  await tg('🧠 <b>Стратегический анализ</b>\n\n' + dec.telegram_report + cs);
}

async function main() {
  console.log('🦞 OpenClaw Agent v1.0');
  console.log('BOT:', BOT_URL, '| OLLAMA:', OLLAMA_URL, '| TG:', TELEGRAM_TOKEN ? 'ok' : 'MISSING');
  await tg('🚀 <b>OpenClaw Agent запущен</b>\n\nМодели: Ollama qwen3:8b → Claude Sonnet\nХартбит: 30 мин | Анализ: 3 ч');
  await heartbeat();
  setTimeout(analysis, 2 * 60 * 1000);
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(analysis, ANALYSIS_MS);
}

main().catch(async e => { console.error('Fatal:', e); await tg('💥 <b>CRASH</b>: ' + e.message); process.exit(1); });
