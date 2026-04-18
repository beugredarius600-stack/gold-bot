/**
 * \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
 * \u2551         GOLD BOT V10 \u2014 Architecture compl\u00e8te                \u2551
 * \u2551                                                              \u2551
 * \u2551  CHANGELOG vs V9 :                                          \u2551
 * \u2551  [FIX-1] Contrat HIGHER/LOWER avec barri\u00e8re dynamique       \u2551
 * \u2551          \u2192 payout ratio cible ~1.8x (net ~1.5:1)            \u2551
 * \u2551          \u2192 basis:'payout' pour ma\u00eetriser le ratio           \u2551
 * \u2551          \u2192 fallback automatique sur CALL/PUT si erreur      \u2551
 * \u2551  [FIX-2] Confirmation M30 obligatoire dans stratTrend       \u2551
 * \u2551          \u2192 3 timeframes align\u00e9s : M30 + M15 + M5            \u2551
 * \u2551  [FIX-3] RSI resserr\u00e9 : BUY > 45 | SELL < 55               \u2551
 * \u2551          \u2192 r\u00e9duit les faux signaux en momentum faible       \u2551
 * \u2551  [NEW-1] Endpoint /metrics avec stats d\u00e9taill\u00e9es            \u2551
 * \u2551  [NEW-2] Calcul payout r\u00e9el par trade (ratio tracking)      \u2551
 * \u2551  [NEW-3] Heartbeat WS + reconnexion intelligente            \u2551
 * \u2551  [NEW-4] Logging structur\u00e9 avec timestamps                  \u2551
 * \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d
 */

'use strict';

const express   = require('express');
const WebSocket = require('ws');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  CONFIGURATION V10
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
const CONFIG = {
  // \u2500\u2500 Risk Management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  RISK_PCT:        0.02,
  MIN_STAKE:       0.35,
  MAX_STAKE:       500,

  // \u2500\u2500 Timing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  COOLDOWN_MS:     3 * 60 * 1000,
  LOSS_PAUSE_MS:   30 * 60 * 1000,
  MAX_LOSSES:      3,
  WS_RECONNECT_MS: 5 * 1000,
  HEARTBEAT_MS:    25 * 1000,

  // \u2500\u2500 [FIX-1] Contrat HIGHER/LOWER avec barri\u00e8re \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // basis:'payout' \u2192 on fixe le montant re\u00e7u si win
  // Deriv calcule le stake automatiquement selon la barri\u00e8re
  // Sur R_75 : barri\u00e8re \u00b10.15% \u00e0 10min \u2192 payout ~1.8\u20132.0x
  USE_BARRIER:     true,
  BARRIER_PCT:     0.0015,   // 0.15% depuis le prix actuel
  PAYOUT_RATIO:    1.8,      // payout cible : stake * 1.8
  DURATION:        10,
  DURATION_UNIT:   'm',

  // \u2500\u2500 Candles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  MAX_CANDLES:     120,

  // \u2500\u2500 Regime Detection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  TREND_DIST_MIN:  0.05,
  TREND_SLOPE_MIN: 0.05,

  // \u2500\u2500 [FIX-3] Seuils RSI resserr\u00e9s \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  RSI_BUY_MIN:     45,   // \u00e9tait 38
  RSI_BUY_MAX:     72,
  RSI_SELL_MIN:    28,
  RSI_SELL_MAX:    55,   // \u00e9tait 58
};

const SYMBOLS = ['R_75'];

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  LOGGING STRUCTUR\u00c9 [NEW-4]
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
const log = {
  info:  (msg) => console.log(`[${new Date().toISOString()}] \u2139\ufe0f  ${msg}`),
  trade: (msg) => console.log(`[${new Date().toISOString()}] \ud83d\udcb9 ${msg}`),
  warn:  (msg) => console.log(`[${new Date().toISOString()}] \u26a0\ufe0f  ${msg}`),
  err:   (msg) => console.log(`[${new Date().toISOString()}] \u274c ${msg}`),
  ok:    (msg) => console.log(`[${new Date().toISOString()}] \u2705 ${msg}`),
};

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  STATE
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
const BOT = {
  ws:             null,
  token:          process.env.DERIV_TOKEN || null,
  running:        false,
  balance:        0,
  openContract:   null,
  lastTradeTime:  0,
  lossStreak:     0,
  pauseUntil:     0,
  pnl:            0,
  wins:           0,
  losses:         0,
  nTrades:        0,
  lastSignal:     null,
  lastSymbol:     null,
  lastRegime:     {},
  lastReason:     '',
  lastPrice:      {},
  trades:         [],
  heartbeatTimer: null,
  reconnectTimer: null,
  // [NEW-2] suivi ratio r\u00e9el
  totalStaked:    0,
  totalReturned:  0,
};

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  MARCH\u00c9S \u2014 donn\u00e9es bougies
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
const MARKETS = {};
for (const s of SYMBOLS) {
  MARKETS[s] = {
    candles: { m1: [], m5: [], m15: [], m30: [] }, // [FIX-2] m30 ajout\u00e9
    current: { m1: null, m5: null, m15: null, m30: null },
  };
}

const TF = { m1: 60000, m5: 300000, m15: 900000, m30: 1800000 };

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  CANDLE BUILDER
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function updateCandles(symbol, price, timestamp) {
  const M = MARKETS[symbol];
  BOT.lastPrice[symbol] = price;

  for (const tf of ['m1', 'm5', 'm15', 'm30']) {
    const period = TF[tf];
    const t      = Math.floor(timestamp / period) * period;

    if (!M.current[tf] || M.current[tf].time !== t) {
      if (M.current[tf]) {
        M.candles[tf].push(M.current[tf]);
        if (M.candles[tf].length > CONFIG.MAX_CANDLES) M.candles[tf].shift();
      }
      M.current[tf] = { time: t, open: price, high: price, low: price, close: price };
    } else {
      const c  = M.current[tf];
      c.high   = Math.max(c.high, price);
      c.low    = Math.min(c.low, price);
      c.close  = price;
    }
  }
}

function closes(symbol, tf) {
  return [...MARKETS[symbol].candles[tf], MARKETS[symbol].current[tf]]
    .filter(Boolean)
    .map(c => c.close);
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  INDICATEURS TECHNIQUES
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let val  = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
  return val;
}

function rsi(data, period = 14) {
  if (data.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    diff > 0 ? gains += diff : losses -= diff;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - (100 / (1 + avgG / avgL));
}

function bollinger(data, period = 20) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const avg   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / period);
  return { upper: avg + 2 * std, lower: avg - 2 * std, avg };
}

function trendSlope(data, period = 20) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const xMean = (period - 1) / 2;
  const yMean = slice.reduce((a, b) => a + b, 0) / period;
  let num = 0, den = 0;
  for (let i = 0; i < period; i++) {
    num += (i - xMean) * (slice[i] - yMean);
    den += Math.pow(i - xMean, 2);
  }
  return den === 0 ? 0 : num / den;
}

function volatility(data, period = 20) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const avg   = slice.reduce((a, b) => a + b, 0) / period;
  return Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / period) / avg * 100;
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  D\u00c9TECTION DE R\u00c9GIME (TREND / RANGE / NONE)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function detectRegime(symbol) {
  const d = closes(symbol, 'm15');

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

  if (distance > CONFIG.TREND_DIST_MIN && Math.abs(slope) > CONFIG.TREND_SLOPE_MIN) {
    BOT.lastRegime[symbol] = `TREND (dist:${distance.toFixed(3)}% slope:${slope.toFixed(4)})`;
    return 'TREND';
  }

  BOT.lastRegime[symbol] = `RANGE (dist:${distance.toFixed(3)}% vol:${vol.toFixed(2)}%)`;
  return 'RANGE';
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  STRAT\u00c9GIE TREND V10
//  [FIX-2] Confirmation M30 obligatoire \u2014 3 timeframes align\u00e9s
//  [FIX-3] RSI BUY > 45 | SELL < 55
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function stratTrend(symbol) {
  const m5  = closes(symbol, 'm5');
  const m15 = closes(symbol, 'm15');
  const m30 = closes(symbol, 'm30'); // [FIX-2]

  // M30 n\u00e9cessite min 10 bougies = 5h de donn\u00e9es
  if (m5.length < 15 || m15.length < 15 || m30.length < 10) return null;

  const e9_30  = ema(m30, 9);
  const e21_30 = ema(m30, 21);
  const e9_15  = ema(m15, 9);
  const e21_15 = ema(m15, 21);
  const e9_5   = ema(m5, 9);
  const e21_5  = ema(m5, 21);
  const r5     = rsi(m5);

  if (!e9_30 || !e21_30 || !e9_15 || !e21_15 || !e9_5 || !e21_5 || !r5) return null;

  // \u2705 BUY \u2014 Triple confirmation haussi\u00e8re + RSI sain
  if (
    e9_30 > e21_30 &&
    e9_15 > e21_15 &&
    e9_5  > e21_5  &&
    r5 > CONFIG.RSI_BUY_MIN && r5 < CONFIG.RSI_BUY_MAX
  ) {
    return {
      signal:   'BUY',
      strength: 4,
      reason:   `TREND BUY | M30+M15+M5 haussiers | RSI:${r5.toFixed(0)}`,
    };
  }

  // \u2705 SELL \u2014 Triple confirmation baissi\u00e8re + RSI sain
  if (
    e9_30 < e21_30 &&
    e9_15 < e21_15 &&
    e9_5  < e21_5  &&
    r5 < CONFIG.RSI_SELL_MAX && r5 > CONFIG.RSI_SELL_MIN
  ) {
    return {
      signal:   'SELL',
      strength: 4,
      reason:   `TREND SELL | M30+M15+M5 baissiers | RSI:${r5.toFixed(0)}`,
    };
  }

  return null;
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  STRAT\u00c9GIE RANGE \u2014 Bollinger + RSI (inchang\u00e9e)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function stratRange(symbol) {
  const m5 = closes(symbol, 'm5');
  if (m5.length < 22) return null;

  const bb    = bollinger(m5);
  const r     = rsi(m5);
  const price = m5[m5.length - 1];

  if (!bb || !r) return null;

  if (price <= bb.lower * 1.002 && r < 38) {
    return { signal: 'BUY',  strength: 2, reason: `RANGE BUY  | BB basse | RSI:${r.toFixed(0)}` };
  }
  if (price >= bb.upper * 0.998 && r > 62) {
    return { signal: 'SELL', strength: 2, reason: `RANGE SELL | BB haute | RSI:${r.toFixed(0)}` };
  }

  return null;
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  ANALYSE + SCANNER
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function analyzeMarket(symbol) {
  const regime = detectRegime(symbol);
  if (regime === 'TREND') return stratTrend(symbol);
  if (regime === 'RANGE') return stratRange(symbol);
  return null;
}

function scanMarkets() {
  let best = null;
  for (const symbol of SYMBOLS) {
    const res = analyzeMarket(symbol);
    if (!res) continue;
    if (!best || res.strength > best.strength) best = { symbol, ...res };
  }
  BOT.lastReason = best
    ? `${best.symbol} | ${best.reason}`
    : `R\u00e9gimes: ${SYMBOLS.map(s => `${s}:${BOT.lastRegime[s] || 'WAIT'}`).join(' | ')}`;
  return best;
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  WEBSOCKET HELPERS
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function wsSend(payload) {
  if (BOT.ws && BOT.ws.readyState === WebSocket.OPEN) {
    BOT.ws.send(JSON.stringify(payload));
  }
}

function startHeartbeat() {
  clearInterval(BOT.heartbeatTimer);
  BOT.heartbeatTimer = setInterval(() => wsSend({ ping: 1 }), CONFIG.HEARTBEAT_MS);
}

function stopHeartbeat() {
  clearInterval(BOT.heartbeatTimer);
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  D\u00c9MARRAGE BOT + RECONNEXION [NEW-3]
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function startBot() {
  if (!BOT.token) { log.err('Variable DERIV_TOKEN manquante'); return; }

  if (BOT.ws) {
    stopHeartbeat();
    try { BOT.ws.terminate(); } catch (_) {}
    BOT.ws = null;
  }

  log.info('Connexion WebSocket Deriv...');
  BOT.ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089&l=EN&brand=deriv');

  BOT.ws.on('open', () => {
    log.ok('WebSocket connect\u00e9');
    startHeartbeat();
    wsSend({ authorize: BOT.token });
  });

  BOT.ws.on('message', handleMessage);

  BOT.ws.on('close', (code) => {
    stopHeartbeat();
    BOT.running = false;
    log.warn(`WebSocket ferm\u00e9 (code:${code}) \u2014 reconnexion dans ${CONFIG.WS_RECONNECT_MS / 1000}s`);
    clearTimeout(BOT.reconnectTimer);
    BOT.reconnectTimer = setTimeout(startBot, CONFIG.WS_RECONNECT_MS);
  });

  BOT.ws.on('error', (e) => log.err(`WebSocket: ${e.message}`));
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  GESTIONNAIRE DE MESSAGES WS
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function handleMessage(raw) {
  let d;
  try { d = JSON.parse(raw); } catch (e) { return; }

  // Autorisation
  if (d.msg_type === 'authorize') {
    if (d.error) { log.err(`Auth: ${d.error.message}`); return; }
    BOT.balance = parseFloat(d.authorize.balance);
    BOT.running = true;
    log.ok(`Autoris\u00e9 \u2014 Balance: $${BOT.balance.toFixed(2)}`);
    wsSend({ balance: 1, subscribe: 1 });
    SYMBOLS.forEach(s => wsSend({ ticks: s, subscribe: 1 }));
  }

  // Balance temps r\u00e9el
  if (d.msg_type === 'balance' && d.balance) {
    BOT.balance = parseFloat(d.balance.balance);
  }

  // Tick de march\u00e9
  if (d.msg_type === 'tick') {
    const symbol = d.tick.symbol;
    const price  = parseFloat(d.tick.quote);
    if (!symbol || isNaN(price)) return;

    const ts = d.tick.epoch ? d.tick.epoch * 1000 : Date.now();
    updateCandles(symbol, price, ts);

    if (BOT.openContract) return;

    if (Date.now() < BOT.pauseUntil) {
      BOT.lastReason = `\u23f8\ufe0f Pause \u2014 reprend dans ${Math.round((BOT.pauseUntil - Date.now()) / 60000)} min`;
      return;
    }

    if (Date.now() - BOT.lastTradeTime < CONFIG.COOLDOWN_MS) return;

    const best = scanMarkets();
    if (best) {
      log.trade(`SIGNAL: ${best.signal} ${best.symbol} | ${best.reason}`);
      BOT.lastSignal    = best.signal;
      BOT.lastSymbol    = best.symbol;
      BOT.lastTradeTime = Date.now();
      placeTrade(best.symbol, best.signal);
    }
  }

  // R\u00e9ponse proposal
  if (d.msg_type === 'proposal') {
    if (d.error) {
      log.err(`Proposal refus\u00e9: ${d.error.message}`);
      // [FIX-1] Fallback automatique si la barri\u00e8re est rejet\u00e9e
      if (CONFIG.USE_BARRIER) {
        log.warn('Fallback \u2192 CALL/PUT classique sans barri\u00e8re');
        placeTradeClassic(BOT.lastSymbol, BOT.lastSignal);
      }
      return;
    }
    wsSend({ buy: d.proposal.id, price: d.proposal.ask_price });
  }

  // Confirmation achat
  if (d.msg_type === 'buy') {
    if (d.error) { log.err(`Buy: ${d.error.message}`); return; }

    BOT.openContract  = d.buy.contract_id;
    BOT.nTrades++;
    const stake = parseFloat(d.buy.buy_price);
    BOT.totalStaked += stake;

    BOT.trades.unshift({
      id:     d.buy.contract_id,
      signal: BOT.lastSignal,
      symbol: BOT.lastSymbol,
      stake,
      time:   new Date().toISOString(),
      status: 'pending',
      pnl:    null,
      payout: null,
    });
    if (BOT.trades.length > 50) BOT.trades.pop();

    log.trade(`#${BOT.nTrades} ouvert \u2014 ${BOT.lastSignal} ${BOT.lastSymbol} | Mise: $${stake.toFixed(2)}`);
    wsSend({ proposal_open_contract: 1, contract_id: d.buy.contract_id, subscribe: 1 });
  }

  // R\u00e9sultat contrat
  if (d.msg_type === 'proposal_open_contract') {
    const c = d.proposal_open_contract;
    if (!c || (c.status !== 'sold' && !c.is_expired)) return;

    const pnl    = parseFloat(c.profit || 0);
    const payout = parseFloat(c.payout || 0);

    BOT.pnl           += pnl;
    BOT.openContract   = null;
    BOT.totalReturned += payout;

    if (pnl >= 0) {
      BOT.wins++;
      BOT.lossStreak = 0;
      log.ok(`WIN +$${Math.abs(pnl).toFixed(2)} | PnL: $${BOT.pnl.toFixed(2)} | WR: ${((BOT.wins / BOT.nTrades) * 100).toFixed(1)}%`);
    } else {
      BOT.losses++;
      BOT.lossStreak++;
      log.warn(`LOSS -$${Math.abs(pnl).toFixed(2)} | PnL: $${BOT.pnl.toFixed(2)} | Streak: ${BOT.lossStreak}`);
    }

    const t = BOT.trades.find(x => x.id == c.contract_id);
    if (t) { t.status = pnl >= 0 ? 'win' : 'loss'; t.pnl = pnl; t.payout = payout; }

    if (BOT.lossStreak >= CONFIG.MAX_LOSSES) {
      BOT.pauseUntil = Date.now() + CONFIG.LOSS_PAUSE_MS;
      BOT.lossStreak = 0;
      log.warn(`PAUSE 30 min apr\u00e8s ${CONFIG.MAX_LOSSES} pertes cons\u00e9cutives`);
    }

    if (c.id) wsSend({ forget: c.id });
  }
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  PLACE TRADE [FIX-1] \u2014 HIGHER/LOWER avec barri\u00e8re dynamique
//  basis: 'payout' = Deriv calcule le stake selon payout voulu
//  Exemple : payout $180 \u2192 Deriv prend ~$100 de mise \u2192 ratio 1.8x
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
function placeTrade(symbol, signal) {
  const price = BOT.lastPrice[symbol];
  if (!price) { log.err('Prix indisponible'); return; }

  if (!CONFIG.USE_BARRIER) { placeTradeClassic(symbol, signal); return; }

  const stake        = Math.min(
    Math.max(parseFloat((BOT.balance * CONFIG.RISK_PCT).toFixed(2)), CONFIG.MIN_STAKE),
    CONFIG.MAX_STAKE
  );
  const payoutTarget = parseFloat((stake * CONFIG.PAYOUT_RATIO).toFixed(2));
  const offset       = parseFloat((price * CONFIG.BARRIER_PCT).toFixed(4));
  const barrier      = signal === 'BUY' ? `+${offset}` : `-${offset}`;

  log.info(`\u2192 HIGHER/
