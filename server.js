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
  prices: [],
  lastSig: null,
  openCtr: null,
  trades: [],
  pnl: 0,
  wins: 0,
  losses: 0,
  nTrades: 0,
  SYM: 'R_75',
  MIN: 30,
  MAX: 300,
  rTimer: null,
};

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

// ═══════════════════════════════════════════
//  STRATEGY — Pure V75
//  BB + RSI + EMA crossover
// ═══════════════════════════════════════════
function analyze(data) {
  const last = data[data.length - 1];
  const r = rsi(data);
  const bb = bollinger(data);
  const e9 = ema(data, 9);
  const e21 = ema(data, 21);

  // EMA crossover detection
  const prev = data.slice(0, -1);
  const pe9 = ema(prev, 9);
  const pe21 = ema(prev, 21);
  const crossUp = pe9 <= pe21 && e9 > e21;   // EMA 9 crosses above 21
  const crossDown = pe9 >= pe21 && e9 < e21; // EMA 9 crosses below 21

  let signal = 'WAIT';
  let confidence = 0;
  let reason = 'analyse...';

  // ── BUY CONDITIONS ──
  // Strong: BB lower touch + RSI oversold + EMA cross up
  // Medium: BB lower + RSI oversold
  // Medium: EMA cross up + RSI < 45

  let buyScore = 0;
  if (bb.pct < 0.15) buyScore += 35;       // Prix sur BB inferieure
  else if (bb.pct < 0.25) buyScore += 20;
  if (r < 30) buyScore += 35;              // RSI survente forte
  else if (r < 40) buyScore += 20;
  if (crossUp) buyScore += 20;             // EMA crossover haussier
  else if (e9 > e21) buyScore += 10;       // EMA alignment

  // ── SELL CONDITIONS ──
  let sellScore = 0;
  if (bb.pct > 0.85) sellScore += 35;      // Prix sur BB superieure
  else if (bb.pct > 0.75) sellScore += 20;
  if (r > 70) sellScore += 35;             // RSI surachat fort
  else if (r > 60) sellScore += 20;
  if (crossDown) sellScore += 20;          // EMA crossover baissier
  else if (e9 < e21) sellScore += 10;      // EMA alignment

  confidence = Math.max(buyScore, sellScore);

  // Minimum 55% confidence to trade
  if (buyScore > sellScore && confidence >= 55) {
    signal = 'BUY';
    const reasons = [];
    if (bb.pct < 0.25) reasons.push('BB bas');
    if (r < 40) reasons.push('RSI survente');
    if (crossUp) reasons.push('EMA cross haussier');
    else if (e9 > e21) reasons.push('EMA haussier');
    reason = reasons.join(' + ');
  } else if (sellScore > buyScore && confidence >= 55) {
    signal = 'SELL';
    const reasons = [];
    if (bb.pct > 0.75) reasons.push('BB haut');
    if (r > 60) reasons.push('RSI surachat');
    if (crossDown) reasons.push('EMA cross baissier');
    else if (e9 < e21) reasons.push('EMA baissier');
    reason = reasons.join(' + ');
  }

  return { signal, confidence: Math.min(confidence, 96), last, rsi: r, bb, e9, e21, reason };
}

// ═══════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════
function send(o) {
  if (BOT.ws && BOT.ws.readyState === WebSocket.OPEN) BOT.ws.send(JSON.stringify(o));
}

function startBot() {
  if (!BOT.token) { console.log('No token — bot stopped'); return; }
  if (BOT.ws) { try { BOT.ws.terminate(); } catch(e) {} }
  console.log('Starting V75 Bot...');
  BOT.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089&l=EN&brand=deriv');

  BOT.ws.on('open', () => {
    console.log('Connected to Deriv');
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
      console.log('Message error:', e.message);
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

  BOT.prices.push(p);
  if (BOT.prices.length > BOT.MAX) BOT.prices.shift();

  if (BOT.prices.length >= BOT.MIN && !BOT.openCtr) {
    const a = analyze(BOT.prices);
    if (a.signal !== 'WAIT' && a.signal !== BOT.lastSig) {
      console.log(`Signal: ${a.signal} | Conf: ${a.confidence}% | ${a.reason}`);
      placeTrade(a.signal);
    }
  }
}

function placeTrade(signal) {
  const stake = parseFloat((BOT.balance * 0.02).toFixed(2));
  if (stake < 0.35) { console.log('Balance too low'); return; }
  BOT.lastSig = signal;
  send({
    proposal: 1,
    contract_type: signal === 'BUY' ? 'CALL' : 'PUT',
    symbol: BOT.SYM,
    duration: 3,
    duration_unit: 't',
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
//  API ROUTES
// ═══════════════════════════════════════════
app.get('/config', (req, res) => res.json({ token: process.env.DERIV_TOKEN || '' }));

app.get('/status', (req, res) => res.json({
  running: BOT.running,
  symbol: BOT.SYM,
  balance: BOT.balance,
  pnl: BOT.pnl,
  wins: BOT.wins,
  losses: BOT.losses,
  nTrades: BOT.nTrades,
  winRate: BOT.nTrades > 0 ? ((BOT.wins / BOT.nTrades) * 100).toFixed(1) + '%' : '--',
  trades: BOT.trades.slice(0, 10),
  lastPrice: BOT.prices[BOT.prices.length - 1] || null,
}));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════
//  START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`V75 Bot server on port ${PORT}`);
  startBot();
});
