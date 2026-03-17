import Anthropic from '@anthropic-ai/sdk';
import fetch from 'node-fetch';

const BOT_URL        = process.env.BOT_URL || 'https://polymarket-bot-production-b30b.up.railway.app';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const RAILWAY_TOKEN  = process.env.RAILWAY_TOKEN;
const PROJECT_ID     = '23fef3e7-07bc-402e-8860-ad1f84434598';
const ENV_ID         = 'bd2c6836-e79e-4d71-9a93-e2c352a938b8';
const BOT_SERVICE_ID = 'b112aaad-160a-441a-86f2-318abf82dca5';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY     = process.env.OPENAI_API_KEY;
const VOICE_MODE     = process.env.VOICE_MODE || 'analysis_only';
const EMERGENCY_LOSS = -20;
const HEARTBEAT_MS   = (parseInt(process.env.HEARTBEAT_INTERVAL_MIN)  || 30) * 60 * 1000;
const ANALYSIS_MS    = (parseInt(process.env.ANALYSIS_INTERVAL_HOURS) ||  3) * 60 * 60 * 1000;

let lastHourlyPnl = 0, lastHourlyCheck = Date.now(), errCount = 0;
let lastUpdateId  = 0; // для Telegram polling

// ─── Telegram отправка ────────────────────────────────────────────────────────
async function tg(msg, chatId = TELEGRAM_CHAT) {
  if (!TELEGRAM_TOKEN || !chatId) return;
  try {
    const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' })
    });
    const d = await r.json();
    if (!d.ok) console.error('[TG] error:', d.description);
    else console.log('[TG] sent OK');
  } catch(e) { console.error('[TG] error:', e.message); }
}

// ─── Telegram voice ───────────────────────────────────────────────────────────
async function tgVoice(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT || VOICE_MODE === 'none') return;
  const clean = text.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
  let audio;
  if (OPENAI_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
        body: JSON.stringify({ model: 'tts-1', input: clean.substring(0,4096), voice: 'nova', response_format: 'opus' })
      });
      if (r.ok) audio = Buffer.from(await r.arrayBuffer());
    } catch(e) { console.error('[VOICE] OpenAI:', e.message); }
  }
  if (!audio) {
    try {
      const r = await fetch('https://translate.google.com/translate_tts?ie=UTF-8&q=' + encodeURIComponent(clean.substring(0,180)) + '&tl=ru&client=tw-ob', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) audio = Buffer.from(await r.arrayBuffer());
    } catch(e) { console.error('[VOICE] Google:', e.message); }
  }
  if (!audio || audio.length < 100) return;
  try {
    const boundary = '----TGVoice' + Date.now(), CRLF = '\r\n';
    const header = Buffer.from('--' + boundary + CRLF + 'Content-Disposition: form-data; name="chat_id"' + CRLF + CRLF + TELEGRAM_CHAT + CRLF + '--' + boundary + CRLF + 'Content-Disposition: form-data; name="voice"; filename="voice.ogg"' + CRLF + 'Content-Type: audio/ogg' + CRLF + CRLF);
    const footer = Buffer.from(CRLF + '--' + boundary + '--' + CRLF);
    const body = Buffer.concat([header, audio, footer]);
    const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendVoice', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }, body });
    const d = await r.json();
    if (!d.ok) console.error('[VOICE] error:', d.description);
    else console.log('[VOICE] sent OK');
  } catch(e) { console.error('[VOICE] send:', e.message); }
}

async function tgFull(msg, withVoice = false) {
  await tg(msg);
  if (withVoice && VOICE_MODE !== 'none') await tgVoice(msg);
}

// ─── Telegram polling — получение сообщений от пользователя ──────────────────
async function pollTelegram() {
  try {
    const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getUpdates?offset=' + (lastUpdateId + 1) + '&timeout=0&limit=10');
    const d = await r.json();
    if (!d.ok || !d.result?.length) return;

    for (const upd of d.result) {
      lastUpdateId = upd.update_id;
      const msg    = upd.message;
      if (!msg) continue;

      const chatId = String(msg.chat?.id);
      const text   = (msg.text || '').trim();
      const userId = String(msg.from?.id);

      // Отвечаем только владельцу
      if (chatId !== String(TELEGRAM_CHAT)) {
        console.log('[POLL] ignored message from unknown chat:', chatId);
        continue;
      }

      console.log('[POLL] received:', text);
      await handleCommand(text, chatId);
    }
  } catch(e) { console.error('[POLL] error:', e.message); }
}

// ─── Обработка команд ─────────────────────────────────────────────────────────
async function handleCommand(text, chatId) {
  const cmd = text.toLowerCase().trim();

  // /status или "статус"
  if (cmd === '/status' || cmd === 'статус' || cmd === '/state') {
    await tg('⏳ Получаю статус бота...', chatId);
    try {
      const raw = await getBotState();
      const s = parseState(raw);
      const reply =
        '📊 <b>Статус бота</b>\n\n' +
        (s.running ? '✅ Работает' : '❌ Остановлен') + ' | ' + (s.live ? 'LIVE 💰' : 'PAPER 📝') + ' | ' + s.mode + '\n' +
        'Баланс: <b>$' + s.balance.toFixed(2) + '</b> | P&amp;L: ' + (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(2) + '\n' +
        'Позиций: ' + s.openCount + ' | Экспозиция: $' + s.exposure.toFixed(0) + '/$' + s.maxExp + '\n' +
        'Рынков: ' + s.markets.length + ' | Скан #' + s.scanCount;
      await tg(reply, chatId);
    } catch(e) { await tg('❌ Ошибка: ' + e.message, chatId); }
    return;
  }

  // /positions или "позиции"
  if (cmd === '/positions' || cmd === 'позиции') {
    await tg('⏳ Получаю позиции...', chatId);
    try {
      const raw = await getBotState();
      const trades = (raw.trades || []).filter(t => t.status === 'OPEN').slice(0, 10);
      if (!trades.length) { await tg('📭 Нет открытых позиций', chatId); return; }
      const lines = trades.map(t =>
        (t.side === 'YES' ? '🟢' : '🔴') + ' <b>' + t.side + '</b> ' +
        (t.question || '?').substring(0, 40) + '\n' +
        '   $' + (t.sizeUSDC||0).toFixed(2) + ' @ ' + ((t.price||0)*100).toFixed(0) + 'c | ' + (t.category||'?')
      );
      await tg('📋 <b>Открытые позиции (' + trades.length + '):</b>\n\n' + lines.join('\n\n'), chatId);
    } catch(e) { await tg('❌ Ошибка: ' + e.message, chatId); }
    return;
  }

  // /stop — остановить бот
  if (cmd === '/stop' || cmd === 'стоп') {
    await tg('⏳ Останавливаю бот...', chatId);
    try {
      await fetch(BOT_URL + '/api/bot/stop', { method: 'POST' });
      await tg('🛑 <b>Бот остановлен</b>', chatId);
    } catch(e) { await tg('❌ Ошибка: ' + e.message, chatId); }
    return;
  }

  // /start — запустить бот
  if (cmd === '/start' || cmd === 'старт') {
    await tg('⏳ Запускаю бот...', chatId);
    try {
      await fetch(BOT_URL + '/api/bot/start', { method: 'POST' });
      await tg('✅ <b>Бот запущен</b>', chatId);
    } catch(e) { await tg('❌ Ошибка: ' + e.message, chatId); }
    return;
  }

  // /report или "отчёт" — немедленный анализ
  if (cmd === '/report' || cmd === 'отчёт' || cmd === 'отчет') {
    await tg('⏳ Делаю анализ через Sonnet...', chatId);
    await analysis();
    return;
  }

  // /help — список команд
  if (cmd === '/help' || cmd === 'помощь' || cmd === '?') {
    await tg(
      '🤖 <b>Команды OpenClaw Agent</b>\n\n' +
      '/status — статус бота\n' +
      '/positions — открытые позиции\n' +
      '/report — стратегический анализ сейчас\n' +
      '/stop — остановить торговлю\n' +
      '/start — запустить торговлю\n' +
      '/help — эта справка\n\n' +
      'Также можно написать любой вопрос — отвечу через Claude.',
      chatId
    );
    return;
  }

  // Свободный вопрос — отвечает Claude Sonnet
  if (text.length > 1 && !text.startsWith('/')) {
    await tg('💬 <b>Думаю...</b>', chatId);
    try {
      const raw = await getBotState();
      const s = parseState(raw);
      const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
      const reply = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content:
            'Ты умный ИИ-агент мониторинга Polymarket торгового бота. Отвечай на русском, кратко и по делу.\n\n' +
            'Текущее состояние бота:\n' +
            'Статус: ' + (s.running ? 'работает' : 'остановлен') + ' | ' + (s.live ? 'LIVE' : 'PAPER') + ' | режим ' + s.mode + '\n' +
            'Баланс: $' + s.balance.toFixed(2) + ' | P&L: $' + s.pnl.toFixed(2) + '\n' +
            'Позиций: ' + s.openCount + ' | Экспозиция: $' + s.exposure.toFixed(0) + '\n\n' +
            'Вопрос пользователя: ' + text
        }]
      });
      await tg(reply.content[0].text, chatId);
    } catch(e) { await tg('❌ Ошибка Claude: ' + e.message, chatId); }
    return;
  }
}

// ─── Bot API ──────────────────────────────────────────────────────────────────
async function getBotState() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(BOT_URL + '/api/state', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  } catch(e) { clearTimeout(t); throw e; }
}

function parseState(s) {
  const pf = s.portfolio || {};
  const st = s.status   || {};
  return {
    running:   st.running        ?? false,
    live:      st.liveTrading    ?? false,
    mode:      st.managerDirective?.mode || 'unknown',
    pnl:       pf.totalPnl       ?? 0,
    balance:   pf.usdcBalance    ?? 0,
    exposure:  pf.totalExposureUSDC ?? 0,
    maxExp:    parseFloat(process.env.MAX_TOTAL_EXPOSURE || '100'),
    openCount: pf.openTrades     ?? 0,
    trades:    s.trades          || [],
    markets:   s.markets         || [],
    scanCount: st.scanCount      ?? 0,
  };
}

async function stopBot() {
  try { await fetch(BOT_URL + '/api/bot/stop', { method: 'POST' }); } catch(e) {}
}

async function setVar(key, val) {
  try {
    const q = 'mutation{variableUpsert(input:{projectId:"' + PROJECT_ID + '",environmentId:"' + ENV_ID + '",serviceId:"' + BOT_SERVICE_ID + '",name:"' + key + '",value:"' + val + '"})}';
    await fetch('https://backboard.railway.app/graphql/v2', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RAILWAY_TOKEN }, body: JSON.stringify({ query: q }) });
  } catch(e) { console.error('[VAR]', e.message); }
}

async function redeploy() {
  try {
    const q = 'mutation{serviceInstanceRedeploy(environmentId:"' + ENV_ID + '",serviceId:"' + BOT_SERVICE_ID + '")}';
    await fetch('https://backboard.railway.app/graphql/v2', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RAILWAY_TOKEN }, body: JSON.stringify({ query: q }) });
  } catch(e) { console.error('[REDEPLOY]', e.message); }
}

async function askClaude(prompt, model = 'claude-haiku-4-5-20251001') {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const msg = await client.messages.create({ model, max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
  return msg.content[0].text;
}

// ─── HEARTBEAT ────────────────────────────────────────────────────────────────
async function heartbeat() {
  console.log('[HB] tick', new Date().toISOString());
  let raw;
  try { raw = await getBotState(); errCount = 0; }
  catch(e) {
    errCount++;
    if (errCount >= 3) await tg('🚨 <b>ALERT</b>: Бот недоступен ' + errCount + 'x\n' + e.message);
    return;
  }
  const s = parseState(raw);
  const now = Date.now();
  if (now - lastHourlyCheck > 3600000) {
    const drop = s.pnl - lastHourlyPnl;
    if (drop < EMERGENCY_LOSS) { await stopBot(); await tgFull('🛑 <b>EMERGENCY STOP</b>\nПотеря: $' + drop.toFixed(2), true); }
    lastHourlyPnl = s.pnl; lastHourlyCheck = now;
  }
  if (s.maxExp > 0 && s.exposure / s.maxExp > 0.85) await tg('⚠️ Высокая экспозиция: $' + s.exposure.toFixed(0) + '/$' + s.maxExp);

  const recentStr = s.trades.slice(0,3).map(t => '  ' + (t.question||'?').substring(0,35) + ': ' + ((t.pnl||0)>=0?'+':'') + '$' + (t.pnl||0).toFixed(2)).join('\n') || '  нет';
  let summary;
  try {
    summary = await askClaude(
      'Мониторинг Polymarket бота. Краткий отчёт 5-6 строк на русском.\n' +
      'Статус: ' + (s.running?'работает':'остановлен') + ' | ' + (s.live?'LIVE':'PAPER') + ' | ' + s.mode + '\n' +
      'P&L: $' + s.pnl.toFixed(2) + ' | Баланс: $' + s.balance.toFixed(2) + '\n' +
      'Позиций: ' + s.openCount + ' | Экспозиция: $' + s.exposure.toFixed(0) + '/$' + s.maxExp + '\n' +
      'Рынков: ' + s.markets.length + ' | Скан #' + s.scanCount + '\n' +
      'Сделки:\n' + recentStr + '\nНачни с ✅ или ⚠️.'
    );
  } catch(e) {
    summary = (s.running?'✅':'❌') + ' ' + (s.live?'LIVE':'PAPER') + ' | P&L: $' + s.pnl.toFixed(2) + ' | Позиций: ' + s.openCount;
  }
  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'UTC', hour12: false });
  await tgFull('📊 <b>Polymarket — ' + time + ' UTC</b>\n\n' + summary, VOICE_MODE === 'all');
  console.log('[HB] done');
}

// ─── DEEP ANALYSIS ────────────────────────────────────────────────────────────
async function analysis() {
  console.log('[ANALYSIS] running');
  let raw;
  try { raw = await getBotState(); } catch(e) { console.error('[ANALYSIS] fetch:', e.message); return; }
  const s = parseState(raw);
  const trades = s.trades;
  const wins = trades.filter(t => (t.pnl||0) > 0);
  const wr = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(0) : '?';
  const conf = parseFloat(process.env.MIN_CONFIDENCE || '0.65');
  const edge = parseFloat(process.env.MIN_EDGE_PCT   || '2');
  const scan = parseInt(process.env.SCAN_INTERVAL_SECONDS || '120');

  let dec;
  try {
    const raw2 = await askClaude(
      'Стратегический анализ Polymarket бота. ТОЛЬКО JSON без markdown.\n' +
      'Состояние: ' + (s.running?'работает':'остановлен') + ' | ' + (s.live?'LIVE':'PAPER') + ' | ' + s.mode + '\n' +
      'Баланс: $' + s.balance.toFixed(2) + ' | P&L: $' + s.pnl.toFixed(2) + ' | Позиций: ' + s.openCount + '\n' +
      'Параметры: MIN_CONFIDENCE=' + conf + ' MIN_EDGE_PCT=' + edge + ' SCAN=' + scan + 's\n' +
      'Статистика: ' + trades.length + ' сделок, win_rate=' + wr + '%\n' +
      'Сделки: ' + JSON.stringify(trades.slice(0,6).map(t=>({q:(t.question||'?').substring(0,30),side:t.side,cat:t.category,pnl:parseFloat((t.pnl||0).toFixed(2)),status:t.status}))) + '\n\n' +
      'Правила: win_rate<40%→повысить conf | win_rate>65%→снизить conf | мало сделок→снизить conf/edge\n' +
      'JSON: {"action":"none","new_min_confidence":null,"new_min_edge_pct":null,"new_scan_interval":null,"reasoning":"..","telegram_report":"6-8 строк с эмодзи","voice_summary":"2-3 предложения"}',
      'claude-sonnet-4-6'
    );
    const m = raw2.match(/\{[\s\S]*\}/);
    dec = m ? JSON.parse(m[0]) : null;
  } catch(e) { console.error('[ANALYSIS] Claude:', e.message); return; }
  if (!dec) return;

  const changes = [];
  if (dec.new_min_confidence != null) { const v = Math.min(0.85,Math.max(0.50,parseFloat(dec.new_min_confidence))); await setVar('MIN_CONFIDENCE',String(v)); changes.push('MIN_CONFIDENCE: '+conf+'→'+v); }
  if (dec.new_min_edge_pct   != null) { const v = Math.min(8,Math.max(1,parseFloat(dec.new_min_edge_pct)));         await setVar('MIN_EDGE_PCT',   String(v)); changes.push('MIN_EDGE_PCT: '+edge+'→'+v); }
  if (dec.new_scan_interval  != null) { const v = Math.min(600,Math.max(60,parseInt(dec.new_scan_interval)));        await setVar('SCAN_INTERVAL_SECONDS',String(v)); changes.push('SCAN: '+scan+'s→'+v+'s'); }
  if (changes.length > 0) { await redeploy(); console.log('[ANALYSIS] applied:', changes); }

  const cs = changes.length > 0 ? '\n\n🔧 <b>Изменено:</b>\n' + changes.map(c=>'  • '+c).join('\n') + '\n♻️ Бот перезапущен' : '\n\n✅ Параметры без изменений';
  await tg('🧠 <b>Стратегический анализ</b>\n\n' + dec.telegram_report + cs);
  if (VOICE_MODE !== 'none') {
    const vt = (dec.voice_summary||dec.telegram_report.replace(/<[^>]*>/g,'').substring(0,300)) + (changes.length>0?' Изменены: '+changes.join(', ')+'.':' Параметры без изменений.');
    await tgVoice(vt);
  }
  console.log('[ANALYSIS] done');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🦞 OpenClaw Agent v1.4 — с поддержкой диалога');
  console.log('  HEARTBEAT:', HEARTBEAT_MS/60000, 'мин | ANALYSIS:', ANALYSIS_MS/3600000, 'ч');
  console.log('  BOT_URL:', BOT_URL);
  console.log('  ANTHROPIC:', ANTHROPIC_KEY ? 'ok' : 'MISSING');

  await tg(
    '🚀 <b>OpenClaw Agent v1.4</b>\n\n' +
    '💬 Теперь можно общаться! Напиши:\n' +
    '/help — список команд\n' +
    '/status — статус бота\n' +
    '/positions — позиции\n' +
    '/report — анализ сейчас\n' +
    'Или просто задай вопрос на русском.\n\n' +
    'Хартбит: каждые ' + (HEARTBEAT_MS/60000) + ' мин | Анализ: ' + (ANALYSIS_MS/3600000) + 'ч'
  );

  // Инициализация lastUpdateId — берём текущий offset чтобы не обрабатывать старые сообщения
  try {
    const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getUpdates?limit=1&offset=-1');
    const d = await r.json();
    if (d.result?.length) lastUpdateId = d.result[d.result.length-1].update_id;
    console.log('[POLL] initialized lastUpdateId:', lastUpdateId);
  } catch(e) { console.error('[POLL] init error:', e.message); }

  await heartbeat();
  setTimeout(analysis, 2 * 60 * 1000);

  // Polling каждые 3 секунды
  setInterval(pollTelegram, 3000);
  setInterval(heartbeat,    HEARTBEAT_MS);
  setInterval(analysis,     ANALYSIS_MS);
}

main().catch(async e => {
  console.error('Fatal:', e);
  await tg('💥 <b>CRASH</b>: ' + e.message);
  process.exit(1);
});
