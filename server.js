const express = require('express');
const WebSocket = require('ws');
const app = express();
const PORT = process.env.PORT || 3000;

//═══════════════════════════════════════════
// CONFIG
//═══════════════════════════════════════════
const CONFIG = {
  RISK_PCT: 0.015,
  COOLDOWN_MS: 3 * 60 * 1000,
  LOSS_PAUSE_MS: 30 * 60 * 1000,
  MAX_LOSSES: 3,
  MIN_BALANCE: 0.35,
};

// 2 MARCHÉS SCANNÉS
const SYMBOLS = ['R_75','R_50'];

//═══════════════════════════════════════════
// GLOBAL BOT STATE
//═══════════════════════════════════════════
const BOT = {
  ws:null, token:process.env.DERIV_TOKEN||null,
  balance:0, openContract:null,
  lastTradeTime:0, lossStreak:0, pauseUntil:0,
  pnl:0, wins:0, losses:0, nTrades:0
};

// ÉTAT INDÉPENDANT PAR MARCHÉ
const MARKETS = {};
for(const s of SYMBOLS){
  MARKETS[s] = {
    candles:{m1:[],m5:[],m15:[]},
    current:{m1:null,m5:null,m15:null},
    lastSignal:null
  };
}

const TF={m1:60000,m5:300000,m15:900000};
const MAX_CANDLES=120;

//═══════════════════════════════════════════
// CANDLE BUILDER MULTI MARCHÉ
//═══════════════════════════════════════════
function updateCandles(symbol,price,timestamp){
  const M = MARKETS[symbol];
  for(const tf of ['m1','m5','m15']){
    const p=TF[tf];
    const t=Math.floor(timestamp/p)*p;
    if(!M.current[tf]||M.current[tf].time!==t){
      if(M.current[tf]){
        M.candles[tf].push(M.current[tf]);
        if(M.candles[tf].length>MAX_CANDLES)M.candles[tf].shift();
      }
      M.current[tf]={time:t,open:price,high:price,low:price,close:price};
    }else{
      const c=M.current[tf];
      c.high=Math.max(c.high,price);
      c.low=Math.min(c.low,price);
      c.close=price;
    }
  }
}
const closes=(symbol,tf)=>[...MARKETS[symbol].candles[tf],MARKETS[symbol].current[tf]].filter(Boolean).map(c=>c.close);

//═══════════════════════════════════════════
// INDICATEURS
//═══════════════════════════════════════════
function ema(d,n){ if(d.length<n)return null; const k=2/(n+1); let e=d.slice(0,n).reduce((a,b)=>a+b)/n; for(let i=n;i<d.length;i++) e=d[i]*k+e*(1-k); return e;}
function rsi(d,n=14){ if(d.length<n+1)return null; let g=0,l=0; for(let i=d.length-n;i<d.length;i++){const df=d[i]-d[i-1]; df>0?g+=df:l-=df;} const ag=g/n,al=l/n; if(al===0)return 100; return 100-(100/(1+ag/al));}
function bollinger(d,n=20){ if(d.length<n)return null; const s=d.slice(-n); const avg=s.reduce((a,b)=>a+b)/n; const std=Math.sqrt(s.reduce((a,b)=>a+Math.pow(b-avg,2),0)/n); return{upper:avg+2*std,lower:avg-2*std};}
function trendSlope(d,n=20){ if(d.length<n)return null; const s=d.slice(-n); const xm=(n-1)/2; const ym=s.reduce((a,b)=>a+b)/n; let num=0,den=0; for(let i=0;i<n;i++){num+=(i-xm)*(s[i]-ym); den+=Math.pow(i-xm,2);} return num/den;}
function volatility(d,n=20){ if(d.length<n)return null; const s=d.slice(-n); const avg=s.reduce((a,b)=>a+b)/n; return Math.sqrt(s.reduce((a,b)=>a+Math.pow(b-avg,2),0)/n)/avg*100;}

//═══════════════════════════════════════════
// MARKET REGIME PAR MARCHÉ
//═══════════════════════════════════════════
function detectRegime(symbol){
  const d=closes(symbol,'m15');
  if(d.length<60)return 'NONE';
  const e50=ema(d,50),e200=ema(d,200);
  const slope=trendSlope(d,20);
  const vol=volatility(d,20);
  if(!e50||!e200||!slope||!vol)return 'NONE';
  const distance=Math.abs(e50-e200)/e200*100;
  if(distance>0.15&&Math.abs(slope)>0.2&&vol>0.08) return 'TREND';
  return 'RANGE';
}

//═══════════════════════════════════════════
// STRATÉGIE TREND
//═══════════════════════════════════════════
function stratTrend(symbol){
  const m1=closes(symbol,'m1');
  const m5=closes(symbol,'m5');
  const m15=closes(symbol,'m15');
  if(m1.length<20||m5.length<20||m15.length<50)return null;

  const ema200=ema(m15,200);
  const price=m1[m1.length-1];
  const r=rsi(m5);
  if(!ema200||!r)return null;

  if(price>ema200&&r>35&&r<48){
    const lastHigh=Math.max(...m1.slice(-5));
    if(price>lastHigh) return {signal:'BUY',strength:2};
  }
  if(price<ema200&&r<65&&r>52){
    const lastLow=Math.min(...m1.slice(-5));
    if(price<lastLow) return {signal:'SELL',strength:2};
  }
  return null;
}

//═══════════════════════════════════════════
// STRATÉGIE RANGE
//═══════════════════════════════════════════
function stratRange(symbol){
  const m5=closes(symbol,'m5');
  if(m5.length<25)return null;
  const bb=bollinger(m5);
  const r=rsi(m5);
  const price=m5[m5.length-1];
  if(!bb||!r)return null;
  if(price<bb.lower&&r<35) return {signal:'BUY',strength:1};
  if(price>bb.upper&&r>65) return {signal:'SELL',strength:1};
  return null;
}

//═══════════════════════════════════════════
// ANALYSE D’UN MARCHÉ
//═══════════════════════════════════════════
function analyzeMarket(symbol){
  const regime=detectRegime(symbol);
  if(regime==='TREND') return stratTrend(symbol);
  if(regime==='RANGE') return stratRange(symbol);
  return null;
}

//═══════════════════════════════════════════
// SCANNER GLOBAL → CHOISIT LE MEILLEUR SETUP
//═══════════════════════════════════════════
function scanMarkets(){
  let best=null;
  for(const symbol of SYMBOLS){
    const res=analyzeMarket(symbol);
    if(!res) continue;
    if(!best||res.strength>best.strength){
      best={symbol,...res};
    }
  }
  return best;
}

//═══════════════════════════════════════════
// TRADE
//═══════════════════════════════════════════
function send(o){ if(BOT.ws?.readyState===1) BOT.ws.send(JSON.stringify(o)); }

function placeTrade(symbol,signal){
  const stake=(BOT.balance*CONFIG.RISK_PCT).toFixed(2);
  if(stake<CONFIG.MIN_BALANCE) return;
  const duration=[3,4,5,6][Math.floor(Math.random()*4)];
  send({
    proposal:1,
    contract_type:signal==='BUY'?'CALL':'PUT',
    symbol,
    duration,duration_unit:'m',
    basis:'stake',amount:stake,currency:'USD'
  });
}

//═══════════════════════════════════════════
// WEBSOCKET CORE MULTI TICKS
//═══════════════════════════════════════════
function startBot(){
  BOT.ws=new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');
  BOT.ws.on('open',()=>{
    send({authorize:BOT.token});
    SYMBOLS.forEach(s=>send({ticks:s,subscribe:1}));
  });

  BOT.ws.on('message',msg=>{
    const d=JSON.parse(msg);

    if(d.msg_type==='authorize') BOT.balance=parseFloat(d.authorize.balance);

    if(d.msg_type==='tick'){
      const symbol=d.tick.symbol;
      const price=parseFloat(d.tick.quote);
      updateCandles(symbol,price,Date.now());

      if(BOT.openContract) return;
      if(Date.now()<BOT.pauseUntil) return;
      if(Date.now()-BOT.lastTradeTime<CONFIG.COOLDOWN_MS) return;

      const best=scanMarkets();
      if(best){
        BOT.lastTradeTime=Date.now();
        placeTrade(best.symbol,best.signal);
      }
    }

    if(d.msg_type==='proposal') send({buy:d.proposal.id,price:d.proposal.ask_price});

    if(d.msg_type==='buy'){
      BOT.openContract=d.buy.contract_id;
      send({proposal_open_contract:1,contract_id:d.buy.contract_id,subscribe:1});
    }

    if(d.msg_type==='proposal_open_contract'){
      const c=d.proposal_open_contract;
      if(c.is_expired){
        const pnl=parseFloat(c.profit||0);
        BOT.openContract=null;
        BOT.pnl+=pnl; BOT.nTrades++;
        if(pnl>=0){BOT.wins++;BOT.lossStreak=0;}
        else{BOT.losses++;BOT.lossStreak++;}

        if(BOT.lossStreak>=CONFIG.MAX_LOSSES){
          BOT.pauseUntil=Date.now()+CONFIG.LOSS_PAUSE_MS;
          BOT.lossStreak=0;
          console.log("⏸️ Pause après pertes");
        }
      }
    }
  });
}

app.listen(PORT,()=>{console.log("BOT PRO V3 MULTI running");startBot();});
