const express = require('express');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const BOT = {
  ws: null,
  token: process.env.DERIV_TOKEN || null,
  running: false,
  balance: 0,
  lastSig: null,
  openCtr: null,
  trades: [],
  pnl: 0,
  wins: 0,
  losses: 0,
  nTrades: 0,
  SYM: 'R_75',
  rTimer: null,
  // Candle builders
  ticks: [],        // raw ticks
  candles: {
    m5:  [],        // 5min candles
    m15: [],        // 15min candles
    m30: [],        // 30min candles
  },
  currentCandle: {
    m5:  null,
    m15: null,
    m30: null,
  },
};

const TF = { m5: 5*60*1000, m15: 15*60*1000, m30: 30*60*1000 };
const MAX_CANDLES = 50;

// ═══════════════════════════════════════════
//  CANDLE BUILDER
// ═══════════════════════════════════════════
function updateCandles(price, timestamp) {
  for (const tf of ['m5', 'm15', 'm30']) {
    const period = TF[tf];
    const candleTime = Math.floor(timestamp / period) * period;

    if (!BOT.currentCandle[tf] || BOT.currentCandle[tf].time !== candleTime) {
      // Close previous candle
      if (BOT.currentCandle[tf]) {
        BOT.candles[tf].push(BOT.currentCandle[tf]);
        if (BOT.candles[tf].length > MAX_CANDLES) BOT.candles[tf].shift();
      }
      // Open new candle
      BOT.currentCandle[tf] = { time: candleTime, open: price, high: price, low: price, close: price };
    } else {
      // Update current candle
      const c = BOT.currentCandle[tf];
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
    }
  }
}

function getClosePrices(tf) {
  const candles = [...BOT.candles[tf]];
  if (BOT.currentCandle[tf]) candles.push(BOT.currentCandle[tf]);
  return candles.map(c => c.close);
}

// ═══════════════════════════════════════════
//  INDICATORS
// ═══════════════════════════════════════════
function ema(d, n) {
  if (d.length < n) return d[d.length - 1];
  const k = 2 / (n + 1);
  let e = d.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < d.length; i++) e = d[i] * k + e * (1 - k);
  return e;
}

function rsi(d, n = 14) {
  if (d.length < n + 1) return 50;
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
  if (d.length < n) return { upper: 0, lower: 0, middle: 0, pct: 0.5, width: 0 };
  const sl = d.slice(-n);
  const m = sl.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(sl.reduce((a, b) => a + Math.pow(b - m, 2), 0) / n);
  const upper = m + 2 * std;
  const lower = m - 2 * std;
  const last = d[d.length - 1];
  const pct = std === 0 ? 0.5 : (last - lower) / (upper - lower);
  const width = std === 0 ? 0 : (upper - lower) / m * 100;
  return { upper, lower, middle: m, pct: Math.max(0, Math.min(1, pct)), width };
}

function analyzeTimeframe(prices) {
  if (prices.length < 20) return { signal: 'WAIT', score: 0 };
  const last = prices[prices.length - 1];
  const r = rsi(prices);
  const bb = bollinger(prices);
  const e9 = ema(prices, 9);
  const e21 = ema(prices, 21);
  const prev = prices.slice(0, -1);
  const pe9 = ema(prev, 9);
  const pe21 = ema(prev, 21);
  const crossUp = pe9 <= pe21 && e9 > e21;
  const crossDown = pe9 >= pe21 && e9 < e21;

  let buyScore = 0, sellScore = 0;

  // BB
  if (bb.pct < 0.10) buyScore += 40;
  else if (bb.pct < 0.20) buyScore += 25;
  if (bb.pct > 0.90) sellScore += 40;
  else if (bb.pct > 0.80) sellScore += 25;

  // RSI
  if (r < 25) buyScore += 40;
  else if (r < 35) buyScore += 25;
  if (r > 75) sellScore += 40;
  else if (r > 65) sellScore += 25;

  // EMA
  if (crossUp) buyScore += 20;
  else if (e9 > e21 * 1.0001) buyScore += 10;
  if (crossDown) sellScore += 20;
  else if (e9 < e21 * 0.9999) sellScore += 10;

  const score = Math.max(buyScore, sellScore);
  let signal = 'WAIT';
  if (buyScore > sellScore && buyScore >= 50) signal = 'BUY';
  else if (sellScore > buyScore && sellScore >= 50) signal = 'SELL';

  return { signal, score, rsi: r, bb, e9, e21 };
}

// ═══════════════════════════════════════════
//  MULTI-TIMEFRAME CONFLUENCE
//  FIX: Confluence stricte M5+M15+M30 uniquement
//  Suppression de la confluence partielle M15+M30
// ═══════════════════════════════════════════
function analyze() {
  const p5  = getClosePrices('m5');
  const p15 = getClosePrices('m15');
  const p30 = getClosePrices('m30');

  // Need minimum candles on each TF
  if (p5.length < 20 || p15.length < 10 || p30.length < 5) {
    return { signal: 'WAIT', confidence: 0, reason: 'accumulation données...' };
  }

  const tf5  = analyzeTimeframe(p5);
  const tf15 = analyzeTimeframe(p15);
  const tf30 = analyzeTimeframe(p30);

  console.log(`M5:${tf5.signal}(${tf5.score}) M15:${tf15.signal}(${tf15.score}) M30:${tf30.signal}(${tf30.score})`);

  // CONFLUENCE STRICTE: les 3 TF doivent être d'accord — pas d'exception
  const allBuy  = tf5.signal === 'BUY'  && tf15.signal === 'BUY'  && tf30.signal === 'BUY';
  const allSell = tf5.signal === 'SELL' && tf15.signal === 'SELL' && tf30.signal === 'SELL';

  let signal = 'WAIT';
  let confidence = 0;
  let reason = 'pas de confluence';

  if (allBuy) {
    signal = 'BUY';
    confidence = Math.round((tf5.score + tf15.score + tf30.score) / 3);
    reason = `M5+M15+M30 BUY | RSI:${tf5.rsi.toFixed(0)} BB:${(tf5.bb.pct*100).toFixed(0)}%`;
  } else if (allSell) {
    signal = 'SELL';
    confidence = Math.round((tf5.score + tf15.score + tf30.score) / 3);
    reason = `M5+M15+M30 SELL | RSI:${tf5.rsi.toFixed(0)} BB:${(tf5.bb.pct*100).toFixed(0)}%`;
  }

  return { signal, confidence: Math.min(confidence, 96), reason, tf5, tf15, tf30 };
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
  console.log('Starting V75 Multi-TF Bot...');
  BOT.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089&l=EN&brand=deriv');

  BOT.ws.on('open', () => {
    console.log('Connected');
    send({ authorize: BOT.token });
  });

  BOT.ws.on('message', (data) => {
    try {
      const d = JSON.parse(data);
      const t = d.msg_type;
      if (t === 'authorize') onAuth(d);
      else if (t === 'tick') onTick(d.tick);
      else if (t === 'proposal') onProposal(d);
      else if (t === 'buy') onBuy(d);
      else if (t === 'proposal_open_contract') onContract(d);
      else if (t === 'balance' && d.balance) BOT.balance = parseFloat(d.balance.balance);
    } catch(e) {
      console.log('Error:', e.message);
    }
  });

  BOT.ws.on('close', () => {
    console.log('Disconnected — reconnecting in 5s');
    clearTimeout(BOT.rTimer);
    BOT.rTimer = setTimeout(startBot, 5000);
  });

  BOT.ws.on('error', (e) => console.log('WS error:', e.message));
}

function onAuth(d) {
  if (d.error) { console.log('Auth failed:', d.error.message); return; }
  BOT.balance = parseFloat(d.authorize.balance);
  BOT.running = true;
  console.log(`Authorized — $${BOT.balance} — ${d.authorize.loginid}`);
  send({ balance: 1, subscribe: 1 });
  send({ ticks: BOT.SYM, subscribe: 1 });
}

function onTick(tick) {
  if (!tick || tick.quote === undefined || tick.quote === null) return;
  const p = parseFloat(tick.quote);
  if (isNaN(p)) return;

  const ts = tick.epoch ? tick.epoch * 1000 : Date.now();
  updateCandles(p, ts);

  if (!BOT.openCtr) {
    const a = analyze();
    // FIX 1: Suppression du filtre lastSig (plus d'alternance forcée SELL/BUY)
    // FIX 2: Seuil de confiance relevé à 70% minimum
    if (a.signal !== 'WAIT' && a.confidence >= 70) {
      console.log(`TRADE SIGNAL: ${a.signal} | ${a.confidence}% | ${a.reason}`);
      placeTrade(a.signal);
    }
  }
}

function placeTrade(signal) {
  // FIX 3: Risque porté à 3% du solde par trade (au lieu de 2%)
  const stake = parseFloat((BOT.balance * 0.03).toFixed(2));
  if (stake < 0.35) { console.log('Balance too low'); return; }
  BOT.lastSig = signal;
  send({
    proposal: 1,
    contract_type: signal === 'BUY' ? 'CALL' : 'PUT',
    symbol: BOT.SYM,
    duration: 5,
    duration_unit: 'm',
    basis: 'stake',
    amount: stake,
    currency: 'USD',
  });
  console.log(`Placing ${signal} — $${stake}`);
}

function onProposal(d) {
  if (d.error) { console.log('Proposal error:', d.error.message); return; }
  const p = d.proposal;
  if (!p || !p.id) return;
  send({ buy: p.id, price: p.ask_price });
}

function onBuy(d) {
  if (d.error) { console.log('Buy error:', d.error.message); return; }
  const b = d.buy;
  BOT.openCtr = b.contract_id;
  BOT.nTrades++;
  BOT.trades.unshift({
    id: b.contract_id,
    signal: BOT.lastSig,
    price: parseFloat(b.buy_price),
    time: new Date().toISOString(),
    status: 'pending',
    pnl: null,
  });
  if (BOT.trades.length > 20) BOT.trades.pop();
  console.log(`Trade placed — ${BOT.lastSig} — $${b.buy_price}`);
  send({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });
}

function onContract(d) {
  const c = d.proposal_open_contract;
  if (!c) return;
  if (c.status === 'sold' || c.is_expired) {
    const pnl = parseFloat(c.profit || 0);
    BOT.pnl += pnl;
    BOT.openCtr = null;
    if (pnl >= 0) BOT.wins++; else BOT.losses++;
    const t = BOT.trades.find(x => x.id == c.contract_id);
    if (t) { t.status = pnl >= 0 ? 'win' : 'loss'; t.pnl = pnl; }
    console.log(`${pnl >= 0 ? 'WIN' : 'LOSS'} $${Math.abs(pnl).toFixed(2)} | P&L: $${BOT.pnl.toFixed(2)}`);
    if (c.id) send({ forget: c.id });
  }
}

// ═══════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════
app.get('/config', (req, res) => res.json({ token: process.env.DERIV_TOKEN || '' }));

app.get('/status', (req, res) => res.json({
  running: BOT.running,
  symbol: BOT.SYM,
  balance: BOT.balance,
  pnl: parseFloat(BOT.pnl.toFixed(2)),
  wins: BOT.wins,
  losses: BOT.losses,
  nTrades: BOT.nTrades,
  winRate: BOT.nTrades > 0 ? ((BOT.wins / BOT.nTrades) * 100).toFixed(1) + '%' : '--',
  candles: {
    m5: BOT.candles.m5.length,
    m15: BOT.candles.m15.length,
    m30: BOT.candles.m30.length,
  },
  trades: BOT.trades.slice(0, 10),
  lastPrice: BOT.candles.m5.length > 0 ? BOT.candles.m5[BOT.candles.m5.length-1].close : null,
}));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════
//  START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`V75 Multi-TF Bot v2 on port ${PORT}`);
  startBot();
});
