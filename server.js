const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════
const CONFIG = {
  LOGIN:         '201259685',
  PASSWORD:      process.env.MT5_PASSWORD,       // variable Render
  SERVER:        'Deriv-Demo',          // Access Server: Ireland, Hedge
  SYMBOL:        'Volatility 75 Index',          // nom exact MT5 Deriv
  RISK_PCT:      0.02,                           // 2% par trade
  SL_PIPS:       50,                             // Stop Loss en points
  TP_RATIO:      2,                              // TP = 2 × SL
  COOLDOWN_MS:   5 * 60 * 1000,                  // 5 min entre trades
  LOSS_PAUSE_MS: 30 * 60 * 1000,                 // pause 30 min
  MAX_LOSSES:    2,                              // max pertes consécutives
  LOT_MIN:       0.01,
};

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const BOT = {
  ws:            null,
  authorized:    false,
  balance:       0,
  openOrder:     null,
  lastTradeTime: 0,
  lossStreak:    0,
  pauseUntil:    0,
  pnl:           0,
  wins:          0,
  losses:        0,
  nTrades:       0,
  lastSignal:    null,
  lastReason:    '',
  trades:        [],
  rTimer:        null,
  reqId:         1,
  pending:       {},
  candles:       { m1: [], m5: [], m15: [] },
  current:       { m1: null, m5: null, m15: null },
};

const TF       = { m1: 60000, m5: 300000, m15: 900000 };
const MAX_BARS = 150;

// ═══════════════════════════════════════════
//  WEBSOCKET HELPERS
// ═══════════════════════════════════════════
function nextId() { return BOT.reqId++; }

function send(obj) {
  if (BOT.ws && BOT.ws.readyState === WebSocket.OPEN) {
    BOT.ws.send(JSON.stringify(obj));
  }
}

function sendReq(obj) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    obj.req_id = id;
    BOT.pending[id] = { resolve, reject };
    send(obj);
    setTimeout(() => {
      if (BOT.pending[id]) {
        delete BOT.pending[id];
        reject(new Error('Timeout req ' + id));
      }
    }, 15000);
  });
}

// ═══════════════════════════════════════════
//  CANDLE BUILDER
// ═══════════════════════════════════════════
function updateCandles(price, timestamp) {
  for (const tf of ['m1', 'm5', 'm15']) {
    const p = TF[tf];
    const t = Math.floor(timestamp / p) * p;
    if (!BOT.current[tf] || BOT.current[tf].time !== t) {
      if (BOT.current[tf]) {
        BOT.candles[tf].push(BOT.current[tf]);
        if (BOT.candles[tf].length > MAX_BARS) BOT.candles[tf].shift();
      }
      BOT.current[tf] = { time: t, open: price, high: price, low: price, close: price };
    } else {
      const c = BOT.current[tf];
      c.high  = Math.max(c.high, price);
      c.low   = Math.min(c.low, price);
      c.close = price;
    }
  }
}

function getCloses(tf) {
  return [...BOT.candles[tf], BOT.current[tf]].filter(Boolean).map(c => c.close);
}

function getCandles(tf) {
  return [...BOT.candles[tf], BOT.current[tf]].filter(Boolean);
}

// ═══════════════════════════════════════════
//  INDICATEURS
// ═══════════════════════════════════════════
function rsi(d, n = 14) {
  if (d.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = d.length - n; i < d.length; i++) {
    const df = d[i] - d[i - 1];
    df > 0 ? g += df : l -= df;
  }
  const ag = g / n, al = l / n;
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

// ═══════════════════════════════════════════
//  PRICE ACTION PURE
// ═══════════════════════════════════════════
function marketStructure() {
  const c = getCandles('m5');
  if (c.length < 10) return null;
  const recent = c.slice(-10);
  const highs  = recent.map(x => x.high);
  const lows   = recent.map(x => x.low);
  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll  = lows[lows.length - 1]  < Math.min(...lows.slice(0, -1));
  const lh  = highs[highs.length - 1] < Math.max(...highs.slice(0, -1));
  const hl  = lows[lows.length - 1]  > Math.min(...lows.slice(0, -1));
  if (hh && hl) return 'BULLISH';
  if (ll && lh) return 'BEARISH';
  return 'NEUTRAL';
}

function keyLevels() {
  const c = getCandles('m5');
  if (c.length < 20) return null;
  const recent     = c.slice(-20);
  const resistance = Math.max(...recent.map(x => x.high));
  const support    = Math.min(...recent.map(x => x.low));
  const price      = recent[recent.length - 1].close;
  return { resistance, support, price };
}

function candleConfirm(direction) {
  const c = getCandles('m1');
  if (c.length < 2) return false;
  const last = c[c.length - 1];
  const prev = c[c.length - 2];
  if (direction === 'BUY')  return last.close > last.open && last.close > prev.close;
  if (direction === 'SELL') return last.close < last.open && last.close < prev.close;
  return false;
}

function getSignal() {
  const m5closes = getCloses('m5');
  if (m5closes.length < 20) {
    BOT.lastReason = `Chauffe... M5: ${m5closes.length}/20 bougies`;
    return null;
  }
  const structure = marketStructure();
  const levels    = keyLevels();
  const r         = rsi(m5closes);

  if (!structure || !levels || !r) return null;
  if (structure === 'NEUTRAL') {
    BOT.lastReason = 'Structure NEUTRAL — pas de signal';
    return null;
  }

  const { resistance, support, price } = levels;
  const rangeSize = resistance - support;
  if (rangeSize <= 0) return null;

  const pricePos = (price - support) / rangeSize * 100;

  if (structure === 'BULLISH' && pricePos < 40 && r < 70 && candleConfirm('BUY')) {
    return { signal: 'BUY', reason: `PA BUY | BULLISH | Pos:${pricePos.toFixed(0)}% | RSI:${r.toFixed(0)}` };
  }

  if (structure === 'BEARISH' && pricePos > 60 && r > 30 && candleConfirm('SELL')) {
    return { signal: 'SELL', reason: `PA SELL | BEARISH | Pos:${pricePos.toFixed(0)}% | RSI:${r.toFixed(0)}` };
  }

  BOT.lastReason = `Structure:${structure} | Pos:${pricePos.toFixed(0)}% | RSI:${r ? r.toFixed(0) : '--'} — attente setup`;
  return null;
}

// ═══════════════════════════════════════════
//  CALCUL LOT
// ═══════════════════════════════════════════
function calcLot(price) {
  const riskAmount = BOT.balance * CONFIG.RISK_PCT;
  const slAmount   = (CONFIG.SL_PIPS / 100) * price;
  let lot = riskAmount / slAmount;
  lot = Math.max(CONFIG.LOT_MIN, parseFloat(lot.toFixed(2)));
  return lot;
}

// ═══════════════════════════════════════════
//  PLACER ORDRE MT5
// ═══════════════════════════════════════════
async function placeOrder(signal, price) {
  if (BOT.openOrder) return;
  if (Date.now() < BOT.pauseUntil) return;
  if (Date.now() - BOT.lastTradeTime < CONFIG.COOLDOWN_MS) return;

  const lot  = calcLot(price);
  const sl   = CONFIG.SL_PIPS * 0.01;
  const tp   = CONFIG.SL_PIPS * CONFIG.TP_RATIO * 0.01;
  const type = signal === 'BUY' ? 0 : 1;

  const slPrice = signal === 'BUY' ? price - sl : price + sl;
  const tpPrice = signal === 'BUY' ? price + tp : price - tp;

  try {
    const res = await sendReq({
      mt5_new_order: 1,
      login:         CONFIG.LOGIN,
      symbol:        CONFIG.SYMBOL,
      volume:        lot,
      type,
      price,
      sl:            parseFloat(slPrice.toFixed(2)),
      tp:            parseFloat(tpPrice.toFixed(2)),
      comment:       'gold-bot-v11',
    });

    if (res.error) {
      console.log('❌ Ordre refusé:', res.error.message);
      return;
    }

    const orderId    = res.mt5_new_order?.order;
    BOT.openOrder    = orderId;
    BOT.lastTradeTime = Date.now();
    BOT.nTrades++;
    BOT.lastSignal   = signal;

    BOT.trades.unshift({
      id:     orderId,
      signal,
      lot,
      price:  parseFloat(price.toFixed(2)),
      sl:     parseFloat(slPrice.toFixed(2)),
      tp:     parseFloat(tpPrice.toFixed(2)),
      time:   new Date().toISOString(),
      status: 'open',
      pnl:    null,
    });
    if (BOT.trades.length > 50) BOT.trades.pop();

    console.log(`🚀 ${signal} | Lot:${lot} | Prix:${price.toFixed(2)} | SL:${slPrice.toFixed(2)} | TP:${tpPrice.toFixed(2)}`);
  } catch(e) {
    console.log('❌ Erreur ordre:', e.message);
  }
}

// ═══════════════════════════════════════════
//  SURVEILLANCE POSITIONS
// ═══════════════════════════════════════════
async function checkPositions() {
  if (!BOT.openOrder || !BOT.authorized) return;
  try {
    const res    = await sendReq({ mt5_get_orders: 1, login: CONFIG.LOGIN });
    const orders = res.mt5_get_orders?.orders || [];
    const still  = orders.find(o => o.order === BOT.openOrder);

    if (!still) {
      const hist = await sendReq({ mt5_get_order_history: 1, login: CONFIG.LOGIN });
      const done = (hist.mt5_get_order_history?.orders || []).find(o => o.order === BOT.openOrder);
      const pnl  = done ? parseFloat(done.profit || 0) : 0;

      BOT.pnl      += pnl;
      const closedId = BOT.openOrder;
      BOT.openOrder  = null;

      if (pnl >= 0) { BOT.wins++; BOT.lossStreak = 0; }
      else          { BOT.losses++; BOT.lossStreak++; }

      const t = BOT.trades.find(x => x.id === closedId);
      if (t) { t.status = pnl >= 0 ? 'win' : 'loss'; t.pnl = parseFloat(pnl.toFixed(2)); }

      console.log(`${pnl >= 0 ? '✅ WIN' : '❌ LOSS'} $${Math.abs(pnl).toFixed(2)} | PnL total:$${BOT.pnl.toFixed(2)} | WR:${((BOT.wins / BOT.nTrades) * 100).toFixed(1)}%`);

      if (BOT.lossStreak >= CONFIG.MAX_LOSSES) {
        BOT.pauseUntil = Date.now() + CONFIG.LOSS_PAUSE_MS;
        BOT.lossStreak = 0;
        console.log('⏸️ PAUSE 30 min activée');
      }
    }
  } catch(e) {
    console.log('Erreur checkPositions:', e.message);
  }
}

// ═══════════════════════════════════════════
//  DÉMARRAGE BOT
// ═══════════════════════════════════════════
function startBot() {
  if (!CONFIG.PASSWORD) {
    console.log('❌ MT5_PASSWORD manquant — ajoute la variable dans Render');
    return;
  }

  console.log('🤖 V11 MT5 Bot starting...');
  BOT.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089&l=EN&brand=deriv');

  BOT.ws.on('open', () => {
    console.log('✅ WebSocket connecté');
    // Étape 1 — S'authentifier avec le token Deriv existant
    send({ authorize: process.env.DERIV_TOKEN });
  });

  BOT.ws.on('message', async (msg) => {
    try {
      const d = JSON.parse(msg);

      if (d.req_id && BOT.pending[d.req_id]) {
        const { resolve, reject } = BOT.pending[d.req_id];
        delete BOT.pending[d.req_id];
        if (d.error) reject(d); else resolve(d);
        return;
      }

      // Étape 1 — Autorisation Deriv réussie → login MT5
      if (d.msg_type === 'authorize') {
        if (d.error) { console.log('❌ Auth Deriv échouée:', d.error.message); return; }
        console.log('✅ Deriv autorisé — connexion MT5...');
        send({
          mt5_login: 1,
          login:     CONFIG.LOGIN,
          password:  CONFIG.PASSWORD,
          server:    CONFIG.SERVER,
        });
      }

      // Étape 2 — Login MT5
        if (d.error) {
          console.log('❌ MT5 Login échoué:', d.error.message);
          return;
        }
        BOT.authorized = true;
        console.log(`✅ MT5 Autorisé — ${CONFIG.SERVER}`);

        try {
          const bal = await sendReq({ mt5_get_settings: 1, login: CONFIG.LOGIN });
          BOT.balance = parseFloat(bal.mt5_get_settings?.balance || 0);
          console.log(`💰 Balance: $${BOT.balance}`);
        } catch(e) { console.log('Balance error:', e.message); }

        send({ ticks: CONFIG.SYMBOL, subscribe: 1 });
        setInterval(checkPositions, 10000);
        setInterval(async () => {
          try {
            const b = await sendReq({ mt5_get_settings: 1, login: CONFIG.LOGIN });
            BOT.balance = parseFloat(b.mt5_get_settings?.balance || BOT.balance);
          } catch(e) {}
        }, 30000);
      }

      if (d.msg_type === 'tick') {
        const price = parseFloat(d.tick.quote);
        const ts    = d.tick.epoch ? d.tick.epoch * 1000 : Date.now();
        if (isNaN(price)) return;
        updateCandles(price, ts);

        if (!BOT.authorized || BOT.openOrder) return;
        if (Date.now() < BOT.pauseUntil) {
          BOT.lastReason = `⏸️ Pause — reprend dans ${Math.round((BOT.pauseUntil - Date.now()) / 60000)} min`;
          return;
        }
        if (Date.now() - BOT.lastTradeTime < CONFIG.COOLDOWN_MS) return;

        const sig = getSignal();
        if (sig) {
          BOT.lastReason = sig.reason;
          console.log(`📡 ${sig.signal} | ${sig.reason}`);
          await placeOrder(sig.signal, price);
        }
      }

    } catch(e) {
      console.log('Parse error:', e.message);
    }
  });

  BOT.ws.on('close', () => {
    console.log('🔌 Déconnecté — reconnect 5s');
    BOT.authorized = false;
    clearTimeout(BOT.rTimer);
    BOT.rTimer = setTimeout(startBot, 5000);
  });

  BOT.ws.on('error', e => console.log('WS Error:', e.message));
}

// ═══════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════
app.get('/status', (req, res) => res.json({
  version:     'V11-MT5',
  authorized:  BOT.authorized,
  balance:     BOT.balance,
  pnl:         parseFloat(BOT.pnl.toFixed(2)),
  wins:        BOT.wins,
  losses:      BOT.losses,
  nTrades:     BOT.nTrades,
  winRate:     BOT.nTrades > 0 ? ((BOT.wins / BOT.nTrades) * 100).toFixed(1) + '%' : '--',
  lossStreak:  BOT.lossStreak,
  paused:      Date.now() < BOT.pauseUntil,
  pauseRemain: Date.now() < BOT.pauseUntil ? Math.round((BOT.pauseUntil - Date.now()) / 60000) + ' min' : '0',
  openOrder:   BOT.openOrder,
  lastSignal:  BOT.lastSignal,
  lastReason:  BOT.lastReason,
  candles:     { m1: BOT.candles.m1.length, m5: BOT.candles.m5.length, m15: BOT.candles.m15.length },
  trades:      BOT.trades.slice(0, 20),
  config: {
    symbol:    CONFIG.SYMBOL,
    riskPct:   CONFIG.RISK_PCT,
    slPips:    CONFIG.SL_PIPS,
    tpRatio:   CONFIG.TP_RATIO,
    maxLosses: CONFIG.MAX_LOSSES,
  },
}));

app.get('/history', (req, res) => {
  const wins   = BOT.trades.filter(t => t.status === 'win').length;
  const losses = BOT.trades.filter(t => t.status === 'loss').length;
  const total  = wins + losses;
  res.json({
    totalTrades: BOT.nTrades,
    wins, losses,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) + '%' : '--',
    pnl:     parseFloat(BOT.pnl.toFixed(2)),
    trades:  BOT.trades,
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════
//  START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🤖 V11 MT5 Bot — port ${PORT}`);
  console.log(`📊 Risk:${CONFIG.RISK_PCT * 100}% | SL:${CONFIG.SL_PIPS}pts | TP:${CONFIG.SL_PIPS * CONFIG.TP_RATIO}pts | Ratio 1:${CONFIG.TP_RATIO}`);
  console.log(`🧠 Price Action Pure + TP/SL réels via Deriv MT5\n`);
  startBot();
});
