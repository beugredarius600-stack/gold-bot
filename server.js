const express = require('express');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  SYM: 'frxXAUUSD',
  MIN: 25,
  MAX: 300,
  rTimer: null,
};

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

function atr(d, n = 14) {
  if (d.length < n + 1) return d[d.length - 1] * 0.001;
  let s = 0;
  for (let i = d.length - n; i < d.length; i++) s += Math.abs(d[i] - d[i - 1]);
  return s / n;
}

function priceAction(d) {
  if (d.length < 10) return { bias: 'neutral' };
  const recent = d.slice(-20);
  const n = recent.length;
  let highs = [], lows = [];
  for (let i = 1; i < n - 1; i++) {
    if (recent[i] > recent[i-1] && recent[i] > recent[i+1]) highs.push(recent[i]);
    if (recent[i] < recent[i-1] && recent[i] < recent[i+1]) lows.push(recent[i]);
  }
  const last = d[d.length - 1];
  let bias = 'neutral';
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length-1] > highs[highs.length-2];
    const hl = lows[lows.length-1] > lows[lows.length-2];
    const lh = highs[highs.length-1] < highs[highs.length-2];
    const ll = lows[lows.length-1] < lows[lows.length-2];
    if (hh && hl) bias = 'buy';
    else if (lh && ll) bias = 'sell';
  }
  if (d.length >= 15) {
    const prevMax = Math.max(...d.slice(-15, -5));
    const prevMin = Math.min(...d.slice(-15, -5));
    if (last > prevMax * 1.0002) bias = 'buy';
    else if (last < prevMin * 0.9998) bias = 'sell';
  }
  return { bias };
}

function fibonacci(d) {
  if (d.length < 20) return { nearLevel: null, bias: 'neutral' };
  const slice = d.slice(-50);
  const high = Math.max(...slice);
  const low = Math.min(...slice);
  const range = high - low;
  const last = d[d.length - 1];
  const levels = {};
  for (const r of [0, 0.236, 0.382, 0.5, 0.618, 1.0]) levels[r] = high - range * r;
  const tolerance = atr(d) * 1.5;
  let nearLevel = null, bias = 'neutral';
  for (const r of [0.382, 0.5, 0.618]) {
    if (Math.abs(last - levels[r]) < tolerance) {
      nearLevel = r;
      bias = last > ema(d, 20) ? 'buy' : 'sell';
      break;
    }
  }
  return { nearLevel, bias };
}

function analyze(data) {
  const last = data[data.length - 1];
  const r = rsi(data);
  const e20 = ema(data, 20), e50 = ema(data, 50), e200 = ema(data, 200);
  const atrVal = atr(data);
  const pa = priceAction(data);
  const fib = fibonacci(data);
  let bs = 0, ss = 0, reasons = [];

  const emaBull = last > e20 && e20 > e50;
  const emaBear = last < e20 && e20 < e50;
  if (emaBull && e50 > e200) { bs += 3; reasons.push('EMA triple haussier'); }
  else if (emaBull) bs += 1.8;
  else if (emaBear && e50 < e200) { ss += 3; reasons.push('EMA triple baissier'); }
  else if (emaBear) ss += 1.8;

  if (r < 35) { bs += 2; reasons.push('RSI survente'); }
  else if (r < 45 && emaBull) bs += 1;
  else if (r > 65) { ss += 2; reasons.push('RSI surachat'); }
  else if (r > 55 && emaBear) ss += 1;

  if (pa.bias === 'buy') bs += 2.5;
  else if (pa.bias === 'sell') ss += 2.5;

  if (fib.nearLevel) {
    if (fib.bias === 'buy') { bs += 2; reasons.push(`Fib ${Math.round(fib.nearLevel*100)}% support`); }
    else if (fib.bias === 'sell') { ss += 2; reasons.push(`Fib ${Math.round(fib.nearLevel*100)}% resistance`); }
  }

  const relAtr = atrVal / last * 100;
  if (relAtr <= 0.005) { bs *= 0.5; ss *= 0.5; }

  const conf = Math.min(Math.max(bs, ss) / 11.5 * 100, 96);
  let signal = 'WAIT';
  if (bs > ss && conf >= 45) signal = 'BUY';
  else if (ss > bs && conf >= 45) signal = 'SELL';

  return { signal, confidence: conf, last, rsi: r, reason: reasons.slice(0,2).join(' + ') || 'analyse...' };
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = now.getUTCHours();
  return h >= 0 && h < 21;
}

function send(o) {
  if (BOT.ws && BOT.ws.readyState === WebSocket.OPEN) BOT.ws.send(JSON.stringify(o));
}

function startBot() {
  if (!BOT.token) { console.log('No token — bot stopped'); return; }
  if (BOT.ws) { try { BOT.ws.terminate(); } catch(e) {} }
  console.log('Starting Gold Bot...');
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

  BOT.ws.on('error', (e) => {
    console.log('WS error:', e.message);
  });
}

function onAuth(d) {
  if (d.error) { console.log('Auth failed:', d.error.message); return; }
  BOT.balance = parseFloat(d.authorize.balance);
  BOT.running = true;
  console.log(`Authorized — Balance: $${BOT.balance} — Account: ${d.authorize.loginid}`);
  send({ balance: 1, subscribe: 1 });
  send({ ticks: BOT.SYM, subscribe: 1 });
}

function onTick(tick) {
  // Guard against empty tick (market closed)
  if (!tick || tick.quote === undefined || tick.quote === null) return;
  const p = parseFloat(tick.quote);
  if (isNaN(p)) return;

  BOT.prices.push(p);
  if (BOT.prices.length > BOT.MAX) BOT.prices.shift();

  if (BOT.prices.length >= BOT.MIN && !BOT.openCtr && isMarketOpen()) {
    const a = analyze(BOT.prices);
    if (a.signal !== 'WAIT' && a.confidence >= 45 && a.signal !== BOT.lastSig) {
      console.log(`Signal: ${a.signal} | ${a.confidence.toFixed(0)}% | ${a.reason}`);
      placeTrade(a.signal);
    }
  }
}

function placeTrade(signal) {
  const stake = parseFloat((BOT.balance * 0.02).toFixed(2));
  if (stake < 1) { console.log('Balance too low'); return; }
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

app.get('/config', (req, res) => res.json({ token: process.env.DERIV_TOKEN || '' }));

app.get('/status', (req, res) => res.json({
  running: BOT.running,
  balance: BOT.balance,
  pnl: BOT.pnl,
  wins: BOT.wins,
  losses: BOT.losses,
  nTrades: BOT.nTrades,
  trades: BOT.trades.slice(0, 10),
  marketOpen: isMarketOpen(),
  lastPrice: BOT.prices[BOT.prices.length - 1] || null,
}));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startBot();
});
