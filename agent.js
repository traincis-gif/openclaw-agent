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
const OPENAI_KEY     = process.env.OPENAI_API_KEY; // для TTS (опционально)
const HEARTBEAT_MS   = 30 * 60 * 1000;
const ANALYSIS_MS    = 3 * 60 * 60 * 1000;
const EMERGENCY_LOSS = -20;

// Голосовые: 'all' | 'analysis_only' | 'none'
const VOICE_MODE = process.env.VOICE_MODE || 'analysis_only';

let lastHourlyPnl = 0, lastHourlyCheck = Date.now(), errCount = 0;

// ─── Telegram text ────────────────────────────────────────────────────────────
async function tg(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) { console.log('[TG] missing config'); return; }
  try {
    const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg, parse_mode: 'HTML' })
    });
    const d = await r.json();
    if (!d.ok) console.error('[TG] error:', d.description);
    else console.log('[TG] text sent OK');
  } catch(e) { console.error('[TG] fetch error:', e.message); }
}

// ─── Telegram voice ───────────────────────────────────────────────────────────
async function tgVoice(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  if (VOICE_MODE === 'none') return;

  // Strip HTML tags for TTS
  const clean = text.replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();

  let audioBuffer;

  // Try OpenAI TTS first (best quality)
  if (OPENAI_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
        body: JSON.stringify({
          model: 'tts-1',
          input: clean.substring(0, 4096),
          voice: 'nova',        // nova — приятный женский голос
          response_format: 'opus' // Telegram принимает OGG Opus
        })
      });
      if (r.ok) {
        audioBuffer = Buffer.from(await r.arrayBuffer());
        console.log('[VOICE] OpenAI TTS ok, size:', audioBuffer.length);
      } else {
        const err = await r.text();
        console.error('[VOICE] OpenAI TTS error:', err);
      }
    } catch(e) { console.error('[VOICE] OpenAI TTS exception:', e.message); }
  }

  // Fallback: Google TTS (бесплатно, без ключа, лимит ~200 символов)
  if (!audioBuffer) {
    try {
      const shortText = clean.substring(0, 180);
      const url = 'https://translate.google.com/translate_tts?ie=UTF-8&q='
        + encodeURIComponent(shortText) + '&tl=ru&client=tw-ob';
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (r.ok) {
        audioBuffer = Buffer.from(await r.arrayBuffer());
        console.log('[VOICE] Google TTS fallback ok, size:', audioBuffer.length);
      }
    } catch(e) { console.error('[VOICE] Google TTS exception:', e.message); }
  }

  if (!audioBuffer || audioBuffer.length < 100) {
    console.error('[VOICE] no audio, skipping voice message');
    return;
  }

  // Send via multipart/form-data
  try {
    const boundary = '----TGVoiceBoundary' + Date.now();
    const CRLF = '\r\n';

    const header = Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="chat_id"' + CRLF + CRLF +
      TELEGRAM_CHAT + CRLF +
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="voice"; filename="voice.ogg"' + CRLF +
      'Content-Type: audio/ogg' + CRLF + CRLF
    );
    const footer = Buffer.from(CRLF + '--' + boundary + '--' + CRLF);
    const body = Buffer.concat([header, audioBuffer, footer]);

    const r = await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendVoice', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      },
      body
    });
    const d = await r.json();
    if (!d.ok) console.error('[VOICE] sendVoice error:', d.description);
    else console.log('[VOICE] voice sent OK');
  } catch(e) { console.error('[VOICE] sendVoice exception:', e.message); }
}

// ─── Send both text + voice ───────────────────────────────────────────────────
async function tgFull(msg, sendVoice = false) {
  await tg(msg);
  if (sendVoice && VOICE_MODE !== 'none') {
    await tgVoice(msg);
  }
}

// ─── Bot API ──────────────────────────────────────────────────────────────────
async function getBotState() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(BOT_URL + '/api/state', { signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  } catch(e) { clearTimeout(timer); throw e; }
}

async function stopBot() {
  try { await fetch(BOT_URL + '/api/bot/stop', { method: 'POST' }); } catch(e) {}
}

async function setVar(key, val) {
  try {
    const q = 'mutation{variableUpsert(input:{projectId:"' + PROJECT_ID + '",environmentId:"' + ENV_ID + '",serviceId:"' + BOT_SERVICE_ID + '",name:"' + key + '",value:"' + val + '"})}';
    const r = await fetch('https://backboard.railway.app/graphql/v2', {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+RAILWAY_TOKEN},
      body:JSON.stringify({query:q})
    });
    return r.json();
  } catch(e) { console.error('[VAR]', e.message); }
}

async function redeploy() {
  try {
    const q = 'mutation{serviceInstanceRedeploy(environmentId:"' + ENV_ID + '",serviceId:"' + BOT_SERVICE_ID + '")}';
    await fetch('https://backboard.railway.app/graphql/v2', {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+RAILWAY_TOKEN},
      body:JSON.stringify({query:q})
    });
  } catch(e) { console.error('[REDEPLOY]', e.message); }
}

// ─── LLM ──────────────────────────────────────────────────────────────────────
async function askClaude(prompt, maxTokens = 512) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  });
  return msg.content[0].text;
}

async function askClaudeSonnet(prompt) {
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });
  return msg.content[0].text;
}

// ─── HEARTBEAT (30 мин, Haiku, текст) ────────────────────────────────────────
async function heartbeat() {
  console.log('[HB] tick ' + new Date().toISOString());
  let s;
  try { s = await getBotState(); errCount = 0; }
  catch(e) {
    errCount++;
    console.error('[HB] bot unreachable:', e.message);
    if (errCount >= 3) await tg('🚨 <b>ALERT</b>: Бот недоступен ' + errCount + ' раза\n' + e.message);
    return;
  }

  const trades   = s.recentTrades || s.trades || [];
  const pnl      = s.totalPnl || s.pnl || 0;
  const exposure = s.totalExposure || 0;
  const maxExp   = s.maxExposure || parseFloat(process.env.MAX_TOTAL_EXPOSURE || '100');
  const positions= s.positions || [];
  const running  = s.isRunning || s.botRunning || false;
  const live     = s.liveTrading || s.live || false;

  const now = Date.now();
  if (now - lastHourlyCheck > 3600000) {
    const drop = pnl - lastHourlyPnl;
    if (drop < EMERGENCY_LOSS) {
      await stopBot();
      // Emergency — голос всегда
      await tgFull('🛑 <b>EMERGENCY STOP</b>\nПотеря за час: $' + drop.toFixed(2) + '\nБот остановлен автоматически.', true);
    }
    lastHourlyPnl = pnl; lastHourlyCheck = now;
  }

  if (maxExp > 0 && exposure / maxExp > 0.85)
    await tg('⚠️ Высокая экспозиция: $' + exposure.toFixed(0) + '/$' + maxExp);

  let summary;
  try {
    const recent = trades.slice(0,3).map(t =>
      '  ' + (t.market||t.question||'?').substring(0,35) + ': ' + ((t.pnl||0)>=0?'+':'') + '$' + (t.pnl||0).toFixed(2)
    ).join('\n') || '  нет';

    summary = await askClaude(
      'Ты агент мониторинга Polymarket бота. Напиши краткий отчёт 5-6 строк на русском.\n\n' +
      'Статус: ' + (running?'работает':'остановлен') + ' | ' + (live?'LIVE':'PAPER') + '\n' +
      'P&L: $' + pnl.toFixed(2) + '\n' +
      'Позиций: ' + positions.length + ' | Экспозиция: $' + exposure.toFixed(0) + '/$' + maxExp + '\n' +
      'Последние сделки:\n' + recent + '\n\n' +
      'Только факты. Начни с ✅ если всё нормально или ⚠️ если проблемы.'
    );
  } catch(e) {
    console.error('[HB] Claude error:', e.message);
    summary = (running ? '✅ Бот работает' : '❌ Бот остановлен') + ' | ' + (live?'LIVE':'PAPER') +
              '\nP&L: $' + pnl.toFixed(2) + ' | Позиций: ' + positions.length;
  }

  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'UTC', hour12: false });
  // Heartbeat — только текст (если VOICE_MODE=all то и голос)
  await tgFull('📊 <b>Polymarket — ' + time + ' UTC</b>\n\n' + summary, VOICE_MODE === 'all');
  console.log('[HB] done');
}

// ─── DEEP ANALYSIS (3ч, Sonnet, текст + голос) ────────────────────────────────
async function analysis() {
  console.log('[ANALYSIS] running');
  let s;
  try { s = await getBotState(); }
  catch(e) { console.error('[ANALYSIS] fetch failed:', e.message); return; }

  const trades = s.recentTrades || s.trades || [];
  const pnl    = s.totalPnl || 0;
  const wins   = trades.filter(t => (t.pnl||0) > 0);
  const wr     = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(0) : '?';
  const conf   = parseFloat(process.env.MIN_CONFIDENCE || '0.65');
  const edge   = parseFloat(process.env.MIN_EDGE_PCT || '2');
  const scan   = parseInt(process.env.SCAN_INTERVAL_SECONDS || '120');

  let dec;
  try {
    const raw = await askClaudeSonnet(
      'Стратегический анализ Polymarket бота. Отвечай ТОЛЬКО JSON без markdown.\n\n' +
      'ПАРАМЕТРЫ: MIN_CONFIDENCE=' + conf + ' MIN_EDGE_PCT=' + edge + ' SCAN_INTERVAL=' + scan + 's\n' +
      'СТАТИСТИКА: ' + trades.length + ' сделок, win_rate=' + wr + '%, P&L=$' + pnl.toFixed(2) + '\n' +
      'СДЕЛКИ: ' + JSON.stringify(trades.slice(0,6).map(t=>({
        market: (t.market||t.question||'?').substring(0,40),
        confidence: t.confidence,
        pnl: parseFloat((t.pnl||0).toFixed(2))
      }))) + '\n\n' +
      'ПРАВИЛА: win_rate<40% → повысить conf 0.03-0.05 | win_rate>65% → снизить conf 0.02 | мало сделок → снизить conf/edge\n\n' +
      'JSON: {"action":"none","new_min_confidence":null,"new_min_edge_pct":null,"new_scan_interval":null,' +
      '"reasoning":"1-2 предл.","telegram_report":"6-8 строк с эмодзи","voice_summary":"2-3 предложения для голосового сообщения на русском"}'
    );
    const m = raw.match(/\{[\s\S]*\}/);
    dec = m ? JSON.parse(m[0]) : null;
    console.log('[ANALYSIS] decision:', dec?.action);
  } catch(e) { console.error('[ANALYSIS] Claude error:', e.message); return; }
  if (!dec) return;

  const changes = [];
  if (dec.new_min_confidence != null) { const v = Math.min(0.85, Math.max(0.50, parseFloat(dec.new_min_confidence))); await setVar('MIN_CONFIDENCE', String(v)); changes.push('MIN_CONFIDENCE: ' + conf + ' → ' + v); }
  if (dec.new_min_edge_pct != null)   { const v = Math.min(8, Math.max(1, parseFloat(dec.new_min_edge_pct)));   await setVar('MIN_EDGE_PCT', String(v)); changes.push('MIN_EDGE_PCT: ' + edge + ' → ' + v); }
  if (dec.new_scan_interval != null)  { const v = Math.min(600, Math.max(60, parseInt(dec.new_scan_interval))); await setVar('SCAN_INTERVAL_SECONDS', String(v)); changes.push('SCAN_INTERVAL: ' + scan + 's → ' + v + 's'); }
  if (changes.length > 0) { await redeploy(); console.log('[ANALYSIS] applied:', changes); }

  const cs = changes.length > 0
    ? '\n\n🔧 <b>Изменено:</b>\n' + changes.map(c => '  • ' + c).join('\n') + '\n♻️ Бот перезапущен'
    : '\n\n✅ Параметры без изменений';

  // Текстовый отчёт
  await tg('🧠 <b>Стратегический анализ</b>\n\n' + dec.telegram_report + cs);

  // Голосовое — краткая версия для анализа
  if (VOICE_MODE !== 'none') {
    const voiceText = dec.voice_summary ||
      dec.telegram_report.replace(/<[^>]*>/g,'').substring(0, 300);
    const changesVoice = changes.length > 0
      ? ' Изменены параметры: ' + changes.map(c => c.replace('→','-')).join(', ') + '. Бот перезапущен.'
      : ' Параметры без изменений.';
    await tgVoice(voiceText + changesVoice);
  }

  console.log('[ANALYSIS] done');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🦞 OpenClaw Agent v1.2 starting');
  console.log('  BOT_URL:', BOT_URL);
  console.log('  TG_CHAT:', TELEGRAM_CHAT);
  console.log('  ANTHROPIC:', ANTHROPIC_KEY ? 'ok' : 'MISSING');
  console.log('  OPENAI_TTS:', OPENAI_KEY ? 'ok' : 'not set (Google TTS fallback)');
  console.log('  VOICE_MODE:', VOICE_MODE);

  await tg('🚀 <b>OpenClaw Agent v1.2</b>\n\nГолосовые сообщения: ' + VOICE_MODE +
    (OPENAI_KEY ? ' (OpenAI TTS)' : ' (Google TTS fallback)') +
    '\nХартбит: 30 мин | Анализ: 3 ч\n\nПервый отчёт через несколько секунд...');

  await heartbeat();
  setTimeout(analysis, 3 * 60 * 1000);

  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(analysis, ANALYSIS_MS);
}

main().catch(async e => {
  console.error('Fatal:', e);
  await tg('💥 <b>CRASH</b>: ' + e.message);
  process.exit(1);
});
