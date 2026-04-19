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
  RISK_PCT:       0.02,            // 2% par trade
  COOLDOWN_MS:    5 * 60 * 1000,   // 5 min entre trades — moins de trades mais meilleurs
  LOSS_PAUSE_MS:  30 * 60 * 1000,  // pause 30 min
  MAX_LOSSES:     2,               // pause après 2 pertes consécutives — protection renforcée
  MIN_BALANCE:    0.35,
  DURATION:       3,               // 3 min par trade — adapté à la volatilité R_75
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

// Retourne les bougies complètes (open, high, low, close)
function candles(symbol, tf) {
  return [...MARKETS[symbol].candles[tf], MARKETS[symbol].current[tf]]
    .filter(Boolean);
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
//  UTILITAIRES PRICE ACTION
// ═══════════════════════════════════════════

// Détecte Higher High / Lower Low sur N bougies M5
function marketStructure(symbol) {
  const c = candles(symbol, 'm5');
  if (c.length < 10) return null;

  const recent = c.slice(-10);
  const highs  = recent.map(x => x.high);
  const lows   = recent.map(x => x.low);

  const hh = highs[highs.length - 1] > Math.max(...highs.slice(0, -1));
  const ll  = lows[lows.length - 1]  < Math.min(...lows.slice(0, -1));
  const lh  = highs[highs.length - 1] < Math.max(...highs.slice(0, -1));
  const hl  = lows[lows.length - 1]  > Math.min(...lows.slice(0, -1));

  if (hh && hl) return 'BULLISH'; // Higher High + Higher Low = structure haussière
  if (ll && lh) return 'BEARISH'; // Lower Low + Lower High = structure baissière
  return 'NEUTRAL';
}

// Calcule le niveau de support/résistance le plus proche sur M5
function keyLevels(symbol) {
  const c = candles(symbol, 'm5');
  if (c.length < 20) return null;

  const recent   = c.slice(-20);
  const resistance = Math.max(...recent.map(x => x.high));
  const support    = Math.min(...recent.map(x => x.low));
  const price      = recent[recent.length - 1].close;

  return { resistance, support, price };
}

// Vérifie si la dernière bougie M1 confirme la direction
function candleConfirm(symbol, direction) {
  const c = candles(symbol, 'm1');
  if (c.length < 2) return false;
  const last = c[c.length - 1];
  const prev = c[c.length - 2];

  if (direction === 'BUY') {
    // Bougie haussière + close au-dessus du close précédent
    return last.close > last.open && last.close > prev.close;
  } else {
    // Bougie baissière + close en dessous du close précédent
    return last.close < last.open && last.close < prev.close;
  }
}

// ═══════════════════════════════════════════
//  NOUVELLE STRATÉGIE — PRICE ACTION PURE
//  Basée sur structure de marché + niveaux clés
//  + confirmation bougie M1
//  + RSI comme filtre extrêmes uniquement
// ═══════════════════════════════════════════
function stratPriceAction(symbol) {
  const m5closes = closes(symbol, 'm5');
  const m1closes = closes(symbol, 'm1');

  if (m5closes.length < 20 || m1closes.length < 5) return null;

  const structure = marketStructure(symbol);
  const levels    = keyLevels(symbol);
  const r         = rsi(m5closes);

  if (!structure || !levels || !r) return null;
  if (structure === 'NEUTRAL') return null;

  const { resistance, support, price } = levels;
  const rangeSize = resistance - support;
  if (rangeSize <= 0) return null;

  // Position relative du prix dans le range (0% = support, 100% = résistance)
  const pricePos = (price - support) / rangeSize * 100;

  // ── BUY ──────────────────────────────────
  // Structure haussière + prix proche du support (bas du range)
  // + bougie M1 confirme + RSI pas en surachat
  if (
    structure === 'BULLISH' &&
    pricePos < 40 &&              // prix dans le bas du range
    r < 70 &&                     // pas en surachat
    candleConfirm(symbol, 'BUY')  // bougie M1 confirme
  ) {
    return {
      signal:   'BUY',
      strength: 3,
      reason:   `PA BUY | Structure BULLISH | Prix bas range (${pricePos.toFixed(0)}%) | RSI:${r.toFixed(0)}`,
    };
  }

  // ── SELL ─────────────────────────────────
  // Structure baissière + prix proche de la résistance (haut du range)
  // + bougie M1 confirme + RSI pas en survente
  if (
    structure === 'BEARISH' &&
    pricePos > 60 &&               // prix dans le haut du range
    r > 30 &&                      // pas en survente
    candleConfirm(symbol, 'SELL')  // bougie M1 confirme
  ) {
    return {
      signal:   'SELL',
      strength: 3,
      reason:   `PA SELL | Structure BEARISH | Prix haut range (${pricePos.toFixed(0)}%) | RSI:${r.toFixed(0)}`,
    };
  }

  return null;
}

// ═══════════════════════════════════════════
//  DÉTECTION DE RÉGIME (conservée pour info)
// ═══════════════════════════════════════════
function detectRegime(symbol) {
  const d = closes(symbol, 'm15');
  if (d.length < 20) {
    BOT.lastRegime[symbol] = `WAIT (${d.length}/20 bougies M15)`;
    return 'NONE';
  }
  const slope = trendSlope(d, 15);
  const vol   = volatility(d, 15);
  if (slope === null || !vol) {
    BOT.lastRegime[symbol] = 'indicateurs insuffisants';
    return 'NONE';
  }
  if (Math.abs(slope) > 0.05) {
    BOT.lastRegime[symbol] = `TREND (slope:${slope.toFixed(4)})`;
    return 'TREND';
  }
  BOT.lastRegime[symbol] = `RANGE (vol:${vol.toFixed(2)}%)`;
  return 'RANGE';
}

// ═══════════════════════════════════════════
//  ANALYSE PAR MARCHÉ — Price Action uniquement
// ═══════════════════════════════════════════
function analyzeMarket(symbol) {
  detectRegime(symbol); // pour affichage info seulement
  return stratPriceAction(symbol);
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
  const duration = CONFIG.DURATION;
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
  console.log(`\n🤖 V10 Bot — port ${PORT}`);
  console.log(`📊 Risk:${CONFIG.RISK_PCT*100}% | Durée:${CONFIG.DURATION}min | Pause après ${CONFIG.MAX_LOSSES} pertes | Marché: R_75`);
  console.log(`🧠 Stratégie: Price Action Pure — Structure + Niveaux clés + Confirmation M1\n`);
  startBot();
});
