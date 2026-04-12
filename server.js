const express = require('express');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
//  CONFIG — Modifie ici uniquement
// ═══════════════════════════════════════════
const CONFIG = {
  RISK_PCT:    0.03,   // 3% du solde par trade
  MULTIPLIER:  10,     // x10 sur R_75
  RR_RATIO:    2,      // TP = 2x la mise (RR 1:2)
  COOLDOWN_MS: 5 * 60 * 1000, // 5 min minimum entre deux trades
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
  candles: { m5: [], m15: [], m30: [] },
  currentCandle: { m5: null, m15: null, m30: null },
  lastSignal: null,
};

const TF = { m5: 5*60*1000, m15: 15*60*1000, m30: 30*60*1000 };
const MAX_CANDLES = 60;

// ═══════════════════════════════════════════
//  CANDLE BUILDER
// ═══════════════════════════════════════════
function updateCandles(price, timestamp) {
  for (const tf of ['m5', 'm15', 'm30']) {
    const period = TF[tf];
    const candleTime = Math.floor(timestamp / period) * period;
    if (!BOT.currentCandle[tf] || BOT.currentCandle[tf].time !== candleTime) {
      if (BOT.currentCandle[tf]) {
        BOT.candles[tf].push(BOT.currentCandle[tf]);
        if (BOT.candles[tf].length > MAX_CANDLES) BOT.candles[tf].shift();
      }
      BOT.currentCandle[tf] = { time: candleTime, open: price, high: price, low: price, close: price };
    } else {
      const c = BOT.currentCandle[tf];
      c.high  = Math.max(c.high, price);
      c.low   = Math.min(c.low, price);
      c.close = price;
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

// EMA
function ema(d, n) {
  if (d.length < n) return null;
  const k = 2 / (n + 1);
  let e = d.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < d.length; i++) e = d[i] * k + e * (1 - k);
  return e;
}

// RSI
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

// ATR — mesure la volatilité réelle
function atr(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const trs = [];
  for (let i = candles.length - n; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low  - prev.close)
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// Détection structure marché — Higher High / Lower Low
function marketStructure(candles) {
  if (candles.length < 6) return 'NEUTRAL';
  const recent = candles.slice(-6);
  const highs  = recent.map(c => c.high);
  const lows   = recent.map(c => c.low);
  const hhCount = highs.filter((h, i) => i > 0 && h > highs[i - 1]).length;
  const llCount = lows.filter((l, i)  => i > 0 && l < lows[i - 1]).length;
  if (hhCount >= 3) return 'BULLISH';
  if (llCount >= 3) return 'BEARISH';
  return 'NEUTRAL';
}

// ═══════════════════════════════════════════
//  ANALYSE PAR TIMEFRAME
//  Retourne: 'BUY' | 'SELL' | 'WAIT'
// ═══════════════════════════════════════════

function analyzeM30() {
  const c = getCandles('m30');
  const d = closes('m30');
  if (d.length < 22) return 'WAIT';

  const e9  = ema(d, 9);
  const e21 = ema(d, 21);
  if (!e9 || !e21) return 'WAIT';

  // M30 = direction de tendance uniquement
  if (e9 > e21 * 1.0002) return 'BUY';
  if (e9 < e21 * 0.9998) return 'SELL';
  return 'WAIT';
}

function analyzeM15() {
  const c = getCandles('m15');
  const d = closes('m15');
  if (d.length < 16) return 'WAIT';

  const r   = rsi(d, 14);
  const e9  = ema(d, 9);
  const e21 = ema(d, 21);
  const ms  = marketStructure(c);

  if (!r || !e9 || !e21) return 'WAIT';

  // M15 = confirmation tendance + momentum
  const emaBull = e9 > e21;
  const emaBear = e9 < e21;
  const rsiBull = r > 50 && r < 75;  // momentum haussier sans surachat
  const rsiBear = r < 50 && r > 25;  // momentum baissier sans survente

  if (emaBull && rsiBull && ms !== 'BEARISH') return 'BUY';
  if (emaBear && rsiBear && ms !== 'BULLISH') return 'SELL';
  return 'WAIT';
}

function analyzeM5() {
  const c = getCandles('m5');
  const d = closes('m5');
  if (d.length < 22) return { signal: 'WAIT', atrVal: null };

  const r   = rsi(d, 14);
  const e9  = ema(d, 9);
  const e21 = ema(d, 21);
  const atrVal = atr(c, 14);

  if (!r || !e9 || !e21) return { signal: 'WAIT', atrVal };

  // Bollinger simplifié
  const sl  = d.slice(-20);
  const avg = sl.reduce((a, b) => a + b, 0) / 20;
  const std = Math.sqrt(sl.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / 20);
  const upper = avg + 2 * std;
  const lower = avg - 2 * std;
  const last  = d[d.length - 1];

  // M5 = signal d'entrée précis
  // BUY : prix rebondit du bas des BB + RSI sort de survente + EMA haussière
  const buySignal  = last <= lower * 1.001 && r < 40 && e9 > e21;
  // SELL : prix rejette du haut des BB + RSI sort de surachat + EMA baissière
  const sellSignal = last >= upper * 0.999 && r > 60 && e9 < e21;

  if (buySignal)  return { signal: 'BUY',  atrVal };
  if (sellSignal) return { signal: 'SELL', atrVal };
  return { signal: 'WAIT', atrVal };
}

// ═══════════════════════════════════════════
//  CONFLUENCE FINALE
// ═══════════════════════════════════════════
function analyze() {
  const m30 = analyzeM30();
  const m15 = analyzeM15();
  const m5  = analyzeM5();

  console.log(`M30:${m30} | M15:${m15} | M5:${m5.signal}`);

  // Les 3 TF doivent être alignés
  if (m30 === 'BUY' && m15 === 'BUY' && m5.signal === 'BUY') {
    return { signal: 'BUY',  reason: `M30 tendance BUY | M15 momentum BUY | M5 entrée BB+RSI`, atrVal: m5.atrVal };
  }
  if (m30 === 'SELL' && m15 === 'SELL' && m5.signal === 'SELL') {
    return { signal: 'SELL', reason: `M30 tendance SELL | M15 momentum SELL | M5 entrée BB+RSI`, atrVal: m5.atrVal };
  }

  return { signal: 'WAIT', reason: 'pas de confluence' };
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
  console.log('Starting V75 Bot v5...');
  BOT.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089&l=EN&brand=deriv');

  BOT.ws.on('open', () => {
    console.log('Connected');
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
  console.log(`Authorized — $${BOT.balance}`);
  send({ balance: 1, subscribe: 1 });
  send({ ticks: BOT.SYM, subscribe: 1 });
}

function onTick(tick) {
  if (!tick || tick.quote === undefined) return;
  const p = parseFloat(tick.quote);
  if (isNaN(p)) return;

  const ts = tick.epoch ? tick.epoch * 1000 : Date.now();
  updateCandles(p, ts);

  // Pas de trade si un contrat est déjà ouvert
  if (BOT.openCtr) return;

  // Cooldown entre deux trades
  const now = Date.now();
  if (now - BOT.lastTradeTime < CONFIG.COOLDOWN_MS) return;

  const a = analyze();
  if (a.signal !== 'WAIT') {
    console.log(`✅ SIGNAL: ${a.signal} | ${a.reason}`);
    BOT.lastSignal = a.signal;
    placeTrade(a.signal, a.atrVal);
  }
}

// ═══════════════════════════════════════════
//  PLACE TRADE
// ═══════════════════════════════════════════
function placeTrade(signal, atrVal) {
  const stake = parseFloat((BOT.balance * CONFIG.RISK_PCT).toFixed(2));
  if (stake < 1.00) { console.log('Balance trop faible (min $1)'); return; }

  const stopLoss   = parseFloat(stake.toFixed(2));
  const takeProfit = parseFloat((stake * CONFIG.RR_RATIO).toFixed(2));
  const contractType = signal === 'BUY' ? 'MULTUP' : 'MULTDOWN';

  send({
    proposal: 1,
    amount: stake,
    basis: 'stake',
    contract_type: contractType,
    currency: 'USD',
    symbol: BOT.SYM,
    multiplier: CONFIG.MULTIPLIER,
    limit_order: {
      stop_loss:   stopLoss,
      take_profit: takeProfit,
    },
  });

  console.log(`📤 ${signal} (${contractType}) | Stake:$${stake} | SL:-$${stopLoss} | TP:+$${takeProfit}`);
}

function onProposal(d) {
  if (d.error) {
    console.log('Proposal error:', d.error.message);
    // Si multiplier non supporté, fallback sur Rise/Fall classique
    if (d.error.code === 'ContractBuyValidationError' || d.error.code === 'InvalidContractProposal') {
      console.log('⚠️ Multiplier non disponible sur ce compte — vérifier les permissions Deriv');
    }
    return;
  }
  const p = d.proposal;
  if (!p || !p.id) return;
  send({ buy: p.id, price: p.ask_price });
}

function onBuy(d) {
  if (d.error) { console.log('Buy error:', d.error.message); return; }
  const b = d.buy;
  BOT.openCtr      = b.contract_id;
  BOT.lastTradeTime = Date.now();
  BOT.nTrades++;
  BOT.trades.unshift({
    id:     b.contract_id,
    signal: BOT.lastSignal,
    stake:  parseFloat(b.buy_price),
    time:   new Date().toISOString(),
    status: 'pending',
    pnl:    null,
  });
  if (BOT.trades.length > 20) BOT.trades.pop();
  console.log(`🔵 Trade ouvert #${BOT.nTrades} — ${BOT.lastSignal} — $${b.buy_price}`);
  send({ proposal_open_contract: 1, contract_id: b.contract_id, subscribe: 1 });
}

function onContract(d) {
  const c = d.proposal_open_contract;
  if (!c) return;
  if (c.status === 'sold' || c.is_expired || c.status === 'won' || c.status === 'lost') {
    const pnl = parseFloat(c.profit || 0);
    BOT.pnl    += pnl;
    BOT.openCtr = null;
    if (pnl >= 0) BOT.wins++; else BOT.losses++;
    const t = BOT.trades.find(x => x.id == c.contract_id);
    if (t) { t.status = pnl >= 0 ? 'win' : 'loss'; t.pnl = pnl; }
    const emoji = pnl >= 0 ? '✅ WIN' : '❌ LOSS';
    console.log(`${emoji} $${Math.abs(pnl).toFixed(2)} | P&L: $${BOT.pnl.toFixed(2)} | Winrate: ${((BOT.wins / BOT.nTrades) * 100).toFixed(1)}%`);
    if (c.id) send({ forget: c.id });
  }
}

// ═══════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════
app.get('/status', (req, res) => res.json({
  running:  BOT.running,
  symbol:   BOT.SYM,
  balance:  BOT.balance,
  pnl:      parseFloat(BOT.pnl.toFixed(2)),
  wins:     BOT.wins,
  losses:   BOT.losses,
  nTrades:  BOT.nTrades,
  winRate:  BOT.nTrades > 0 ? ((BOT.wins / BOT.nTrades) * 100).toFixed(1) + '%' : '--',
  config: {
    risk:       `${CONFIG.RISK_PCT * 100}%`,
    multiplier: `x${CONFIG.MULTIPLIER}`,
    rr:         `1:${CONFIG.RR_RATIO}`,
    cooldown:   `${CONFIG.COOLDOWN_MS / 60000} min`,
  },
  candles: {
    m5:  BOT.candles.m5.length,
    m15: BOT.candles.m15.length,
    m30: BOT.candles.m30.length,
  },
  lastSignal: BOT.lastSignal,
  trades:     BOT.trades.slice(0, 10),
  lastPrice:  BOT.candles.m5.length > 0
    ? BOT.candles.m5[BOT.candles.m5.length - 1].close
    : null,
}));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════
//  START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🤖 V75 Bot v5 démarré sur port ${PORT}`);
  console.log(`📊 Config: Risque ${CONFIG.RISK_PCT * 100}% | x${CONFIG.MULTIPLIER} | RR 1:${CONFIG.RR_RATIO} | Cooldown ${CONFIG.COOLDOWN_MS / 60000}min`);
  console.log(`📈 Logique: M30(tendance EMA) + M15(momentum RSI+EMA+structure) + M5(entrée BB+RSI)\n`);
  startBot();
});
