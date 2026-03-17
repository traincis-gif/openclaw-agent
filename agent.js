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
const HEARTBEAT_MS   = 30 * 60 * 1000;
const ANALYSIS_MS    = 3 * 60 * 60 * 1000;
const EMERGENCY_LOSS = -20;

let lastHourlyPnl = 0, lastHourlyCheck = Date.now(), errCount = 0;

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
    else console.log('[TG] sent OK');
  } catch(e) { console.error('[TG] fetch error:', e.message); }
}

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
  } catch(e) { console.error('[VAR] setVar error:', e.message); }
}

async function redeploy() {
  try {
    const q = 'mutation{serviceInstanceRedeploy(environmentId:"' + ENV_ID + '",serviceId:"' + BOT_SERVICE_ID + '")}';
    await fetch('https://backboard.railway.app/graphql/v2', {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+RAILWAY_TOKEN},
      body:JSON.stringify({query:q})
    });
  } catch(e) { console.error('[REDEPLOY] error:', e.message); }
}

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

async function heartbeat() {
  console.log('[HB] tick ' + new Date().toISOString());
  let s;
  try { s = await getBotState(); errCount = 0; }
  catch(e) {
    errCount++;
    console.error('[HB] bot unreachable:', e.message);
    if (errCount >= 3) await tg('🚨 <b>ALERT</b>: Бот недоступен ' + errCount + ' раза подряд\n' + e.message);
    return;
  }

  const trades   = s.recentTrades || s.trades || [];
  const pnl      = s.totalPnl || s.pnl || 0;
  const exposure = s.totalExposure || 0;
  const maxExp   = s.maxExposure || parseFloat(process.env.MAX_TOTAL_EXPOSURE || '100');
  const positions= s.positions || [];
  const running  = s.isRunning || s.botRunning || false;
  const live     = s.liveTrading || s.live || false;

  // Hourly loss guard
  const now = Date.now();
  if (now - lastHourlyCheck > 3600000) {
    const drop = pnl - lastHourlyPnl;
    if (drop < EMERGENCY_LOSS) {
      await stopBot();
      await tg('🛑 <b>EMERGENCY STOP</b>\nПотеря за час: $' + drop.toFixed(2) + '\nБот остановлен автоматически.');
    }
    lastHourlyPnl = pnl; lastHourlyCheck = now;
  }

  if (maxExp > 0 && exposure / maxExp > 0.85)
    await tg('⚠️ Высокая экспозиция: $' + exposure.toFixed(0) + '/$' + maxExp);

  // Haiku for cheap heartbeat summary
  let summary;
  try {
    const recent = trades.slice(0,3).map(t =>
      '  ' + (t.market||t.question||'?').substring(0,35) + ': ' + ((t.pnl||0)>=0?'+':'') + '$' + (t.pnl||0).toFixed(2)
    ).join('\n') || '  нет';

    summary = await askClaude(
      'Ты агент мониторинга Polymarket бота. Напиши краткий отчёт 5-6 строк на русском языке.\n\n' +
      'Статус: ' + (running?'работает':'остановлен') + ' | Режим: ' + (live?'LIVE 💰':'PAPER 📝') + '\n' +
      'P&L: $' + pnl.toFixed(2) + '\n' +
      'Открытых позиций: ' + positions.length + '\n' +
      'Экспозиция: $' + exposure.toFixed(0) + ' / $' + maxExp + '\n' +
      'Последние сделки:\n' + recent + '\n\n' +
      'Только факты. Начни с ✅ если всё нормально или ⚠️ если есть проблемы.'
    );
  } catch(e) {
    console.error('[HB] Claude error:', e.message);
    summary = (running ? '✅ Бот работает' : '❌ Бот остановлен') + ' | ' + (live?'LIVE':'PAPER') +
              '\nP&L: $' + pnl.toFixed(2) + ' | Позиций: ' + positions.length;
  }

  const time = new Date().toLocaleTimeString('ru-RU', { timeZone: 'UTC', hour12: false });
  await tg('📊 <b>Polymarket — ' + time + ' UTC</b>\n\n' + summary);
  console.log('[HB] done');
}

async function analysis() {
  console.log('[ANALYSIS] running deep analysis');
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
      'Стратегический анализ Polymarket бота. Отвечай ТОЛЬКО JSON без markdown и без пояснений.\n\n' +
      'ТЕКУЩИЕ ПАРАМЕТРЫ: MIN_CONFIDENCE=' + conf + ' MIN_EDGE_PCT=' + edge + ' SCAN_INTERVAL=' + scan + 's\n' +
      'СТАТИСТИКА: ' + trades.length + ' сделок, win_rate=' + wr + '%, P&L=$' + pnl.toFixed(2) + '\n' +
      'СДЕЛКИ: ' + JSON.stringify(trades.slice(0,6).map(t=>({
        market: (t.market||t.question||'?').substring(0,40),
        confidence: t.confidence,
        pnl: parseFloat((t.pnl||0).toFixed(2))
      }))) + '\n\n' +
      'ПРАВИЛА:\n' +
      '- win_rate < 40%: повысить MIN_CONFIDENCE на 0.03-0.05\n' +
      '- win_rate > 65%: можно снизить MIN_CONFIDENCE на 0.02\n' +
      '- менее 5 сделок за 3ч: снизить MIN_CONFIDENCE или MIN_EDGE_PCT\n' +
      '- много потерь подряд: повысить MIN_EDGE_PCT\n\n' +
      'Ответ строго в JSON:\n' +
      '{"action":"none","new_min_confidence":null,"new_min_edge_pct":null,"new_scan_interval":null,"reasoning":"..","telegram_report":"6-8 строк с эмодзи на русском"}'
    );
    const m = raw.match(/\{[\s\S]*\}/);
    dec = m ? JSON.parse(m[0]) : null;
    console.log('[ANALYSIS] decision:', dec?.action);
  } catch(e) { console.error('[ANALYSIS] Claude error:', e.message); return; }
  if (!dec) { console.error('[ANALYSIS] no valid JSON'); return; }

  const changes = [];
  if (dec.new_min_confidence != null) {
    const v = Math.min(0.85, Math.max(0.50, parseFloat(dec.new_min_confidence)));
    await setVar('MIN_CONFIDENCE', String(v));
    changes.push('MIN_CONFIDENCE: ' + conf + ' → ' + v);
  }
  if (dec.new_min_edge_pct != null) {
    const v = Math.min(8, Math.max(1, parseFloat(dec.new_min_edge_pct)));
    await setVar('MIN_EDGE_PCT', String(v));
    changes.push('MIN_EDGE_PCT: ' + edge + ' → ' + v);
  }
  if (dec.new_scan_interval != null) {
    const v = Math.min(600, Math.max(60, parseInt(dec.new_scan_interval)));
    await setVar('SCAN_INTERVAL_SECONDS', String(v));
    changes.push('SCAN_INTERVAL: ' + scan + 's → ' + v + 's');
  }
  if (changes.length > 0) {
    await redeploy();
    console.log('[ANALYSIS] applied:', changes);
  }

  const cs = changes.length > 0
    ? '\n\n🔧 <b>Изменено:</b>\n' + changes.map(c => '  • ' + c).join('\n') + '\n♻️ Бот перезапущен'
    : '\n\n✅ Параметры без изменений';
  await tg('🧠 <b>Стратегический анализ</b>\n\n' + dec.telegram_report + cs);
  console.log('[ANALYSIS] done');
}

async function main() {
  console.log('🦞 OpenClaw Agent v1.1 starting');
  console.log('  BOT_URL:', BOT_URL);
  console.log('  TG_TOKEN:', TELEGRAM_TOKEN ? TELEGRAM_TOKEN.substring(0,10)+'...' : 'MISSING');
  console.log('  TG_CHAT:', TELEGRAM_CHAT);
  console.log('  ANTHROPIC:', ANTHROPIC_KEY ? 'ok' : 'MISSING');

  // Startup message
  await tg('🚀 <b>OpenClaw Agent v1.1 запущен</b>\n\nМодели: Claude Haiku (хартбит) → Claude Sonnet (стратегия)\nХартбит: каждые 30 мин\nСтратегический анализ: каждые 3 часа\n\nПервый отчёт через несколько секунд...');

  // Run immediately
  await heartbeat();
  setTimeout(analysis, 3 * 60 * 1000); // first analysis after 3 min

  // Schedule
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(analysis, ANALYSIS_MS);
}

main().catch(async e => {
  console.error('Fatal crash:', e);
  await tg('💥 <b>Agent CRASH</b>: ' + e.message);
  process.exit(1);
});
