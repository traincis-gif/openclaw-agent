import fetch from 'node-fetch';
import http from 'http';
import fs from 'fs';

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_URL        = process.env.BOT_URL || 'https://polymarket-bot-production-b30b.up.railway.app';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID;
const RAILWAY_TOKEN  = process.env.RAILWAY_TOKEN;
const PROJECT_ID     = '23fef3e7-07bc-402e-8860-ad1f84434598';
const ENV_ID         = 'bd2c6836-e79e-4d71-9a93-e2c352a938b8';
const BOT_SERVICE_ID = 'b112aaad-160a-441a-86f2-318abf82dca5';
const GOOGLE_KEY     = process.env.GOOGLE_API_KEY;
const OPENAI_KEY     = process.env.OPENAI_API_KEY;
const VOICE_MODE     = process.env.VOICE_MODE || 'analysis_only';
const EMERGENCY_LOSS = -20;
const HEARTBEAT_MS   = (parseInt(process.env.HEARTBEAT_INTERVAL_MIN)  || 5)  * 60 * 1000;
const ANALYSIS_MS    = (parseInt(process.env.ANALYSIS_INTERVAL_HOURS) ||  1) * 60 * 60 * 1000;
const PORT           = parseInt(process.env.PORT) || 3001;

// ─── Memory / Self-learning ───────────────────────────────────────────────────
const MEMORY_FILE = '/tmp/agent_memory.json';

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch(e) {}
  return {
    decisions: [],
    patterns:  {},
    mistakes:  [],
    strategy:  { avoidCategories: [], preferCategories: [], notes: [], lastUpdated: null }
  };
}

function saveMemory(mem) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2)); } catch(e) {}
}

function recordSnapshot(s, mem) {
  const snap = { ts: Date.now(), pnl: s.pnl, balance: s.balance, exposure: s.exposure, openCount: s.openCount, mode: s.mode, byCategory: {} };
  for (const t of (s.trades || [])) {
    const cat = t.category || 'unknown';
    if (!snap.byCategory[cat]) snap.byCategory[cat] = { wins:0, losses:0, pnl:0, open:0 };
    if (t.status === 'OPEN') snap.byCategory[cat].open++;
    if (t.pnl !== undefined) {
      if (t.pnl > 0) snap.byCategory[cat].wins++;
      else if (t.pnl < 0) snap.byCategory[cat].losses++;
      snap.byCategory[cat].pnl += t.pnl || 0;
    }
  }
  mem.decisions.push(snap);
  if (mem.decisions.length > 200) mem.decisions = mem.decisions.slice(-200);
  for (const [cat, data] of Object.entries(snap.byCategory)) {
    if (!mem.patterns[cat]) mem.patterns[cat] = { wins:0, losses:0, totalPnl:0, snapshots:0 };
    mem.patterns[cat].wins     += data.wins;
    mem.patterns[cat].losses   += data.losses;
    mem.patterns[cat].totalPnl += data.pnl;
    mem.patterns[cat].snapshots++;
  }
  saveMemory(mem);
  return snap;
}

function buildLearningContext(mem) {
  const catStats = Object.entries(mem.patterns).map(([cat, d]) => {
    const total = d.wins + d.losses;
    const wr = total > 0 ? (d.wins/total*100).toFixed(0) : '?';
    return `  ${cat}: ${d.wins}W/${d.losses}L wr=${wr}% pnl=$${d.totalPnl.toFixed(2)}`;
  }).join('\n') || '  нет данных';
  const pnlTrend = mem.decisions.length >= 2
    ? (mem.decisions[mem.decisions.length-1].pnl - mem.decisions[0].pnl).toFixed(2) : '0';
  return `ИСТОРИЯ (${mem.decisions.length} снапшотов):
По категориям:\n${catStats}
Тренд P&L: ${pnlTrend >= 0?'+':''}$${pnlTrend}
Стратегия: избегать=[${mem.strategy.avoidCategories.join(',')||'нет'}] предпочитать=[${mem.strategy.preferCategories.join(',')||'нет'}]
Ошибки: ${mem.mistakes.slice(-3).join('; ')||'нет'}`;
}

let lastUpdateId = 0, lastHourlyPnl = 0, lastHourlyCheck = Date.now(), errCount = 0;
const mem = loadMemory();

// ─── Gemini Flash с Google Search (бесплатно + интернет) ──────────────────────
async function askGemini(prompt, useSearch = false) {
  if (!GOOGLE_KEY) throw new Error('GOOGLE_API_KEY not set');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GOOGLE_KEY;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1000, temperature: 0.2 }
  };
  // Включаем Google Search grounding для доступа в интернет
  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Gemini ' + r.status + ': ' + (await r.text()).slice(0,200));
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── КЛЮЧЕВАЯ ФУНКЦИЯ: анализ рынка через Gemini + Google Search ─────────────
async function analyseMarketWithGemini(market) {
  const impliedPct = (Number(market.lastPrice || 0.5) * 100).toFixed(1);
  const h = market.hoursLeft || 999;
  const cat = market.category || 'value';

  // Строим промпт с инструкцией что гуглить
  const searchInstructions = {
    sports:   'Search for: current team form, head-to-head record, injury news, lineups for this match',
    politics: 'Search for: latest polls, recent news, current probability estimates for this event',
    esports:  'Search for: team rankings on HLTV or Liquipedia, recent match results, roster changes',
    crypto:   'Search for: current price, recent volatility, market sentiment for this crypto',
    value:    'Search for: current status, recent news, any relevant data for this prediction'
  };

  const prompt = `You are a Polymarket prediction market analyst with internet access.

MARKET: "${market.question}"
Category: ${cat} | Time left: ${h.toFixed(1)}h
Current implied YES probability: ${impliedPct}%
Bid: ${(Number(market.bestBid||0)*100).toFixed(0)}c | Ask: ${(Number(market.bestAsk||1)*100).toFixed(0)}c
Spread: ${(Number(market.spread||0)*100).toFixed(1)}c | Liquidity: $${Number(market.liquidity||0).toFixed(0)} | Vol24h: $${Number(market.volume24h||0).toFixed(0)}

TASK: ${searchInstructions[cat] || searchInstructions.value}

Based on your research:
1. Estimate the TRUE probability of YES resolution
2. Calculate edge = |your_prob - ${impliedPct}%|
3. Only recommend action if edge > 3% (sports/value) or > 4% (politics)

Respond ONLY with valid JSON:
{"action":"BUY_YES|BUY_NO|SKIP","confidence":0.50-0.90,"targetPrice":0.01-0.99,"edgePct":0.0-25.0,"sizingUSDC":2-15,"reasoning":"specific with facts found online","keyFactors":["f1","f2"],"searchedFor":"what you searched"}
`;

  try {
    // useSearch=true — включаем Google Search grounding
    const raw = await askGemini(prompt, true);
    const match = raw.replace(/```json|```/g,'').trim().match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    const json = JSON.parse(match[0]);
    json.edgePct = parseFloat(String(json.edgePct||'0').replace('%','')) || 0;

    const CAT_CAP = { crypto:8, politics:12, esports:8, sports:10, value:6 };
    return {
      ...json,
      category:    cat,
      sizingUSDC:  Math.min(Math.max(json.sizingUSDC||3, 2), CAT_CAP[cat]||8),
      confidence:  Math.min(Math.max(json.confidence||0.6, 0.5), 0.95),
      targetPrice: (() => {
        const raw2 = Math.min(Math.max(Number(json.targetPrice)||0.5, 0.01), 0.99);
        return json.action === 'BUY_NO' ? Math.min(0.94, 1-raw2) : raw2;
      })(),
      model: 'gemini-flash+search'
    };
  } catch(e) {
    console.error('[ANALYSE] Gemini error for market:', market.question?.slice(0,40), e.message);
    return { action:'SKIP', confidence:0.5, targetPrice:0.5, edgePct:0, sizingUSDC:0, reasoning:'Gemini error: '+e.message, model:'error' };
  }
}

// ─── HTTP сервер — эндпоинт /analyse для бота ─────────────────────────────────
function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status:'ok', version:'2.0', model:'gemini-flash+search', memory: mem.decisions.length }));
      return;
    }

    if (req.method === 'POST' && req.url === '/analyse') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { markets } = JSON.parse(body);
          if (!markets?.length) { res.writeHead(400); res.end(JSON.stringify({error:'markets required'})); return; }

          console.log('[HTTP] /analyse request:', markets.length, 'markets');
          const results = [];

          // Анализируем рынки последовательно (rate limit: 15 req/min)
          for (const market of markets) {
            const signal = await analyseMarketWithGemini(market);
            results.push({ conditionId: market.conditionId, signal });
            console.log('[HTTP] analysed:', market.question?.slice(0,40), '→', signal.action, 'edge:', signal.edgePct?.toFixed(1)+'%');
            // Пауза между запросами чтобы не превысить лимит Gemini
            if (markets.length > 1) await new Promise(r => setTimeout(r, 4500));
          }

          res.writeHead(200);
          res.end(JSON.stringify({ results, model:'gemini-flash+search' }));
        } catch(e) {
          console.error('[HTTP] /analyse error:', e.message);
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error:'not found' }));
  });

  server.listen(PORT, () => console.log('[HTTP] Agent server listening on port', PORT));
  return server;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function tg(msg, chatId = TELEGRAM_CHAT) {
  if (!TELEGRAM_TOKEN || !chatId) return;
  try {
    const r = await fetch('https://api.telegram.org/bot'+TELEGRAM_TOKEN+'/sendMessage', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:chatId, text:msg, parse_mode:'HTML' })
    });
    const d = await r.json();
    if (!d.ok) console.error('[TG]',d.description); else console.log('[TG] sent OK');
  } catch(e) { console.error('[TG]',e.message); }
}

async function tgVoice(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT || VOICE_MODE === 'none') return;
  const clean = text.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').trim();
  let audio;
  if (OPENAI_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/audio/speech', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+OPENAI_KEY}, body:JSON.stringify({model:'tts-1',input:clean.substring(0,4096),voice:'nova',response_format:'opus'}) });
      if (r.ok) audio = Buffer.from(await r.arrayBuffer());
    } catch(e) {}
  }
  if (!audio) {
    try {
      const r = await fetch('https://translate.google.com/translate_tts?ie=UTF-8&q='+encodeURIComponent(clean.substring(0,180))+'&tl=ru&client=tw-ob',{headers:{'User-Agent':'Mozilla/5.0'}});
      if (r.ok) audio = Buffer.from(await r.arrayBuffer());
    } catch(e) {}
  }
  if (!audio||audio.length<100) return;
  try {
    const b='----TGV'+Date.now(),C='\r\n';
    const h=Buffer.from('--'+b+C+'Content-Disposition: form-data; name="chat_id"'+C+C+TELEGRAM_CHAT+C+'--'+b+C+'Content-Disposition: form-data; name="voice"; filename="v.ogg"'+C+'Content-Type: audio/ogg'+C+C);
    const f=Buffer.from(C+'--'+b+'--'+C);
    const body=Buffer.concat([h,audio,f]);
    const r=await fetch('https://api.telegram.org/bot'+TELEGRAM_TOKEN+'/sendVoice',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+b,'Content-Length':body.length},body});
    const d=await r.json();
    if(d.ok) console.log('[VOICE] sent OK'); else console.error('[VOICE]',d.description);
  } catch(e) { console.error('[VOICE]',e.message); }
}

async function tgFull(msg, withVoice=false) { await tg(msg); if(withVoice&&VOICE_MODE!=='none') await tgVoice(msg); }

// ─── Telegram polling ─────────────────────────────────────────────────────────
async function pollTelegram() {
  try {
    const r = await fetch('https://api.telegram.org/bot'+TELEGRAM_TOKEN+'/getUpdates?offset='+(lastUpdateId+1)+'&timeout=0&limit=10');
    const d = await r.json();
    if (!d.ok||!d.result?.length) return;
    for (const upd of d.result) {
      lastUpdateId = upd.update_id;
      const msg = upd.message;
      if (!msg||String(msg.chat?.id)!==String(TELEGRAM_CHAT)) continue;
      await handleCommand(msg.text||'', String(msg.chat.id));
    }
  } catch(e) { console.error('[POLL]',e.message); }
}

async function handleCommand(text, chatId) {
  const cmd = text.toLowerCase().trim();
  if (cmd==='/help'||cmd==='помощь') {
    await tg('🤖 <b>OpenClaw Agent v2.0</b>\n\n/status — статус бота\n/positions — позиции\n/report — анализ сейчас\n/memory — что я узнал\n/test [вопрос] — тест Gemini с интернетом\n/stop — остановить\n/start — запустить\n\nИли задай любой вопрос!', chatId);
    return;
  }
  if (cmd==='/status'||cmd==='статус') {
    try {
      const raw = await getBotState(); const s = parseState(raw);
      await tg('📊 <b>Статус</b>\n\n'+(s.running?'✅':'❌')+' '+(s.live?'LIVE 💰':'PAPER 📝')+' | '+s.mode+'\nБаланс: <b>$'+s.balance.toFixed(2)+'</b> | P&L: '+(s.pnl>=0?'+':'')+'$'+s.pnl.toFixed(2)+'\nПозиций: '+s.openCount+' | Экспозиция: $'+s.exposure.toFixed(0)+'/$'+s.maxExp+'\nРынков: '+s.markets.length+' | Скан #'+s.scanCount, chatId);
    } catch(e) { await tg('❌ '+e.message,chatId); }
    return;
  }
  if (cmd==='/positions'||cmd==='позиции') {
    try {
      const raw = await getBotState();
      const trades=(raw.trades||[]).filter(t=>t.status==='OPEN').slice(0,10);
      if (!trades.length) { await tg('📭 Нет открытых позиций',chatId); return; }
      const lines=trades.map(t=>(t.side==='YES'?'🟢':'🔴')+' <b>'+t.side+'</b> '+(t.question||'?').substring(0,40)+'\n   $'+(t.sizeUSDC||0).toFixed(2)+' @ '+((t.price||0)*100).toFixed(0)+'c | '+(t.category||'?'));
      await tg('📋 <b>Позиции ('+trades.length+'):</b>\n\n'+lines.join('\n\n'),chatId);
    } catch(e) { await tg('❌ '+e.message,chatId); }
    return;
  }
  if (cmd==='/memory'||cmd==='память') {
    const m=loadMemory();
    const cats=Object.entries(m.patterns).map(([c,d])=>{ const tot=d.wins+d.losses; return `  ${c}: ${d.wins}W/${d.losses}L ${tot>0?(d.wins/tot*100).toFixed(0):'?'}% $${d.totalPnl.toFixed(2)}`; }).join('\n')||'  нет данных';
    await tg('🧠 <b>Память агента</b>\n\n<b>По категориям:</b>\n'+cats+'\n\n<b>Стратегия:</b>\nИзбегать: '+(m.strategy.avoidCategories.join(', ')||'нет')+'\nПредпочитать: '+(m.strategy.preferCategories.join(', ')||'нет')+'\n\n<b>Ошибки:</b>\n'+(m.mistakes.slice(-3).map(x=>'  • '+x).join('\n')||'нет')+'\n\nСнапшотов: '+m.decisions.length,chatId);
    return;
  }
  if (cmd.startsWith('/test ')||cmd.startsWith('тест ')) {
    const q = text.replace(/^\/test |^тест /i,'');
    await tg('🔍 Гуглю: '+q+'...',chatId);
    try {
      const ans = await askGemini('Answer briefly in Russian: '+q, true);
      await tg('🌐 <b>Gemini+Search:</b>\n\n'+ans.substring(0,3000),chatId);
    } catch(e) { await tg('❌ '+e.message,chatId); }
    return;
  }
  if (cmd==='/stop'||cmd==='стоп') {
    try { await fetch(BOT_URL+'/api/bot/stop',{method:'POST'}); await tg('🛑 Бот остановлен',chatId); } catch(e) { await tg('❌ '+e.message,chatId); }
    return;
  }
  if (cmd==='/start'||cmd==='старт') {
    try { await fetch(BOT_URL+'/api/bot/start',{method:'POST'}); await tg('✅ Бот запущен',chatId); } catch(e) { await tg('❌ '+e.message,chatId); }
    return;
  }
  if (cmd==='/report'||cmd==='отчёт'||cmd==='отчет') {
    await tg('⏳ Запускаю анализ...',chatId); await analysis(); return;
  }
  if (text.length>1&&!text.startsWith('/')) {
    await tg('💬 Думаю...', chatId);
    try {
      const raw=await getBotState(); const s=parseState(raw);
      const ans=await askGemini('Ты ИИ-агент мониторинга Polymarket бота. Отвечай на русском, кратко.\n\nСостояние: '+(s.running?'работает':'остановлен')+' | '+(s.live?'LIVE':'PAPER')+' | '+s.mode+'\nБаланс: $'+s.balance.toFixed(2)+' P&L: $'+s.pnl.toFixed(2)+' Позиций: '+s.openCount+'\n'+buildLearningContext(loadMemory())+'\n\nВопрос: '+text, false);
      await tg(ans.substring(0,4000),chatId);
    } catch(e) { await tg('❌ '+e.message,chatId); }
  }
}

// ─── Bot API ──────────────────────────────────────────────────────────────────
async function getBotState() {
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),10000);
  try { const r=await fetch(BOT_URL+'/api/state',{signal:ctrl.signal}); clearTimeout(t); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
  catch(e) { clearTimeout(t); throw e; }
}

function parseState(s) {
  const pf=s.portfolio||{},st=s.status||{};
  return { running:st.running??false, live:st.liveTrading??false, mode:st.managerDirective?.mode||'unknown', pnl:pf.totalPnl??0, balance:pf.usdcBalance??0, exposure:pf.totalExposureUSDC??0, maxExp:parseFloat(process.env.MAX_TOTAL_EXPOSURE||'100'), openCount:pf.openTrades??0, trades:s.trades||[], markets:s.markets||[], scanCount:st.scanCount??0 };
}

async function setVar(key,val) {
  try { const q='mutation{variableUpsert(input:{projectId:"'+PROJECT_ID+'",environmentId:"'+ENV_ID+'",serviceId:"'+BOT_SERVICE_ID+'",name:"'+key+'",value:"'+val+'"})}'; await fetch('https://backboard.railway.app/graphql/v2',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+RAILWAY_TOKEN},body:JSON.stringify({query:q})}); } catch(e) {}
}

async function redeploy() {
  try { const q='mutation{serviceInstanceRedeploy(environmentId:"'+ENV_ID+'",serviceId:"'+BOT_SERVICE_ID+'")}'; await fetch('https://backboard.railway.app/graphql/v2',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+RAILWAY_TOKEN},body:JSON.stringify({query:q})}); } catch(e) {}
}

// ─── HEARTBEAT (Gemini Flash, бесплатно, без search) ─────────────────────────
async function heartbeat() {
  console.log('[HB] tick', new Date().toISOString());
  let raw;
  try { raw=await getBotState(); errCount=0; }
  catch(e) { errCount++; if(errCount>=3) await tg('🚨 <b>ALERT</b>: Бот недоступен '+errCount+'x\n'+e.message); return; }
  const s=parseState(raw);
  console.log('[HB] running='+s.running+' live='+s.live+' pnl=$'+s.pnl.toFixed(2)+' trades='+s.openCount);
  recordSnapshot(s,mem);
  const now=Date.now();
  if(now-lastHourlyCheck>3600000) {
    const drop=s.pnl-lastHourlyPnl;
    if(drop<EMERGENCY_LOSS) { await fetch(BOT_URL+'/api/bot/stop',{method:'POST'}).catch(()=>{}); await tgFull('🛑 <b>EMERGENCY STOP</b>\nПотеря: $'+drop.toFixed(2),true); mem.mistakes.push('Потеря $'+Math.abs(drop).toFixed(2)+' за час ('+new Date().toISOString().slice(0,10)+')'); saveMemory(mem); }
    lastHourlyPnl=s.pnl; lastHourlyCheck=now;
  }
  if(s.maxExp>0&&s.exposure/s.maxExp>0.85) await tg('⚠️ Высокая экспозиция: $'+s.exposure.toFixed(0)+'/$'+s.maxExp);
  const recent=s.trades.slice(0,3).map(t=>'  '+(t.question||'?').substring(0,35)+': '+((t.pnl||0)>=0?'+':'')+'$'+(t.pnl||0).toFixed(2)).join('\n')||'  нет';
  let summary;
  try {
    summary=await askGemini('Мониторинг Polymarket бота. Краткий отчёт 5-6 строк на русском.\nСтатус: '+(s.running?'работает':'остановлен')+' | '+(s.live?'LIVE':'PAPER')+' | '+s.mode+'\nP&L: $'+s.pnl.toFixed(2)+' | Баланс: $'+s.balance.toFixed(2)+'\nПозиций: '+s.openCount+' | Экспозиция: $'+s.exposure.toFixed(0)+'/$'+s.maxExp+'\nРынков: '+s.markets.length+' | Скан #'+s.scanCount+'\nСделки:\n'+recent+'\n'+buildLearningContext(mem)+'\nНачни с ✅ или ⚠️.', false);
  } catch(e) { summary=(s.running?'✅':'❌')+' '+(s.live?'LIVE':'PAPER')+' | P&L: $'+s.pnl.toFixed(2)+' | Позиций: '+s.openCount; }
  const time=new Date().toLocaleTimeString('ru-RU',{timeZone:'UTC',hour12:false});
  await tgFull('📊 <b>Polymarket — '+time+' UTC</b>\n\n'+summary, VOICE_MODE==='all');
  console.log('[HB] done');
}

// ─── DEEP ANALYSIS (Gemini+Search + самообучение) ─────────────────────────────
async function analysis() {
  console.log('[ANALYSIS] running with Gemini+Search+learning');
  let raw;
  try { raw=await getBotState(); } catch(e) { return; }
  const s=parseState(raw);
  const trades=s.trades, wins=trades.filter(t=>(t.pnl||0)>0);
  const wr=trades.length>0?(wins.length/trades.length*100).toFixed(0):'?';
  const conf=parseFloat(process.env.MIN_CONFIDENCE||'0.65');
  const edge=parseFloat(process.env.MIN_EDGE_PCT||'2');
  const scan=parseInt(process.env.SCAN_INTERVAL_SECONDS||'120');

  let dec;
  try {
    const raw2=await askGemini(
      'Стратегический анализ Polymarket бота + самообучение. ТОЛЬКО JSON без markdown.\n\n'+
      'Состояние: '+(s.running?'работает':'остановлен')+' | '+(s.live?'LIVE':'PAPER')+' | '+s.mode+'\n'+
      'Баланс: $'+s.balance.toFixed(2)+' | P&L: $'+s.pnl.toFixed(2)+' | Позиций: '+s.openCount+'\n'+
      'Параметры: MIN_CONFIDENCE='+conf+' MIN_EDGE_PCT='+edge+' SCAN='+scan+'s\n'+
      'Статистика: '+trades.length+' сделок, win_rate='+wr+'%\n'+
      'Сделки: '+JSON.stringify(trades.slice(0,6).map(t=>({q:(t.question||'?').substring(0,30),cat:t.category,side:t.side,pnl:parseFloat((t.pnl||0).toFixed(2)),status:t.status})))+'\n\n'+
      buildLearningContext(mem)+'\n\n'+
      'ЗАДАЧА: На основе истории определи:\n'+
      '1. Убыточные категории → добавь в avoid\n'+
      '2. Прибыльные категории → добавь в prefer\n'+
      '3. Новые ошибки → зафикисруй\n'+
      '4. Скорректируй параметры\n\n'+
      'JSON: {"new_min_confidence":null,"new_min_edge_pct":null,"new_scan_interval":null,'+
      '"learned_avoid_categories":[],"learned_prefer_categories":[],'+
      '"new_mistake":null,"strategy_notes":"...",'+
      '"reasoning":"1-2 предл.","telegram_report":"6-8 строк с эмодзи","voice_summary":"2-3 предложения"}',
      false
    );
    const m=raw2.match(/\{[\s\S]*\}/);
    dec=m?JSON.parse(m[0]):null;
  } catch(e) { console.error('[ANALYSIS]',e.message); return; }
  if (!dec) return;

  if (dec.learned_avoid_categories?.length>0) { for (const cat of dec.learned_avoid_categories) if(!mem.strategy.avoidCategories.includes(cat)) mem.strategy.avoidCategories.push(cat); }
  if (dec.learned_prefer_categories?.length>0) { for (const cat of dec.learned_prefer_categories) { if(!mem.strategy.preferCategories.includes(cat)) mem.strategy.preferCategories.push(cat); mem.strategy.avoidCategories=mem.strategy.avoidCategories.filter(c=>c!==cat); } }
  if (dec.new_mistake) mem.mistakes.push(dec.new_mistake);
  if (dec.strategy_notes) { mem.strategy.notes.push(dec.strategy_notes); if(mem.strategy.notes.length>20) mem.strategy.notes=mem.strategy.notes.slice(-20); }
  mem.strategy.lastUpdated=new Date().toISOString();
  saveMemory(mem);

  const changes=[];
  if(dec.new_min_confidence!=null) { const v=Math.min(0.85,Math.max(0.50,parseFloat(dec.new_min_confidence))); await setVar('MIN_CONFIDENCE',String(v)); changes.push('MIN_CONFIDENCE: '+conf+'→'+v); }
  if(dec.new_min_edge_pct!=null)   { const v=Math.min(8,Math.max(1,parseFloat(dec.new_min_edge_pct)));         await setVar('MIN_EDGE_PCT',   String(v)); changes.push('MIN_EDGE_PCT: '+edge+'→'+v); }
  if(dec.new_scan_interval!=null)  { const v=Math.min(600,Math.max(60,parseInt(dec.new_scan_interval)));       await setVar('SCAN_INTERVAL_SECONDS',String(v)); changes.push('SCAN: '+scan+'s→'+v+'s'); }
  if(changes.length>0) { await redeploy(); }

  const cs=changes.length>0?'\n\n🔧 <b>Изменено:</b>\n'+changes.map(c=>'  • '+c).join('\n')+'\n♻️ Бот перезапущен':'\n\n✅ Параметры без изменений';
  const learnStr=[dec.learned_avoid_categories?.length>0?'🚫 Избегать: '+dec.learned_avoid_categories.join(', '):null,dec.learned_prefer_categories?.length>0?'⭐ Предпочитать: '+dec.learned_prefer_categories.join(', '):null,dec.new_mistake?'⚠️ Ошибка: '+dec.new_mistake:null].filter(Boolean).join('\n');
  await tg('🧠 <b>Анализ + обучение</b>\n\n'+dec.telegram_report+cs+(learnStr?'\n\n📚 <b>Обучение:</b>\n'+learnStr:''));
  if(VOICE_MODE!=='none') { const vt=(dec.voice_summary||dec.telegram_report.replace(/<[^>]*>/g,'').substring(0,300))+(changes.length>0?' Изменены параметры.':''); await tgVoice(vt); }
  console.log('[ANALYSIS] done');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🦞 OpenClaw Agent v2.0 — Gemini Flash+Search + Hybrid Mode');
  console.log('  HEARTBEAT:', HEARTBEAT_MS/60000, 'мин | ANALYSIS:', ANALYSIS_MS/3600000, 'ч');
  console.log('  GOOGLE:', GOOGLE_KEY?'ok':'MISSING');
  console.log('  PORT:', PORT, '(эндпоинт /analyse для бота)');
  console.log('  MEMORY:', mem.decisions.length, 'снапшотов');

  // Запускаем HTTP сервер для приёма запросов от бота
  startHttpServer();

  await tg('🚀 <b>OpenClaw Agent v2.0</b>\n\n🆓 Gemini Flash (бесплатно + интернет)\n🧠 Самообучение активно\n🔗 Гибридный режим: бот скаутит → агент анализирует\n📊 Память: '+mem.decisions.length+' снапшотов\nХартбит: '+HEARTBEAT_MS/60000+'мин | Анализ: '+ANALYSIS_MS/3600000+'ч\n\n/help — команды');

  try {
    const r=await fetch('https://api.telegram.org/bot'+TELEGRAM_TOKEN+'/getUpdates?limit=1&offset=-1');
    const d=await r.json();
    if(d.result?.length) lastUpdateId=d.result[d.result.length-1].update_id;
  } catch(e) {}

  await heartbeat();
  setTimeout(analysis, 2*60*1000);

  setInterval(pollTelegram, 3000);
  setInterval(heartbeat,    HEARTBEAT_MS);
  setInterval(analysis,     ANALYSIS_MS);
}

main().catch(async e => { console.error('Fatal:',e); await tg('💥 <b>CRASH</b>: '+e.message); process.exit(1); });
