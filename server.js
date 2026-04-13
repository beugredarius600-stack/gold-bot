const express = require('express');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════
const CONFIG = {
  RISK_PCT:       0.03,        // 3% du solde par trade
  DURATION:       5,           // durée contrat en minutes
  COOLDOWN_MS:    3 * 60 * 1000, // 3 min minimum entre trades
  MIN_BALANCE:    0.35,        // solde minimum
};

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const BOT = {
  ws: null,
  token: process.env.DERIV_TOKEN || null,
  running: false,
  balance: 0,
  openCtr: null,
  lastTradeTime: 0,
  trades: [],
  pnl: 0,
  wins: 0,
  losses: 0,
  nTrades: 0,
  SYM: 'R_75',
  rTimer: null,
  candles: { m1: [], m5: [], m15: [], m30: [] },
  currentCandle: { m1: null, m5: null, m15: null, m30: null },
  lastSignal: null,
  lastReason: '',
  lastStrategy: '',
  tickCount: 0,
};

const TF = {
  m1:  1*60*1000,
  m5:  5*60*1000,
  m15: 15*60*1000,
  m30: 30*60*1000,
};
const MAX_CANDLES = 80;

// ═══════════════════════════════════════════
//  CANDLE BUILDER
// ═══════════════════════════════════════════
function updateCandles(price, timestamp) {
  for (const tf of ['m1', 'm5', 'm15', 'm30']) {
    const period    = TF[tf];
    const candleTime = Math.floor(timestamp / period) * period;
    if (!BOT.currentCandle[tf] || BOT.currentCandle[tf].time !== candleTime) {
      if (BOT.currentCandle[tf]) {
        BOT.candles[tf].push(BOT.currentCandle[tf]);
        if (BOT.candles[tf].length > MAX_CANDLES) BOT.candles[tf].shift();
      }
      BOT.currentCandle[tf] = { time: candleTime, open: price, high: price, low: price, close: price };
    } else {
      const c  = BOT.currentCandle[tf];
      c.high   = Math.max(c.high, price);
      c.low    = Math.min(c.low, price);
      c.close  = price;
    }
  }
}

function getCandles(tf) {
  const arr = [...BOT.candles[tf]];
  if (BOT.currentCandle[tf]) arr.push(BOT.currentCandle[tf]);
  return arr;
}
function closes(tf) { return getCandles(tf).map(c => c.close); }

// ═══════════════════════════════════════════
//  INDICATEURS
// ═══════════════════════════════════════════
function ema(d, n) {
  if (d.length < n) return null;
  const k = 2 / (n + 1);
  let e = d.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < d.length; i++) e = d[i] * k + e * (1 - k);
  return e;
}

function rsi(d, n = 14) {
  if (d.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = d.length - n; i < d.length; i++) {
    const df = d[i] - d[i - 1];
    if (df > 0) g += df; else l -= df;
  }
  const ag = g / n, al = l / n;
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

function bollinger(d, n = 20) {
  if (d.length < n) return null;
  const sl  = d.slice(-n);
  const avg = sl.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(sl.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / n);
  return {
    upper:  avg + 2 * std,
    lower:  avg - 2 * std,
    middle: avg,
    std,
    pct: std === 0 ? 0.5 : (d[d.length - 1] - (avg - 2*std)) / (4 * std),
  };
}

function macd(d) {
  const fast = ema(d, 12);
  const slow = ema(d, 26);
  if (!fast || !slow) return null;
  const line     = fast - slow;
  const prevFast = ema(d.slice(0, -1), 12);
  const prevSlow = ema(d.slice(0, -1), 26);
  if (!prevFast || !prevSlow) return null;
  const prevLine = prevFast - prevSlow;
  return { line, prevLine, cross: Math.sign(line) !== Math.sign(prevLine) };
}

// Momentum court terme — vitesse du prix
function momentum(d, n = 5) {
  if (d.length < n + 1) return null;
  return d[d.length - 1] - d[d.length - 1 - n];
}

// Volatilité récente
function volatility(d, n = 10) {
  if (d.length < n) return null;
  const sl   = d.slice(-n);
  const avg  = sl.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(sl.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / n) / avg * 100;
}

// Tendance par régression linéaire simple
function trendSlope(d, n = 10) {
  if (d.length < n) return null;
  const sl = d.slice(-n);
  const xi = [...Array(n).keys()];
  const xm = (n - 1) / 2;
  const ym = sl.reduce((a, b) => a + b, 0) / n;
  const num = xi.reduce((s, x, i) => s + (x - xm) * (sl[i] - ym), 0);
  const den = xi.reduce((s, x) => s + Math.pow(x - xm, 2), 0);
  return den === 0 ? 0 : num / den;
}

// ═══════════════════════════════════════════
//  STRATÉGIES MULTIPLES
//  Chaque stratégie est indépendante
//  Le bot choisit la plus convaincante
// ═══════════════════════════════════════════

// STRATÉGIE 1 — Suivi de tendance EMA multi-TF
function stratTrend() {
  const d5  = closes('m5');
  const d15 = closes('m15');
  const d30 = closes('m30');
  if (d5.length < 10 || d15.length < 10 || d30.length < 10) return null;

  const e9_5   = ema(d5, 9);
  const e21_5  = ema(d5, 21);
  const e9_15  = ema(d15, 9);
  const e21_15 = ema(d15, 21);
  const e9_30  = ema(d30, 9);
  const e21_30 = ema(d30, 21);

  if (!e9_5 || !e21_5 || !e9_15 || !e21_15 || !e9_30 || !e21_30) return null;

  let score = 0;
  if (e9_5  > e21_5)  score++;
  if (e9_15 > e21_15) score++;
  if (e9_30 > e21_30) score++;

  if (score >= 2) return { signal: 'BUY',  strength: score, reason: `Trend BUY  (${score}/3 TF alignés)` };

  score = 0;
  if (e9_5  < e21_5)  score++;
  if (e9_15 < e21_15) score++;
  if (e9_30 < e21_30) score++;

  if (score >= 2) return { signal: 'SELL', strength: score, reason: `Trend SELL (${score}/3 TF alignés)` };
  return null;
}

// STRATÉGIE 2 — Rebond RSI extrême sur M5+M15
function stratRSIReversal() {
  const d5  = closes('m5');
  const d15 = closes('m15');
  if (d5.length < 15 || d15.length < 15) return null;

  const r5  = rsi(d5);
  const r15 = rsi(d15);
  if (!r5 || !r15) return null;

  // Survente sur les deux TF → rebond probable
  if (r5 < 35 && r15 < 40) return { signal: 'BUY',  strength: 2, reason: `RSI Reversal BUY  (M5:${r5.toFixed(0)} M15:${r15.toFixed(0)})` };
  // Surachat sur les deux TF → retournement probable
  if (r5 > 65 && r15 > 60) return { signal: 'SELL', strength: 2, reason: `RSI Reversal SELL (M5:${r5.toFixed(0)} M15:${r15.toFixed(0)})` };
  return null;
}

// STRATÉGIE 3 — Breakout Bollinger sur M5
function stratBollingerBreakout() {
  const d5 = closes('m5');
  if (d5.length < 22) return null;

  const bb  = bollinger(d5);
  const r5  = rsi(d5);
  const d15 = closes('m15');
  const r15 = rsi(d15);
  if (!bb || !r5 || !r15) return null;

  const last = d5[d5.length - 1];
  const prev = d5[d5.length - 2];

  // Prix casse le bas des BB + RSI confirme survente
  if (prev < bb.lower && last > bb.lower && r5 < 45) {
    return { signal: 'BUY',  strength: 2, reason: `BB Breakout BUY  (prix sort du bas | RSI:${r5.toFixed(0)})` };
  }
  // Prix casse le haut des BB + RSI confirme surachat
  if (prev > bb.upper && last < bb.upper && r5 > 55) {
    return { signal: 'SELL', strength: 2, reason: `BB Breakout SELL (prix sort du haut | RSI:${r5.toFixed(0)})` };
  }
  return null;
}

// STRATÉGIE 4 — MACD crossover + momentum
function stratMACD() {
  const d5  = closes('m5');
  const d15 = closes('m15');
  if (d5.length < 30 || d15.length < 30) return null;

  const mc5  = macd(d5);
  const mc15 = macd(d15);
  const mom  = momentum(d5, 5);
  if (!mc5 || !mc15 || mom === null) return null;

  // Croisement haussier MACD sur M5 + M15 confirme
  if (mc5.line > 0 && mc15.line > 0 && mom > 0) {
    return { signal: 'BUY',  strength: 2, reason: `MACD BUY  (ligne positive + momentum haussier)` };
  }
  // Croisement baissier MACD sur M5 + M15 confirme
  if (mc5.line < 0 && mc15.line < 0 && mom < 0) {
    return { signal: 'SELL', strength: 2, reason: `MACD SELL (ligne négative + momentum baissier)` };
  }
  return null;
}

// STRATÉGIE 5 — Pente de tendance court terme
function stratSlope() {
  const d1 = closes('m1');
  const d5 = closes('m5');
  if (d1.length < 12 || d5.length < 12) return null;

  const slope1 = trendSlope(d1, 10);
  const slope5 = trendSlope(d5, 10);
  const r5     = rsi(d5);
  if (slope1 === null || slope5 === null || !r5) return null;

  // Les deux pentes montantes + RSI neutre = momentum haussier clair
  if (slope1 > 0 && slope5 > 0 && r5 > 45 && r5 < 75) {
    return { signal: 'BUY',  strength: 2, reason: `Slope BUY  (M1+M5 en hausse | RSI:${r5.toFixed(0)})` };
  }
  if (slope1 < 0 && slope5 < 0 && r5 < 55 && r5 > 25) {
    return { signal: 'SELL', strength: 2, reason: `Slope SELL (M1+M5 en baisse | RSI:${r5.toFixed(0)})` };
  }
  return null;
}

// ═══════════════════════════════════════════
//  MOTEUR DE DÉCISION
//  Vote entre toutes les stratégies
// ═══════════════════════════════════════════
function analyze() {
  const strategies = [
    { name: 'Trend',    result: stratTrend() },
    { name: 'RSI',      result: stratRSIReversal() },
    { name: 'BB',       result: stratBollingerBreakout() },
    { name: 'MACD',     result: stratMACD() },
    { name: 'Slope',    result: stratSlope() },
  ];

  let buyVotes = 0, sellVotes = 0;
  let buyReasons  = [];
  let sellReasons = [];
  let usedStrat   = [];

  for (const s of strategies) {
    if (!s.result) continue;
    if (s.result.signal === 'BUY') {
      buyVotes  += s.result.strength;
      buyReasons.push(s.result.reason);
      usedStrat.push(s.name);
    } else if (s.result.signal === 'SELL') {
      sellVotes  += s.result.strength;
      sellReasons.push(s.result.reason);
      usedStrat.push(s.name);
    }
  }

  const log = `VOTES → BUY:${buyVotes} SELL:${sellVotes}`;
  BOT.lastReason = log;
  console.log(log);

  // Seuil minimum : 2 votes dans le même sens
  // Et les votes dans le sens opposé ne doivent pas être trop forts
  if (buyVotes >= 2 && buyVotes > sellVotes) {
    BOT.lastStrategy = usedStrat.join('+');
    return {
      signal:  'BUY',
      reason:  buyReasons.join(' | '),
      votes:   buyVotes,
    };
  }
  if (sellVotes >= 2 && sellVotes > buyVotes) {
    BOT.lastStrategy = usedStrat.join('+');
    return {
      signal:  'SELL',
      reason:  sellReasons.join(' | '),
      votes:   sellVotes,
    };
  }

  return { signal: 'WAIT', reason: log };
}

// ═══════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════
function send(o) {
  if (BOT.ws && BOT.ws.readyState === WebSocket.OPEN) BOT.ws.send(JSON.stringify(o));
}

function startBot() {
  if (!BOT.token) { console.log('No token'); return; }
  if (BOT.ws) { try { BOT.ws.terminate(); } catch(e) {} }
  console.log('🤖 V75 Bot v7 starting...');
  BOT.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089&l=EN&brand=deriv');

  BOT.ws.on('open', () => {
    console.log('✅ Connected');
    send({ authorize: BOT.token });
  });

  BOT.ws.on('message', (data) => {
    try {
      const d = JSON.parse(data);
      const t = d.msg_type;
      if (t === 'authorize')                   onAuth(d);
      else if (t === 'tick')                   onTick(d.tick);
      else if (t === 'proposal')               onProposal(d);
      else if (t === 'buy')                    onBuy(d);
      else if (t === 'proposal_open_contract') onContract(d);
      else if (t === 'balance' && d.balance)   BOT.balance = parseFloat(d.balance.balance);
    } catch(e) {
      console.log('Error:', e.message);
    }
  });

  BOT.ws.on('close', () => {
    console.log('Disconnected — reconnect 5s');
    clearTimeout(BOT.rTimer);
    BOT.rTimer = setTimeout(startBot, 5000);
  });

  BOT.ws.on('error', (e) => console.log('WS error:', e.message));
}

function onAuth(d) {
  if (d.error) { console.log('Auth failed:', d.error.message); return; }
  BOT.balance = parseFloat(d.authorize.balance);
  BOT.running = true;
  console.log(`✅ Authorized — Balance: $${BOT.balance}`);
  send({ balance: 1, subscribe: 1 });
  send({ ticks: BOT.SYM, subscribe: 1 });
}

function onTick(tick) {
  if (!tick || tick.quote === undefined) return;
  const p = parseFloat(tick.quote);
  if (isNaN(p)) return;

  BOT.tickCount++;
  const ts = tick.epoch ? tick.epoch * 1000 : Date.now();
  updateCandles(p, ts);

  if (BOT.openCtr) return;

  const now = Date.now();
  if (now - BOT.lastTradeTime < CONFIG.COOLDOWN_MS) return;

  // Analyser à chaque tick
  const a = analyze();

  if (a.signal !== 'WAIT') {
    console.log(`🚀 TRADE: ${a.signal} | votes:${a.votes} | ${a.reason}`);
    BOT.lastSignal = a.signal;
    placeTrade(a.signal);
  }
}

function placeTrade(signal) {
  const stake = parseFloat((BOT.balance * CONFIG.RISK_PCT).toFixed(2));
  if (stake < CONFIG.MIN_BALANCE) {
    console.log('❌ Balance trop faible');
    return;
  }

  // Durée variable — rend le bot imprévisible pour l'algo Deriv
  const durations  = [3, 4, 5, 6, 7];
  const duration   = durations[Math.floor(Math.random() * durations.length)];

  send({
    proposal: 1,
    contract_type: signal === 'BUY' ? 'CALL' : 'PUT',
    symbol: BOT.SYM,
    duration,
    duration_unit: 'm',
    basis: 'stake',
    amount: stake,
    currency: 'USD',
  });

  console.log(`📤 ${signal} | Stake:$${stake} | Durée:${duration}min`);
}

function onProposal(d) {
  if (d.error) {
    console.log('❌ Proposal error:', d.error.code, '-', d.error.message);
    return;
  }
  const p = d.proposal;
  if (!p || !p.id) return;
  send({ buy: p.id, price: p.ask_price });
}

function onBuy(d) {
  if (d.error) { console.log('❌ Buy error:', d.error.message); return; }
  const b = d.buy;
  BOT.openCtr       = b.contract_id;
  BOT.lastTradeTime = Date.now();
  BOT.nTrades++;
  BOT.trades.unshift({
    id:       b.contract_id,
    signal:   BOT.lastSignal,
    strategy: BOT.lastStrategy,
    stake:    parseFloat(b.buy_price),
    time:     new Date().toISOString(),
    status:   'pending',
    pnl:      null,
  });
  if (BOT.trades.length > 20) BOT.trades.pop();
  console.log(`🔵 Trade #${BOT.nTrades} | ${BOT.lastSignal} | strat:${BOT.lastStrategy} | $${b.buy_price}`);
  send({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });
}

function onContract(d) {
  const c = d.proposal_open_contract;
  if (!c) return;
  if (c.status === 'sold' || c.is_expired) {
    const pnl = parseFloat(c.profit || 0);
    BOT.pnl    += pnl;
    BOT.openCtr = null;
    if (pnl >= 0) BOT.wins++; else BOT.losses++;
    const t = BOT.trades.find(x => x.id == c.contract_id);
    if (t) { t.status = pnl >= 0 ? 'win' : 'loss'; t.pnl = pnl; }
    const emoji = pnl >= 0 ? '✅ WIN' : '❌ LOSS';
    console.log(`${emoji} $${Math.abs(pnl).toFixed(2)} | Total P&L: $${BOT.pnl.toFixed(2)} | Winrate: ${((BOT.wins / BOT.nTrades) * 100).toFixed(1)}%`);
    if (c.id) send({ forget: c.id });
  }
}

// ═══════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════
app.get('/status', (req, res) => res.json({
  running:      BOT.running,
  symbol:       BOT.SYM,
  balance:      BOT.balance,
  pnl:          parseFloat(BOT.pnl.toFixed(2)),
  wins:         BOT.wins,
  losses:       BOT.losses,
  nTrades:      BOT.nTrades,
  winRate:      BOT.nTrades > 0 ? ((BOT.wins / BOT.nTrades) * 100).toFixed(1) + '%' : '--',
  lastSignal:   BOT.lastSignal,
  lastStrategy: BOT.lastStrategy,
  lastReason:   BOT.lastReason,
  tickCount:    BOT.tickCount,
  candles: {
    m1:  BOT.candles.m1.length,
    m5:  BOT.candles.m5.length,
    m15: BOT.candles.m15.length,
    m30: BOT.candles.m30.length,
  },
  trades: BOT.trades.slice(0, 10),
  lastPrice: BOT.candles.m1.length > 0
    ? BOT.candles.m1[BOT.candles.m1.length - 1].close
    : null,
}));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🤖 V75 Bot v7 — port ${PORT}`);
  console.log(`📊 Risk:${CONFIG.RISK_PCT*100}% | Cooldown:${CONFIG.COOLDOWN_MS/60000}min`);
  console.log(`🧠 Stratégies: Trend + RSI Reversal + BB Breakout + MACD + Slope\n`);
  startBot();
});
