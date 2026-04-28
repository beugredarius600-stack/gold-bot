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
  DERIV_TOKEN:   process.env.DERIV_TOKEN,
  MT5_LOGIN:     '201259685',
  SYMBOL:        'Volatility 75 Index',
  RISK_PCT:      0.02,
  SL_POINTS:     200,
  TP_RATIO:      2,
  COOLDOWN_MS:   5 * 60 * 1000,
  LOSS_PAUSE_MS: 30 * 60 * 1000,
  MAX_LOSSES:    2,
  LOT_MIN:       0.01,
};

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const BOT = {
  ws:            null,
  authorized:    false,
  mt5Ready:      false,
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
  lastReason:    'Démarrage...',
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
//  HELPERS
// ═══════════════════════════════════════════
function nextId() { return BOT.reqId++; }

function send(obj) {
  if (BOT.ws && BOT.ws.readyState === WebSocket.OPEN) {
    BOT.ws.send(JSON.stringify(obj));
  }
}

function sendReq(obj) {
  return new Promise(function(resolve, reject) {
    var id = nextId();
    obj.req_id = id;
    BOT.pending[id] = { resolve: resolve, reject: reject };
    send(obj);
    setTimeout(function() {
      if (BOT.pending[id]) {
        delete BOT.pending[id];
        reject(new Error('Timeout ' + id));
      }
    }, 15000);
  });
}

// ═══════════════════════════════════════════
//  CANDLES
// ═══════════════════════════════════════════
function updateCandles(price, timestamp) {
  var tfs = ['m1', 'm5', 'm15'];
  for (var i = 0; i < tfs.length; i++) {
    var tf = tfs[i];
    var p  = TF[tf];
    var t  = Math.floor(timestamp / p) * p;
    if (!BOT.current[tf] || BOT.current[tf].time !== t) {
      if (BOT.current[tf]) {
        BOT.candles[tf].push(BOT.current[tf]);
        if (BOT.candles[tf].length > MAX_BARS) BOT.candles[tf].shift();
      }
      BOT.current[tf] = { time: t, open: price, high: price, low: price, close: price };
    } else {
      var c  = BOT.current[tf];
      c.high = Math.max(c.high, price);
      c.low  = Math.min(c.low, price);
      c.close = price;
    }
  }
}

function getCloses(tf) {
  var arr = BOT.candles[tf].slice();
  if (BOT.current[tf]) arr.push(BOT.current[tf]);
  return arr.map(function(c) { return c.close; });
}

function getCandles(tf) {
  var arr = BOT.candles[tf].slice();
  if (BOT.current[tf]) arr.push(BOT.current[tf]);
  return arr;
}

// ═══════════════════════════════════════════
//  INDICATEURS
// ═══════════════════════════════════════════
function rsi(d, n) {
  n = n || 14;
  if (d.length < n + 1) return null;
  var g = 0, l = 0;
  for (var i = d.length - n; i < d.length; i++) {
    var df = d[i] - d[i - 1];
    if (df > 0) g += df; else l -= df;
  }
  var ag = g / n, al = l / n;
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

// ═══════════════════════════════════════════
//  PRICE ACTION
// ═══════════════════════════════════════════
function marketStructure() {
  var c = getCandles('m5');
  if (c.length < 10) return null;
  var recent = c.slice(-10);
  var highs  = recent.map(function(x) { return x.high; });
  var lows   = recent.map(function(x) { return x.low; });
  var lastH  = highs[highs.length - 1];
  var lastL  = lows[lows.length - 1];
  var prevH  = Math.max.apply(null, highs.slice(0, -1));
  var prevL  = Math.min.apply(null, lows.slice(0, -1));
  if (lastH > prevH && lastL > prevL) return 'BULLISH';
  if (lastH < prevH && lastL < prevL) return 'BEARISH';
  return 'NEUTRAL';
}

function keyLevels() {
  var c = getCandles('m5');
  if (c.length < 20) return null;
  var recent     = c.slice(-20);
  var resistance = Math.max.apply(null, recent.map(function(x) { return x.high; }));
  var support    = Math.min.apply(null, recent.map(function(x) { return x.low; }));
  var price      = recent[recent.length - 1].close;
  return { resistance: resistance, support: support, price: price };
}

function candleConfirm(direction) {
  var c = getCandles('m1');
  if (c.length < 2) return false;
  var last = c[c.length - 1];
  var prev = c[c.length - 2];
  if (direction === 'BUY')  return last.close > last.open && last.close > prev.close;
  if (direction === 'SELL') return last.close < last.open && last.close < prev.close;
  return false;
}

function getSignal() {
  var m5closes = getCloses('m5');
  if (m5closes.length < 20) {
    BOT.lastReason = 'Chauffe... M5:' + m5closes.length + '/20';
    return null;
  }
  var structure = marketStructure();
  var levels    = keyLevels();
  var r         = rsi(m5closes);
  if (!structure || !levels || !r) return null;
  if (structure === 'NEUTRAL') {
    BOT.lastReason = 'NEUTRAL — attente';
    return null;
  }
  var rangeSize = levels.resistance - levels.support;
  if (rangeSize <= 0) return null;
  var pricePos = (levels.price - levels.support) / rangeSize * 100;
  if (structure === 'BULLISH' && pricePos < 40 && r < 70 && candleConfirm('BUY')) {
    return { signal: 'BUY', reason: 'PA BUY | BULLISH | Pos:' + pricePos.toFixed(0) + '% | RSI:' + r.toFixed(0) };
  }
  if (structure === 'BEARISH' && pricePos > 60 && r > 30 && candleConfirm('SELL')) {
    return { signal: 'SELL', reason: 'PA SELL | BEARISH | Pos:' + pricePos.toFixed(0) + '% | RSI:' + r.toFixed(0) };
  }
  BOT.lastReason = structure + ' Pos:' + pricePos.toFixed(0) + '% RSI:' + r.toFixed(0) + ' — attente';
  return null;
}

// ═══════════════════════════════════════════
//  ORDRE MT5
// ═══════════════════════════════════════════
async function placeOrder(signal, price) {
  if (BOT.openOrder) return;
  if (Date.now() < BOT.pauseUntil) return;
  if (Date.now() - BOT.lastTradeTime < CONFIG.COOLDOWN_MS) return;

  var sl      = CONFIG.SL_POINTS * 0.01;
  var tp      = sl * CONFIG.TP_RATIO;
  var slPrice = parseFloat((signal === 'BUY' ? price - sl : price + sl).toFixed(2));
  var tpPrice = parseFloat((signal === 'BUY' ? price + tp : price - tp).toFixed(2));
  var lot     = Math.max(CONFIG.LOT_MIN, parseFloat(((BOT.balance * CONFIG.RISK_PCT) / sl).toFixed(2)));

  try {
    var res = await sendReq({
      mt5_new_order: 1,
      login:  CONFIG.MT5_LOGIN,
      symbol: CONFIG.SYMBOL,
      volume: lot,
      type:   signal === 'BUY' ? 0 : 1,
      price:  parseFloat(price.toFixed(2)),
      sl:     slPrice,
      tp:     tpPrice,
      comment: 'v11',
    });

    if (res.error) { console.log('❌ Ordre refusé:', res.error.message); return; }

    var orderId       = res.mt5_new_order && res.mt5_new_order.order;
    BOT.openOrder     = orderId;
    BOT.lastTradeTime = Date.now();
    BOT.nTrades++;
    BOT.lastSignal    = signal;
    BOT.trades.unshift({ id: orderId, signal: signal, lot: lot, price: parseFloat(price.toFixed(2)), sl: slPrice, tp: tpPrice, time: new Date().toISOString(), status: 'open', pnl: null });
    if (BOT.trades.length > 50) BOT.trades.pop();
    console.log('🚀 ' + signal + ' Lot:' + lot + ' SL:' + slPrice + ' TP:' + tpPrice);
  } catch(e) {
    console.log('❌ Ordre err:', e.message);
  }
}

// ═══════════════════════════════════════════
//  SURVEILLANCE + BALANCE
// ═══════════════════════════════════════════
async function checkPositions() {
  if (!BOT.openOrder || !BOT.mt5Ready) return;
  try {
    var res    = await sendReq({ mt5_get_orders: 1, login: CONFIG.MT5_LOGIN });
    var orders = (res.mt5_get_orders && res.mt5_get_orders.orders) || [];
    var still  = orders.some(function(o) { return o.order === BOT.openOrder; });
    if (!still) {
      try {
        var hist    = await sendReq({ mt5_get_order_history: 1, login: CONFIG.MT5_LOGIN });
        var hOrders = (hist.mt5_get_order_history && hist.mt5_get_order_history.orders) || [];
        var done    = hOrders.find(function(o) { return o.order === BOT.openOrder; });
        var pnl     = done ? parseFloat(done.profit || 0) : 0;
        var closed  = BOT.openOrder;
        BOT.openOrder = null;
        BOT.pnl += pnl;
        if (pnl >= 0) { BOT.wins++; BOT.lossStreak = 0; }
        else          { BOT.losses++; BOT.lossStreak++; }
        var t = BOT.trades.find(function(x) { return x.id === closed; });
        if (t) { t.status = pnl >= 0 ? 'win' : 'loss'; t.pnl = parseFloat(pnl.toFixed(2)); }
        console.log((pnl >= 0 ? '✅ WIN' : '❌ LOSS') + ' $' + Math.abs(pnl).toFixed(2) + ' PnL:$' + BOT.pnl.toFixed(2));
        if (BOT.lossStreak >= CONFIG.MAX_LOSSES) {
          BOT.pauseUntil = Date.now() + CONFIG.LOSS_PAUSE_MS;
          BOT.lossStreak = 0;
          console.log('⏸️ PAUSE 30min');
        }
      } catch(e) { console.log('History err:', e.message); }
    }
  } catch(e) { console.log('checkPositions err:', e.message); }
}

async function syncBalance() {
  if (!BOT.mt5Ready) return;
  try {
    var b = await sendReq({ mt5_get_settings: 1, login: CONFIG.MT5_LOGIN });
    if (b.mt5_get_settings && b.mt5_get_settings.balance) {
      BOT.balance = parseFloat(b.mt5_get_settings.balance);
    }
  } catch(e) {}
}

// ═══════════════════════════════════════════
//  INIT MT5 — via mt5_login_list
// ═══════════════════════════════════════════
async function initMT5() {
  try {
    // Liste tous les comptes MT5 liés au token
    var list = await sendReq({ mt5_login_list: 1 });
    console.log('📋 Comptes MT5 liés:', JSON.stringify(list.mt5_login_list || list.error || 'aucun'));

    var accounts = list.mt5_login_list || [];
    if (accounts.length === 0) {
      console.log('❌ Aucun compte MT5 lié à ce token Deriv');
      console.log('ℹ️ Va sur app.deriv.com → Traders Hub → MT5 et relie ton compte');
      return;
    }

    // Cherche le compte correspondant au login
    var account = accounts.find(function(a) { return String(a.login) === CONFIG.MT5_LOGIN; });
    if (!account) {
      account = accounts[0]; // prend le premier si pas trouvé
      console.log('ℹ️ Login utilisé:', account.login);
    }

    BOT.balance  = parseFloat(account.balance || 0);
    BOT.mt5Ready = true;
    console.log('✅ MT5 Ready — Login:' + account.login + ' Balance:$' + BOT.balance);

    send({ ticks: CONFIG.SYMBOL, subscribe: 1 });
    setInterval(checkPositions, 10000);
    setInterval(syncBalance, 30000);

  } catch(e) {
    console.log('❌ initMT5 err:', e.message);
  }
}

// ═══════════════════════════════════════════
//  BOT START
// ═══════════════════════════════════════════
function startBot() {
  if (!CONFIG.DERIV_TOKEN) { console.log('❌ DERIV_TOKEN manquant'); return; }

  console.log('🤖 V11 MT5 Bot starting...');
  BOT.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089&l=EN&brand=deriv');

  BOT.ws.on('open', function() {
    console.log('✅ WebSocket connecté');
    send({ authorize: CONFIG.DERIV_TOKEN });
  });

  BOT.ws.on('message', async function(raw) {
    var d;
    try { d = JSON.parse(raw); } catch(e) { return; }

    if (d.req_id && BOT.pending[d.req_id]) {
      var cb = BOT.pending[d.req_id];
      delete BOT.pending[d.req_id];
      if (d.error) cb.reject(d); else cb.resolve(d);
      return;
    }

    if (d.msg_type === 'authorize') {
      if (d.error) { console.log('❌ Auth:', d.error.message); return; }
      BOT.authorized = true;
      console.log('✅ Deriv autorisé — init MT5...');
      await initMT5();
    }

    if (d.msg_type === 'tick') {
      var price = parseFloat(d.tick.quote);
      var ts    = d.tick.epoch ? d.tick.epoch * 1000 : Date.now();
      if (isNaN(price)) return;
      updateCandles(price, ts);
      if (!BOT.mt5Ready || BOT.openOrder) return;
      if (Date.now() < BOT.pauseUntil) {
        BOT.lastReason = '⏸️ Pause — ' + Math.round((BOT.pauseUntil - Date.now()) / 60000) + 'min';
        return;
      }
      if (Date.now() - BOT.lastTradeTime < CONFIG.COOLDOWN_MS) return;
      var sig = getSignal();
      if (sig) {
        BOT.lastReason = sig.reason;
        console.log('📡 ' + sig.signal + ' | ' + sig.reason);
        await placeOrder(sig.signal, price);
      }
    }
  });

  BOT.ws.on('close', function() {
    console.log('🔌 Déconnecté — reconnect 5s');
    BOT.authorized = false;
    BOT.mt5Ready   = false;
    clearTimeout(BOT.rTimer);
    BOT.rTimer = setTimeout(startBot, 5000);
  });

  BOT.ws.on('error', function(e) { console.log('WS Error:', e.message); });
}

// ═══════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════
app.get('/status', function(req, res) {
  res.json({
    version: 'V11-MT5', authorized: BOT.authorized, mt5Ready: BOT.mt5Ready,
    balance: BOT.balance, pnl: parseFloat(BOT.pnl.toFixed(2)),
    wins: BOT.wins, losses: BOT.losses, nTrades: BOT.nTrades,
    winRate: BOT.nTrades > 0 ? ((BOT.wins / BOT.nTrades) * 100).toFixed(1) + '%' : '--',
    lossStreak: BOT.lossStreak, paused: Date.now() < BOT.pauseUntil,
    pauseRemain: Date.now() < BOT.pauseUntil ? Math.round((BOT.pauseUntil - Date.now()) / 60000) + 'min' : '0',
    openOrder: BOT.openOrder, lastSignal: BOT.lastSignal, lastReason: BOT.lastReason,
    candles: { m1: BOT.candles.m1.length, m5: BOT.candles.m5.length, m15: BOT.candles.m15.length },
    trades: BOT.trades.slice(0, 20),
    config: { symbol: CONFIG.SYMBOL, riskPct: CONFIG.RISK_PCT, slPoints: CONFIG.SL_POINTS, tpRatio: CONFIG.TP_RATIO },
  });
});

app.get('/history', function(req, res) {
  var wins   = BOT.trades.filter(function(t) { return t.status === 'win'; }).length;
  var losses = BOT.trades.filter(function(t) { return t.status === 'loss'; }).length;
  var total  = wins + losses;
  res.json({ totalTrades: BOT.nTrades, wins: wins, losses: losses,
    winRate: total > 0 ? ((wins / total) * 100).toFixed(1) + '%' : '--',
    pnl: parseFloat(BOT.pnl.toFixed(2)), trades: BOT.trades });
});

app.get('/health', function(req, res) { res.json({ status: 'ok' }); });
app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, function() {
  console.log('\n🤖 V11 MT5 Bot — port ' + PORT);
  console.log('📊 Risk:' + (CONFIG.RISK_PCT * 100) + '% | SL:' + CONFIG.SL_POINTS + 'pts | Ratio 1:' + CONFIG.TP_RATIO);
  console.log('🧠 Price Action Pure + TP/SL via Deriv MT5\n');
  startBot();
});
