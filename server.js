const express = require('express');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════
const CONFIG = {
  RISK_PCT:       0.02,            // 2% par trade — prudent après 46.5% winrate
  COOLDOWN_MS:    3 * 60 * 1000,   // 3 min entre trades
  LOSS_PAUSE_MS:  30 * 60 * 1000,  // pause 30 min après 3 pertes
  MAX_LOSSES:     3,               // max pertes consécutives avant pause
  MIN_BALANCE:    0.35,
};

const SYMBOLS = ['R_75']; // R_50 désactivé — performances insuffisantes

// ═══════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════
const BOT = {
  ws:            null,
  token:         process.env.DERIV_TOKEN || null,
  running:       false,
  balance:       0,
  openContract:  null,
  lastTradeTime: 0,
  lossStreak:    0,
  pauseUntil:    0,
  pnl:           0,
  wins:          0,
  losses:        0,
  nTrades:       0,
  lastSignal:    null,
  lastSymbol:    null,
  lastRegime:    {},
  lastReason:    '',
  trades:        [],
  rTimer:        null,
};

// État indépendant par marché
const MARKETS = {};
for (const s of SYMBOLS) {
  MARKETS[s] = {
    candles: { m1: [], m5: [], m15: [] },
    current: { m1: null, m5: null, m15: null },
  };
}

const TF = { m1: 60000, m5: 300000, m15: 900000 };
const MAX_CANDLES = 120;

// ═══════════════════════════════════════════
//  CANDLE BUILDER
// ═══════════════════════════════════════════
function updateCandles(symbol, price, timestamp) {
  const M = MARKETS[symbol];
  for (const tf of ['m1', 'm5', 'm15']) {
    const p = TF[tf];
    const t = Math.floor(timestamp / p) * p;
    if (!M.current[tf] || M.current[tf].time !== t) {
      if (M.current[tf]) {
        M.candles[tf].push(M.current[tf]);
        if (M.candles[tf].length > MAX_CANDLES) M.candles[tf].shift();
      }
      M.current[tf] = { time: t, open: price, high: price, low: price, close: price };
    } else {
      const c = M.current[tf];
      c.high  = Math.max(c.high, price);
      c.low   = Math.min(c.low, price);
      c.close = price;
    }
  }
}

function closes(symbol, tf) {
  return [...MARKETS[symbol].candles[tf], MARKETS[symbol].current[tf]]
    .filter(Boolean)
    .map(c => c.close);
}

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
    df > 0 ? g += df : l -= df;
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
  return { upper: avg + 2 * std, lower: avg - 2 * std, avg };
}

function trendSlope(d, n = 20) {
  if (d.length < n) return null;
  const sl = d.slice(-n);
  const xm = (n - 1) / 2;
  const ym = sl.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (sl[i] - ym);
    den += Math.pow(i - xm, 2);
  }
  return den === 0 ? 0 : num / den;
}

function volatility(d, n = 20) {
  if (d.length < n) return null;
  const sl  = d.slice(-n);
  const avg = sl.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(sl.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / n) / avg * 100;
}

// ═══════════════════════════════════════════
//  DÉTECTION DE RÉGIME
//  TREND = marché directionnel
//  RANGE = marché en consolidation
//  Seuils abaissés pour détecter tôt
// ═══════════════════════════════════════════
function detectRegime(symbol) {
  const d = closes(symbol, 'm15');

  // Minimum 30 bougies M15 (7h30) — réaliste
  if (d.length < 30) {
    BOT.lastRegime[symbol] = `WAIT (${d.length}/30 bougies M15)`;
    return 'NONE';
  }

  const e9    = ema(d, 9);
  const e21   = ema(d, 21);
  const slope = trendSlope(d, 15);
  const vol   = volatility(d, 15);

  if (!e9 || !e21 || slope === null || !vol) {
    BOT.lastRegime[symbol] = 'indicateurs insuffisants';
    return 'NONE';
  }

  const distance = Math.abs(e9 - e21) / e21 * 100;

  // TREND si EMA séparées + pente claire
  if (distance > 0.05 && Math.abs(slope) > 0.05) {
    BOT.lastRegime[symbol] = `TREND (dist:${distance.toFixed(3)}% slope:${slope.toFixed(4)})`;
    return 'TREND';
  }

  // RANGE sinon
  BOT.lastRegime[symbol] = `RANGE (dist:${distance.toFixed(3)}% vol:${vol.toFixed(2)}%)`;
  return 'RANGE';
}

// ═══════════════════════════════════════════
//  STRATÉGIE TREND
//  Entre dans le sens de la tendance M15
//  Sur pullback M1 + confirmation RSI M5
// ═══════════════════════════════════════════
function stratTrend(symbol) {
  const m1  = closes(symbol, 'm1');
  const m5  = closes(symbol, 'm5');
  const m15 = closes(symbol, 'm15');

  if (m1.length < 15 || m5.length < 15 || m15.length < 15) return null;

  const e9_15  = ema(m15, 9);
  const e21_15 = ema(m15, 21);
  const e9_5   = ema(m5, 9);
  const e21_5  = ema(m5, 21);
  const r5     = rsi(m5);
  const price  = m1[m1.length - 1];

  if (!e9_15 || !e21_15 || !e9_5 || !e21_5 || !r5) return null;

  // Tendance haussière M15 + M5 aligné + RSI momentum
  // ✅ FIX — conditions assouplies pour permettre plus de BUY
  if (e9_15 > e21_15 && e9_5 > e21_5 && r5 > 38 && r5 < 75) {
    return { signal: 'BUY',  strength: 3, reason: `TREND BUY  | EMA M15+M5 haussières | RSI:${r5.toFixed(0)}` };
  }

  // Tendance baissière M15 + M5 aligné + RSI momentum
  // ✅ FIX — fenêtre RSI SELL plus stricte pour éviter faux signaux
  if (e9_15 < e21_15 && e9_5 < e21_5 && r5 < 58 && r5 > 25) {
    return { signal: 'SELL', strength: 3, reason: `TREND SELL | EMA M15+M5 baissières | RSI:${r5.toFixed(0)}` };
  }

  return null;
}

// ═══════════════════════════════════════════
//  STRATÉGIE RANGE
//  Rebond sur les extrêmes de Bollinger M5
//  Confirmé par RSI
// ═══════════════════════════════════════════
function stratRange(symbol) {
  const m5    = closes(symbol, 'm5');
  if (m5.length < 22) return null;

  const bb    = bollinger(m5);
  const r     = rsi(m5);
  const price = m5[m5.length - 1];
  const prev  = m5[m5.length - 2];

  if (!bb || !r) return null;

  // Prix touche ou passe sous la BB basse + RSI survente
  if (price <= bb.lower * 1.002 && r < 38) {
    return { signal: 'BUY',  strength: 2, reason: `RANGE BUY  | Prix BB basse | RSI:${r.toFixed(0)}` };
  }

  // Prix touche ou passe sur la BB haute + RSI surachat
  if (price >= bb.upper * 0.998 && r > 62) {
    return { signal: 'SELL', strength: 2, reason: `RANGE SELL | Prix BB haute | RSI:${r.toFixed(0)}` };
  }

  return null;
}

// ═══════════════════════════════════════════
//  ANALYSE PAR MARCHÉ
// ═══════════════════════════════════════════
function analyzeMarket(symbol) {
  const regime = detectRegime(symbol);
  if (regime === 'TREND') return stratTrend(symbol);
  if (regime === 'RANGE') return stratRange(symbol);
  return null;
}

// ═══════════════════════════════════════════
//  SCANNER — CHOISIT LE MEILLEUR SETUP
// ═══════════════════════════════════════════
function scanMarkets() {
  let best = null;
  for (const symbol of SYMBOLS) {
    const res = analyzeMarket(symbol);
    if (!res) continue;
    if (!best || res.strength > best.strength) {
      best = { symbol, ...res };
    }
  }
  if (best) BOT.lastReason = `${best.symbol} | ${best.reason}`;
  else      BOT.lastReason = `Régimes: ${SYMBOLS.map(s => `${s}:${BOT.lastRegime[s] || 'WAIT'}`).join(' | ')}`;
  return best;
}

// ═══════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════
function send(o) {
  if (BOT.ws && BOT.ws.readyState === WebSocket.OPEN) BOT.ws.send(JSON.stringify(o));
}

function startBot() {
  if (!BOT.token) { console.log('❌ No token'); return; }
  if (BOT.ws) { try { BOT.ws.terminate(); } catch(e) {} }

  console.log('🤖 V8 Bot starting...');
  BOT.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089&l=EN&brand=deriv');

  BOT.ws.on('open', () => {
    console.log('✅ Connected');
    send({ authorize: BOT.token });
  });

  BOT.ws.on('message', (msg) => {
    try {
      const d = JSON.parse(msg);

      if (d.msg_type === 'authorize') {
        if (d.error) { console.log('❌ Auth failed:', d.error.message); return; }
        BOT.balance = parseFloat(d.authorize.balance);
        BOT.running = true;
        console.log(`✅ Authorized — $${BOT.balance}`);
        send({ balance: 1, subscribe: 1 });
        // Souscrire aux deux marchés
        SYMBOLS.forEach(s => send({ ticks: s, subscribe: 1 }));
      }

      if (d.msg_type === 'balance' && d.balance) {
        BOT.balance = parseFloat(d.balance.balance);
      }

      if (d.msg_type === 'tick') {
        const symbol = d.tick.symbol;
        const price  = parseFloat(d.tick.quote);
        if (isNaN(price)) return;

        const ts = d.tick.epoch ? d.tick.epoch * 1000 : Date.now();
        updateCandles(symbol, price, ts);

        // Conditions de blocage
        if (BOT.openContract) return;
        if (Date.now() < BOT.pauseUntil) {
          const reste = Math.round((BOT.pauseUntil - Date.now()) / 60000);
          BOT.lastReason = `⏸️ Pause protection — reprend dans ${reste} min`;
          return;
        }
        if (Date.now() - BOT.lastTradeTime < CONFIG.COOLDOWN_MS) return;

        const best = scanMarkets();
        if (best) {
          console.log(`🚀 SIGNAL: ${best.signal} sur ${best.symbol} | ${best.reason}`);
          BOT.lastSignal = best.signal;
          BOT.lastSymbol = best.symbol;
          BOT.lastTradeTime = Date.now();
          placeTrade(best.symbol, best.signal);
        }
      }

      if (d.msg_type === 'proposal') {
        if (d.error) { console.log('❌ Proposal:', d.error.message); return; }
        send({ buy: d.proposal.id, price: d.proposal.ask_price });
      }

      if (d.msg_type === 'buy') {
        if (d.error) { console.log('❌ Buy:', d.error.message); return; }
        BOT.openContract = d.buy.contract_id;
        BOT.nTrades++;
        BOT.trades.unshift({
          id:     d.buy.contract_id,
          signal: BOT.lastSignal,
          symbol: BOT.lastSymbol,
          stake:  parseFloat(d.buy.buy_price),
          time:   new Date().toISOString(),
          status: 'pending',
          pnl:    null,
        });
        // ✅ FIX — garder 50 trades en mémoire (au lieu de 20)
        if (BOT.trades.length > 50) BOT.trades.pop();
        console.log(`🔵 Trade #${BOT.nTrades} — ${BOT.lastSignal} ${BOT.lastSymbol} — $${d.buy.buy_price}`);
        send({ proposal_open_contract: 1, contract_id: d.buy.contract_id, subscribe: 1 });
      }

      if (d.msg_type === 'proposal_open_contract') {
        const c = d.proposal_open_contract;
        if (!c) return;
        if (c.status === 'sold' || c.is_expired) {
          const pnl = parseFloat(c.profit || 0);
          BOT.pnl        += pnl;
          BOT.openContract = null;

          if (pnl >= 0) {
            BOT.wins++;
            BOT.lossStreak = 0;
          } else {
            BOT.losses++;
            BOT.lossStreak++;
          }

          // Mise à jour du trade dans l'historique
          const t = BOT.trades.find(x => x.id == c.contract_id);
          if (t) { t.status = pnl >= 0 ? 'win' : 'loss'; t.pnl = pnl; }

          const emoji = pnl >= 0 ? '✅ WIN' : '❌ LOSS';
          console.log(`${emoji} $${Math.abs(pnl).toFixed(2)} | P&L:$${BOT.pnl.toFixed(2)} | Winrate:${((BOT.wins/BOT.nTrades)*100).toFixed(1)}% | Streak pertes:${BOT.lossStreak}`);

          // Protection — pause après MAX_LOSSES pertes consécutives
          if (BOT.lossStreak >= CONFIG.MAX_LOSSES) {
            BOT.pauseUntil = Date.now() + CONFIG.LOSS_PAUSE_MS;
            BOT.lossStreak = 0;
            console.log(`⏸️ PAUSE 30 min après ${CONFIG.MAX_LOSSES} pertes consécutives`);
          }

          if (c.id) send({ forget: c.id });
        }
      }

    } catch(e) {
      console.log('Parse error:', e.message);
    }
  });

  BOT.ws.on('close', () => {
    console.log('🔌 Disconnected — reconnect 5s');
    clearTimeout(BOT.rTimer);
    BOT.rTimer = setTimeout(startBot, 5000);
  });

  BOT.ws.on('error', (e) => console.log('WS error:', e.message));
}

function placeTrade(symbol, signal) {
  const stake    = parseFloat((BOT.balance * CONFIG.RISK_PCT).toFixed(2));
  if (stake < CONFIG.MIN_BALANCE) { console.log('❌ Balance trop faible'); return; }
  // ✅ FIX — durée fixe 5 min pour plus de stabilité
  const duration = 5;
  send({
    proposal:      1,
    contract_type: signal === 'BUY' ? 'CALL' : 'PUT',
    symbol,
    duration,
    duration_unit: 'm',
    basis:         'stake',
    amount:        stake,
    currency:      'USD',
  });
  console.log(`📤 ${signal} ${symbol} | $${stake} | ${duration}min`);
}

// ═══════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════
app.get('/status', (req, res) => res.json({
  running:     BOT.running,
  symbols:     SYMBOLS,
  balance:     BOT.balance,
  pnl:         parseFloat(BOT.pnl.toFixed(2)),
  wins:        BOT.wins,
  losses:      BOT.losses,
  nTrades:     BOT.nTrades,
  winRate:     BOT.nTrades > 0 ? ((BOT.wins / BOT.nTrades) * 100).toFixed(1) + '%' : '--',
  lossStreak:  BOT.lossStreak,
  paused:      Date.now() < BOT.pauseUntil,
  pauseRemain: Date.now() < BOT.pauseUntil ? Math.round((BOT.pauseUntil - Date.now()) / 60000) + ' min' : '0',
  lastSignal:  BOT.lastSignal,
  lastSymbol:  BOT.lastSymbol,
  lastReason:  BOT.lastReason,
  regimes:     BOT.lastRegime,
  candles: {
    R_75: { m1: MARKETS['R_75']?.candles.m1.length, m5: MARKETS['R_75']?.candles.m5.length, m15: MARKETS['R_75']?.candles.m15.length },
  },
  // ✅ FIX — retourne les 20 derniers trades (au lieu de 10)
  trades:    BOT.trades.slice(0, 20),
  config:    CONFIG,
}));

// ✅ NOUVEAU — endpoint /history avec stats complètes par paire
app.get('/history', (req, res) => {
  const stats = {};
  for (const s of SYMBOLS) {
    const symTrades = BOT.trades.filter(t => t.symbol === s && t.status !== 'pending');
    const wins      = symTrades.filter(t => t.status === 'win').length;
    const losses    = symTrades.filter(t => t.status === 'loss').length;
    const total     = wins + losses;
    const pnl       = symTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const buys      = symTrades.filter(t => t.signal === 'BUY').length;
    const sells     = symTrades.filter(t => t.signal === 'SELL').length;
    stats[s] = {
      wins,
      losses,
      total,
      winRate:  total > 0 ? ((wins / total) * 100).toFixed(1) + '%' : '--',
      pnl:      parseFloat(pnl.toFixed(2)),
      buys,
      sells,
    };
  }

  res.json({
    totalTrades:   BOT.nTrades,
    globalWins:    BOT.wins,
    globalLosses:  BOT.losses,
    globalWinRate: BOT.nTrades > 0 ? ((BOT.wins / BOT.nTrades) * 100).toFixed(1) + '%' : '--',
    globalPnl:     parseFloat(BOT.pnl.toFixed(2)),
    bySymbol:      stats,
    allTrades:     BOT.trades,
  });
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ═══════════════════════════════════════════
//  START
// ═══════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n🤖 V9 Bot — port ${PORT}`);
  console.log(`📊 Risk:${CONFIG.RISK_PCT*100}% | Durée:5min fixe | Pause après ${CONFIG.MAX_LOSSES} pertes | Marché: R_75 uniquement`);
  console.log(`🧠 Logique: Détection régime (TREND/RANGE) → stratégie adaptée — BUY/SELL équilibrés\n`);
  startBot();
});
