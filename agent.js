/* ============================================================================
   TRADOOR — the agent
   Holds the book, scores the board, asks the model what to do, executes on
   live DEX Screener prices and enforces the risk rules that the model is not
   allowed to argue with.

   The wallet is paper: 10 SOL, simulated fills with real slippage maths and
   real fees, marked to real market prices. Nothing touches a chain.
============================================================================ */
(function (global) {
'use strict';

var M = global.TradoorMarket;

/* --------------------------------------------------------------- rulebook */
/* ----------------------------------------------------------------------------
   The book is run for a steady stream of small realised wins, not for
   moonshots. Every position carries a SOL target — 0.20 to 0.50 net after
   fees and slippage — which is turned into a percentage against the size
   actually bought. Half comes off early, the rest runs on a tight trail.
---------------------------------------------------------------------------- */
var RULES = {
  START_SOL:      10,
  MAX_POS:        4,
  MIN_SIZE_PCT:   12,
  MAX_SIZE_PCT:   25,
  MIN_LIQ_USD:    15000,

  TARGET_SOL:     0.32,   // what a normal winner is worth, net
  TARGET_MIN_PCT: 9,      // never take a trade for less than this move
  TARGET_MAX_PCT: 30,     // never sit there waiting for more than this
  SCALE_AT:       0.5,    // scale out at half the target...
  SCALE_PORTION:  0.4,    // ...selling this much of the position
  GIVEBACK:       0.5,    // hand back at most half of an open gain

  MAX_H1:         150,    // above this the move is already somebody's exit
  MAX_M5:         40,     // never buy into a vertical candle
  STOP_PCT:      -11,
  TRAIL_PCT:      7,      // trail under the high water mark once scaled
  TIME_STOP_MIN:  25,     // dead money gets recycled
  RUG_LIQ_DROP:   0.40,

  SWAP_FEE:       0.01,   // 1% router/platform fee
  NET_FEE:        0.000005,
  SCORE_BUY:      64
};

var LLM_INTERVAL_MS = 45000;
var STORE_KEY = 'tradoor.book.v2';
var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function sig(n) {
  var s = '';
  for (var i = 0; i < (n || 88); i++) s += B58[(Math.random() * B58.length) | 0];
  return s;
}
function today() { return new Date().toISOString().slice(0, 10); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function fmtAmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}
function fmtUsd(v) {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(v < 1 ? 4 : 2);
}
function fmtPrice(p) {
  if (!p) return '0';
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.001) return p.toFixed(6);
  var e = p.toExponential(3).split('e-');
  var zeros = parseInt(e[1], 10) - 1;
  var sub = '₀₁₂₃₄₅₆₇₈₉';
  var tag = String(zeros).split('').map(function (d) { return sub[+d]; }).join('');
  return '0.0' + tag + e[0].replace('.', '').slice(0, 4);
}
function sgn(v, d) { return (v >= 0 ? '+' : '') + v.toFixed(d === undefined ? 1 : d) + '%'; }

/* ------------------------------------------------------------------ agent */
var Agent = {
  RULES: RULES,
  fmtAmt: fmtAmt, fmtUsd: fmtUsd, fmtPrice: fmtPrice, sgn: sgn,

  day: today(),
  startedAt: Date.now(),
  cash: RULES.START_SOL,
  positions: [],
  closed: [],
  txs: [],
  logs: [],
  watch: [],
  equity: [],
  archive: [],
  peak: RULES.START_SOL,
  maxDD: 0,
  fees: 0,
  nClosed: 0,
  nWins: 0,
  nTx: 0,
  realized: 0,
  scans: 0,
  llmCalls: 0,
  model: null,
  thesis: '',
  brainState: 'booting',
  brainSource: 'heuristic',
  lastLlm: 0,
  logN: 0,
  lastEquityAt: 0
};

/* ------------------------------------------------------------------- log - */
function log(kind, text, symbol) {
  Agent.logN++;
  Agent.logs.push({ n: Agent.logN, t: Date.now(), kind: kind, text: text, symbol: symbol || null });
  if (Agent.logs.length > 240) Agent.logs.shift();
}
Agent.log = log;

/* ------------------------------------------------------------- scoring --- */
function buyPressure(p) {
  var t = p.txns.m5.buys + p.txns.m5.sells;
  if (t < 4) {
    var h = p.txns.h1.buys + p.txns.h1.sells;
    return h ? p.txns.h1.buys / h : 0.5;
  }
  return p.txns.m5.buys / t;
}

Agent.score = function (p) {
  var f = {};
  var turnover = p.liqUsd > 0 ? p.vol.h1 / p.liqUsd : 0;

  f.momentum  = clamp(p.ch.m5 / 14, 0, 1) * 26;
  f.trend     = clamp((p.ch.h1 + 8) / 70, 0, 1) * 14;
  f.volume    = clamp((turnover - 0.15) / 3.2, 0, 1) * 18;
  f.liquidity = clamp((Math.log10(Math.max(p.liqUsd, 1)) - 4) / 1.7, 0, 1) * 13;
  f.pressure  = clamp((buyPressure(p) - 0.46) / 0.26, 0, 1) * 14;
  f.quality   = (p.socials.length ? 5 : 0) + (p.image ? 2 : 0)
              + (p.boosts > 0 ? 4 : 0) + (p.website ? 2 : 0)
              + (p.ageHours !== null && p.ageHours > 1 && p.ageHours < 96 ? 2 : 0);

  var score = f.momentum + f.trend + f.volume + f.liquidity + f.pressure + f.quality;
  var flags = [];

  if (p.liqUsd < RULES.MIN_LIQ_USD) { score -= 26; flags.push('liquidity ' + fmtUsd(p.liqUsd) + ' under the floor'); }
  if (p.ch.h1 > 150)                { score -= 20; flags.push('1h already ' + sgn(p.ch.h1, 0) + ' — late to it'); }
  if (p.ch.m5 > 40)                 { score -= 12; flags.push('5m candle is vertical — no entry here'); }
  if (p.ch.m5 <= 0)                 { score -= 12; flags.push('no 5m impulse'); }
  if (p.ch.h24 < -55)               { score -= 10; flags.push('24h ' + sgn(p.ch.h24, 0)); }
  if (p.ageHours !== null && p.ageHours < 0.25) { score -= 12; flags.push('under 15 minutes old'); }
  if (turnover < 0.08)              { score -= 12; flags.push('volume too thin against the pool'); }
  if (buyPressure(p) < 0.45)        { score -= 10; flags.push('sellers in control on 5m'); }

  return { score: clamp(score, 0, 100), f: f, flags: flags, turnover: turnover, pressure: buyPressure(p) };
};

/* the hard gate. Scoring can argue about how good a setup is; this decides
   whether it is allowed at all, for the model and the built-in brain alike.
   Returns null when the pair is tradeable, or the reason it is not. */
function veto(p) {
  if (p.liqUsd < RULES.MIN_LIQ_USD)
    return 'liquidity ' + fmtUsd(p.liqUsd) + ' is under the ' + fmtUsd(RULES.MIN_LIQ_USD) + ' floor';
  if (p.ch.h1 > RULES.MAX_H1)
    return '1h already ' + sgn(p.ch.h1, 0) + ' — that is somebody else’s exit';
  if (p.ch.m5 > RULES.MAX_M5)
    return '5m candle is vertical (' + sgn(p.ch.m5, 0) + ') — not chasing it';
  return null;
}
Agent.veto = veto;

Agent.ranked = function () {
  var out = M.pairs.map(function (p) {
    var s = Agent.score(p);
    p.score = s.score;
    p.flags = s.flags;
    p.turnover = s.turnover;
    p.pressure = s.pressure;
    return { p: p, s: s };
  });
  out.sort(function (a, b) { return b.s.score - a.s.score; });
  return out;
};

/* ------------------------------------------------------------ execution -- */
function impactPct(sizeUsd, liqUsd) {
  if (!liqUsd) return 45;
  return Math.min(45, (sizeUsd / (liqUsd * 0.5 + sizeUsd)) * 100 * 1.35);
}
var ROUTES = ['Jupiter v6', 'Raydium CLMM', 'Meteora DLMM', 'Orca Whirlpool', 'pump.fun AMM'];

function recordTx(o) {
  var tx = {
    sig: sig(88),
    slot: 0,
    t: Date.now(),
    side: o.side,
    symbol: o.symbol,
    address: o.address,
    url: o.url,
    sol: o.sol,
    tokens: o.tokens,
    priceUsd: o.priceUsd,
    impact: o.impact,
    fee: o.fee,
    priority: o.priority,
    cu: 60000 + ((Math.random() * 90000) | 0),
    route: o.route,
    pnl: o.pnl === undefined ? null : o.pnl,
    status: 'confirmed'
  };
  /* a plausible slot number: mainnet does about 2.5 per second */
  tx.slot = 372000000 + Math.floor((Date.now() - 1767225600000) / 400);
  Agent.txs.unshift(tx);
  Agent.nTx++;
  if (Agent.txs.length > 60) Agent.txs.pop();
  return tx;
}

Agent.equityNow = function () {
  var v = Agent.cash;
  Agent.positions.forEach(function (pos) {
    var p = M.byAddress[pos.address];
    var priceUsd = p ? p.priceUsd : pos.lastUsd;
    v += M.toSol(pos.tokens * priceUsd);
  });
  return v;
};

function buy(p, sizeSol, reason, conviction) {
  var sizeUsd = M.toUsd(sizeSol);
  var imp = impactPct(sizeUsd, p.liqUsd);
  var priority = 0.00025 + Math.random() * 0.0016;
  var spend = sizeSol + RULES.NET_FEE + priority;
  if (spend > Agent.cash) return null;

  var fillUsd = p.priceUsd * (1 + imp / 100);
  var tokens = M.toUsd(sizeSol * (1 - RULES.SWAP_FEE)) / fillUsd;

  Agent.cash -= spend;
  Agent.fees += RULES.NET_FEE + priority + sizeSol * RULES.SWAP_FEE;

  /* what it costs to get back out: the router fee plus the slippage the exit
     will eat. The SOL target is set on top of that, so the number the tape
     prints is what actually lands in the wallet. */
  var exitCost = RULES.SWAP_FEE * 100 + imp;
  var targetPct = clamp((RULES.TARGET_SOL / sizeSol) * 100 + exitCost,
                        RULES.TARGET_MIN_PCT, RULES.TARGET_MAX_PCT);

  var pos = {
    address: p.address, symbol: p.symbol, name: p.name, image: p.image, url: p.url,
    tokens: tokens, costSol: sizeSol, entryUsd: sizeUsd / tokens, lastUsd: p.priceUsd,
    entryAt: Date.now(), peakUsd: p.priceUsd, peakPct: 0, scaled: false, trail: false,
    liqAtEntry: p.liqUsd, reason: reason || '', conviction: conviction || 0,
    exitCost: exitCost, targetPct: targetPct,
    targetSol: sizeSol * (targetPct - exitCost) / 100
  };
  Agent.positions.push(pos);

  var tx = recordTx({
    side: 'BUY', symbol: p.symbol, address: p.address, url: p.url, sol: sizeSol,
    tokens: tokens, priceUsd: fillUsd, impact: imp, fee: RULES.NET_FEE,
    priority: priority, route: ROUTES[(Math.random() * ROUTES.length) | 0]
  });

  log('exec', 'BUY  ' + sizeSol.toFixed(3) + ' SOL → ' + fmtAmt(tokens) + ' ' + p.symbol +
    ' @ ' + fmtPrice(fillUsd) + ' · impact ' + imp.toFixed(2) + '% · ' + tx.route, p.symbol);
  log('manage', 'PLAN  ' + p.symbol + ' target +' + targetPct.toFixed(1) + '% ≈ +' +
    pos.targetSol.toFixed(2) + ' SOL net · scale ' + Math.round(RULES.SCALE_PORTION * 100) +
    '% at +' + (targetPct * RULES.SCALE_AT).toFixed(1) + '% · stop ' + RULES.STOP_PCT + '%', p.symbol);
  save();
  return pos;
}

function sell(pos, portion, reason) {
  var p = M.byAddress[pos.address];
  var priceUsd = p ? p.priceUsd : pos.lastUsd;
  var tokens = pos.tokens * portion;
  var grossUsd = tokens * priceUsd;
  var imp = impactPct(grossUsd, p ? p.liqUsd : grossUsd * 4);
  var priority = 0.00025 + Math.random() * 0.0016;
  var outSol = M.toSol(grossUsd * (1 - imp / 100) * (1 - RULES.SWAP_FEE));
  var basis = pos.costSol * portion;
  var pnl = outSol - basis;

  Agent.cash += outSol - RULES.NET_FEE - priority;
  Agent.fees += RULES.NET_FEE + priority + M.toSol(grossUsd) * RULES.SWAP_FEE;
  pos.tokens -= tokens;
  pos.costSol -= basis;

  recordTx({
    side: 'SELL', symbol: pos.symbol, address: pos.address, url: pos.url, sol: outSol,
    tokens: tokens, priceUsd: priceUsd * (1 - imp / 100), impact: imp, fee: RULES.NET_FEE,
    priority: priority, route: ROUTES[(Math.random() * ROUTES.length) | 0], pnl: pnl
  });

  var rec = {
    symbol: pos.symbol, name: pos.name, image: pos.image, address: pos.address, url: pos.url,
    sol: outSol, pnl: pnl, pct: basis > 0 ? pnl / basis : 0, reason: reason,
    heldMs: Date.now() - pos.entryAt, t: Date.now(), portion: portion
  };
  Agent.closed.push(rec);
  if (Agent.closed.length > 80) Agent.closed.shift();
  Agent.nClosed++;
  if (pnl > 0) Agent.nWins++;
  Agent.realized += pnl;

  log(pnl >= 0 ? 'win' : 'loss',
    'SELL ' + fmtAmt(tokens) + ' ' + pos.symbol + ' → ' + outSol.toFixed(3) + ' SOL · ' +
    (pnl >= 0 ? '+' : '') + pnl.toFixed(3) + ' SOL (' + sgn(rec.pct * 100) + ') · ' + reason,
    pos.symbol);

  if (portion >= 0.999 || pos.tokens <= 0) {
    var i = Agent.positions.indexOf(pos);
    if (i > -1) Agent.positions.splice(i, 1);
  }
  save();
  return pnl;
}
Agent.sell = sell;

/* ------------------------------------------------------------ risk pass -- */
function manage() {
  for (var i = Agent.positions.length - 1; i >= 0; i--) {
    var pos = Agent.positions[i];
    var p = M.byAddress[pos.address];
    if (!p) {
      /* no quote this pass — give the feed ten minutes, then get out at the last mark */
      pos.staleSince = pos.staleSince || Date.now();
      if (Date.now() - pos.staleSince > 600000) {
        log('risk', 'RISK  ' + pos.symbol + ' has had no quote for 10 minutes — closing at the last mark', pos.symbol);
        sell(pos, 1, 'no market data');
      }
      continue;
    }
    pos.staleSince = 0;
    pos.lastUsd = p.priceUsd;
    if (p.priceUsd > pos.peakUsd) pos.peakUsd = p.priceUsd;

    /* backwards compatibility with a book saved under the old rulebook */
    if (pos.targetPct === undefined) {
      pos.exitCost = RULES.SWAP_FEE * 100 + 1.5;
      pos.targetPct = clamp((RULES.TARGET_SOL / Math.max(pos.costSol, 0.01)) * 100 + pos.exitCost,
                            RULES.TARGET_MIN_PCT, RULES.TARGET_MAX_PCT);
      pos.targetSol = pos.costSol * (pos.targetPct - pos.exitCost) / 100;
      pos.scaled = !!pos.tp1;
      pos.peakPct = 0;
    }

    var pnlPct = (p.priceUsd / pos.entryUsd - 1) * 100;
    var heldMin = (Date.now() - pos.entryAt) / 60000;
    if (pnlPct > pos.peakPct) pos.peakPct = pnlPct;

    /* the pool is draining — nothing else matters */
    if (p.liqUsd < pos.liqAtEntry * (1 - RULES.RUG_LIQ_DROP)) {
      log('risk', 'RISK  ' + pos.symbol + ' pool down to ' + fmtUsd(p.liqUsd) + ' from ' +
        fmtUsd(pos.liqAtEntry) + ' — getting out now', pos.symbol);
      sell(pos, 1, 'liquidity guard'); continue;
    }

    if (pnlPct <= RULES.STOP_PCT) { sell(pos, 1, 'stop loss'); continue; }

    /* target reached — take the win and free the slot */
    if (pnlPct >= pos.targetPct) { sell(pos, 1, 'target hit'); continue; }

    /* half way there: bank a slice so the trade cannot go red on us */
    if (!pos.scaled && pnlPct >= pos.targetPct * RULES.SCALE_AT) {
      pos.scaled = true;
      pos.trail = true;
      log('manage', 'SCALE ' + pos.symbol + ' ' + sgn(pnlPct) + ' — taking ' +
        Math.round(RULES.SCALE_PORTION * 100) + '% off, trailing the rest ' +
        RULES.TRAIL_PCT + '% under the high', pos.symbol);
      sell(pos, RULES.SCALE_PORTION, 'scale out'); continue;
    }

    /* the runner is trailed once the first slice is banked */
    if (pos.trail && p.priceUsd <= pos.peakUsd * (1 - RULES.TRAIL_PCT / 100)) {
      sell(pos, 1, 'trailing stop'); continue;
    }

    /* never hand back more than half of a gain worth having */
    if (pos.peakPct > pos.exitCost + 4 && pnlPct <= pos.peakPct * (1 - RULES.GIVEBACK)) {
      log('manage', 'FADE  ' + pos.symbol + ' gave back half of ' + sgn(pos.peakPct) +
        ' — closing what is left', pos.symbol);
      sell(pos, 1, 'giving back the gain'); continue;
    }

    /* dead money: the slot is worth more than the position */
    if (heldMin > RULES.TIME_STOP_MIN && pnlPct < pos.exitCost + 2) {
      sell(pos, 1, 'time stop'); continue;
    }
  }
}

/* -------------------------------------------------------------- the LLM -- */
function positionsForModel() {
  return Agent.positions.map(function (pos) {
    var p = M.byAddress[pos.address];
    var mark = p ? p.priceUsd : pos.lastUsd;
    var value = M.toSol(pos.tokens * mark);
    return {
      symbol: pos.symbol, address: pos.address,
      entryUsd: pos.entryUsd, markUsd: mark,
      pnlPct: (mark / pos.entryUsd - 1) * 100,
      pnlSol: value - pos.costSol,
      valueSol: value,
      targetPct: pos.targetPct || 0,
      scaledOut: !!pos.scaled,
      heldMinutes: (Date.now() - pos.entryAt) / 60000
    };
  });
}

function applyActions(res, ranked) {
  var byAddr = {};
  ranked.forEach(function (r) { byAddr[r.p.address] = r.p; });
  var acted = false;

  (res.actions || []).forEach(function (a) {
    if (!a || !a.address) return;
    var p = byAddr[a.address] || M.byAddress[a.address];
    var holding = Agent.positions.filter(function (x) { return x.address === a.address; })[0];

    if (String(a.type).toUpperCase() === 'SELL') {
      if (!holding) { log('think', 'REJECT model wanted to sell something the book does not hold', null); return; }
      log('thesis', 'MODEL ' + holding.symbol + ' — ' + (a.reason || 'close it'), holding.symbol);
      sell(holding, 1, 'model exit');
      acted = true;
      return;
    }

    if (String(a.type).toUpperCase() !== 'BUY') return;
    if (!p) { log('think', 'REJECT model proposed a mint that is not on the board', null); return; }
    if (holding) return;
    if (Agent.positions.length >= RULES.MAX_POS) {
      log('think', 'REJECT BUY ' + p.symbol + ' — book already full at ' + RULES.MAX_POS + ' positions', p.symbol);
      return;
    }
    var blocked = veto(p);
    if (blocked) {
      log('think', 'REJECT BUY ' + p.symbol + ' — ' + blocked, p.symbol);
      return;
    }
    var equity = Agent.equityNow();
    var pctSize = clamp(Number(a.sizePct) || 15, RULES.MIN_SIZE_PCT, RULES.MAX_SIZE_PCT);
    var size = Math.min(equity * pctSize / 100, Agent.cash - 0.05);
    if (size < 0.12) {
      log('think', 'REJECT BUY ' + p.symbol + ' — only ' + Agent.cash.toFixed(3) + ' SOL free', p.symbol);
      return;
    }
    log('thesis', 'MODEL ' + p.symbol + ' — 5m ' + sgn(p.ch.m5) + ' · 1h ' + sgn(p.ch.h1) +
      ' · LP ' + fmtUsd(p.liqUsd) + ' · vol 1h ' + fmtUsd(p.vol.h1) +
      ' · conviction ' + (a.conviction || '?') + '/100 → ' + (a.reason || 'buy'), p.symbol);
    buy(p, size, a.reason, a.conviction);
    acted = true;
  });

  /* the model's own watchlist wins over the heuristic one */
  if (Array.isArray(res.watch) && res.watch.length) {
    var w = [];
    res.watch.forEach(function (it) {
      var p = byAddr[it.address] || M.byAddress[it.address];
      if (!p) return;
      w.push({ p: p, note: String(it.reason || 'watching').slice(0, 110), score: p.score || 0 });
    });
    if (w.length) Agent.watch = w.slice(0, 6);
  }
  return acted;
}

function heuristicDecision(ranked) {
  Agent.brainSource = 'heuristic';
  if (!ranked.length || Agent.positions.length >= RULES.MAX_POS) return;

  var held = {};
  Agent.positions.forEach(function (p) { held[p.address] = 1; });

  var spoke = false;
  for (var i = 0; i < Math.min(ranked.length, 8); i++) {
    var r = ranked[i];
    if (held[r.p.address]) continue;

    /* sorted by score, so once we are under the threshold nothing below qualifies */
    if (r.s.score < RULES.SCORE_BUY) {
      if (!spoke && r.s.score > 50) {
        log('think', 'PASS  ' + r.p.symbol + ' ' + r.s.score.toFixed(1) + '/100 — ' +
          (r.s.flags[0] || 'conviction under threshold') + ' · threshold ' + RULES.SCORE_BUY, r.p.symbol);
      }
      break;
    }
    var no = veto(r.p);
    if (no) {
      if (!spoke) { spoke = true; log('think', 'PASS  ' + r.p.symbol + ' — ' + no, r.p.symbol); }
      continue;
    }
    var equity = Agent.equityNow();
    var size = Math.min(equity * 0.20, Agent.cash - 0.05);
    if (size < 0.12) return;
    log('thesis', 'THESIS ' + r.p.symbol + ' — 5m ' + sgn(r.p.ch.m5) + ' · 1h ' + sgn(r.p.ch.h1) +
      ' · LP ' + fmtUsd(r.p.liqUsd) + ' · turnover ×' + r.s.turnover.toFixed(2) +
      ' · buy pressure ' + (r.s.pressure * 100).toFixed(0) + '% → score ' +
      r.s.score.toFixed(1) + '/100', r.p.symbol);
    buy(r.p, size, 'momentum + liquidity filter', Math.round(r.s.score));
    return;
  }
}

function askModel(ranked) {
  Agent.brainState = 'thinking';
  var payload = {
    equity: Agent.equityNow(),
    cash: Agent.cash,
    pnlPct: (Agent.equityNow() / RULES.START_SOL - 1) * 100,
    positions: positionsForModel(),
    candidates: ranked.slice(0, 14).map(function (r) { return r.p; })
  };

  return fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (!res || !res.ok) {
      Agent.brainSource = 'heuristic';
      var why = res && res.reason;
      Agent.warned = Agent.warned || {};
      if (why && !Agent.warned[why]) {
        Agent.warned[why] = true;
        if (why === 'no-key') {
          log('boot', 'NOTE  no FAL_KEY on this deployment — running the built-in scoring model instead', null);
        } else if (why === 'fal-error' || why === 'unparseable') {
          log('boot', 'NOTE  model call failed (' + String(res.error || res.raw || '').slice(0, 120) +
            ') — falling back to the built-in scoring model', null);
        }
      }
      heuristicDecision(ranked);
      return;
    }
    Agent.llmCalls++;
    Agent.model = res.model;
    Agent.brainSource = 'model';
    if (res.thesis) {
      Agent.thesis = res.thesis;
      log('scan', 'READ  ' + res.thesis, null);
    }
    var acted = applyActions(res, ranked);
    if (!acted && (!res.actions || !res.actions.length)) {
      log('think', 'HOLD  model sees nothing worth the risk right now · ' +
        ranked.length + ' pairs scored · leader ' + (ranked[0] ? ranked[0].p.symbol : '—'), null);
    }
  }).catch(function () {
    Agent.brainSource = 'heuristic';
    heuristicDecision(ranked);
  }).then(function () {
    Agent.brainState = Agent.positions.length >= RULES.MAX_POS ? 'fully allocated'
      : Agent.positions.length ? 'in position' : 'hunting';
    save();
  });
}

/* ------------------------------------------------------------ the ticker - */
Agent.tick = function () {
  if (!M.ready) return;
  rollDay();

  var ranked = Agent.ranked();
  Agent.scans++;
  manage();

  /* heuristic watchlist between model calls */
  if (Agent.brainSource !== 'model' || !Agent.watch.length) {
    var held = {};
    Agent.positions.forEach(function (p) { held[p.address] = 1; });
    Agent.watch = ranked.filter(function (r) {
      return !held[r.p.address] && r.s.score > 30;
    }).slice(0, 6).map(function (r) {
      return {
        p: r.p, score: r.s.score,
        note: r.s.score >= RULES.SCORE_BUY ? 'entry conditions met — sizing the order'
            : r.s.flags[0] ? r.s.flags[0]
            : 'waiting for a clean 5m impulse'
      };
    });
  }

  var now = Date.now();
  if (now - Agent.lastLlm >= LLM_INTERVAL_MS) {
    Agent.lastLlm = now;
    askModel(ranked);
  }

  if (now - Agent.lastEquityAt > 60000) {
    Agent.lastEquityAt = now;
    var eq = Agent.equityNow();
    Agent.equity.push([now, eq]);
    if (Agent.equity.length > 1500) Agent.equity.shift();
    if (eq > Agent.peak) Agent.peak = eq;
    var dd = 1 - eq / Agent.peak;
    if (dd > Agent.maxDD) Agent.maxDD = dd;
    save();
  }
};

Agent.stats = function () {
  var eq = Agent.equityNow();
  var best = null, worst = null;
  Agent.closed.forEach(function (t) {
    if (!best || t.pct > best.pct) best = t;
    if (!worst || t.pct < worst.pct) worst = t;
  });
  return {
    equity: eq, cash: Agent.cash,
    pnl: eq - RULES.START_SOL, pnlPct: eq / RULES.START_SOL - 1,
    realized: Agent.realized, trades: Agent.nTx, closed: Agent.nClosed, wins: Agent.nWins,
    winRate: Agent.nClosed ? Agent.nWins / Agent.nClosed : 0,
    best: best, worst: worst, fees: Agent.fees, maxDD: Agent.maxDD,
    open: Agent.positions.length, scans: Agent.scans, llmCalls: Agent.llmCalls,
    state: Agent.brainState, source: Agent.brainSource, model: Agent.model
  };
};

/* ------------------------------------------------------ save / restore --- */
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      day: Agent.day, startedAt: Agent.startedAt, cash: Agent.cash,
      positions: Agent.positions, closed: Agent.closed.slice(-60), txs: Agent.txs.slice(0, 40),
      logs: Agent.logs.slice(-120), equity: Agent.equity.slice(-600), archive: Agent.archive.slice(-14),
      peak: Agent.peak, maxDD: Agent.maxDD, fees: Agent.fees, nClosed: Agent.nClosed,
      nWins: Agent.nWins, nTx: Agent.nTx, realized: Agent.realized, scans: Agent.scans,
      llmCalls: Agent.llmCalls, model: Agent.model, logN: Agent.logN
    }));
  } catch (e) { /* private mode, quota — the agent just forgets on reload */ }
}

function restore() {
  var raw;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return false; }
  if (!raw) return false;
  try {
    var s = JSON.parse(raw);
    if (!s || s.day !== today()) { archiveFrom(s); return false; }
    ['startedAt','cash','peak','maxDD','fees','nClosed','nWins','nTx','realized','scans','llmCalls','model','logN']
      .forEach(function (k) { if (s[k] !== undefined) Agent[k] = s[k]; });
    ['positions','closed','txs','logs','equity','archive'].forEach(function (k) {
      if (Array.isArray(s[k])) Agent[k] = s[k];
    });
    Agent.day = s.day;
    return true;
  } catch (e) { return false; }
}

function archiveFrom(s) {
  if (!s || !s.day) return;
  var close = s.equity && s.equity.length ? s.equity[s.equity.length - 1][1] : RULES.START_SOL;
  Agent.archive = (Array.isArray(s.archive) ? s.archive : []).concat([{
    date: s.day,
    close: close,
    pnlPct: close / RULES.START_SOL - 1,
    trades: s.nTx || 0,
    winRate: s.nClosed ? (s.nWins || 0) / s.nClosed : 0
  }]).slice(-14);
}

function rollDay() {
  if (Agent.day === today()) return;
  archiveFrom({
    day: Agent.day, equity: Agent.equity, archive: Agent.archive,
    nTx: Agent.nTx, nWins: Agent.nWins, nClosed: Agent.nClosed
  });
  Agent.day = today();
  Agent.startedAt = Date.now();
  Agent.cash = RULES.START_SOL;
  Agent.positions = []; Agent.closed = []; Agent.txs = []; Agent.equity = [];
  Agent.peak = RULES.START_SOL; Agent.maxDD = 0; Agent.fees = 0;
  Agent.nClosed = 0; Agent.nWins = 0; Agent.nTx = 0; Agent.realized = 0;
  Agent.scans = 0; Agent.llmCalls = 0; Agent.thesis = '';
  log('boot', 'BOOT  new session · wallet reset to ' + RULES.START_SOL.toFixed(3) + ' SOL', null);
  save();
}

/* the paper wallet's address — generated once per browser, then kept */
function walletAddress() {
  var k = 'tradoor.wallet';
  try {
    var w = localStorage.getItem(k);
    if (w) return w;
  } catch (e) {}
  var w2 = 'Trdr' + sig(40);
  try { localStorage.setItem(k, w2); } catch (e) {}
  return w2;
}

Agent.init = function () {
  Agent.wallet = walletAddress();
  var restored = restore();
  if (!restored) {
    log('boot', 'BOOT  Tradoor online · paper wallet funded with 10.000 SOL', null);
    log('boot', 'BOOT  objective — bank 0.20 to 0.50 SOL a trade, over and over. No moonshots.', null);
    log('boot', 'BOOT  risk limits — max ' + RULES.MAX_POS + ' positions · stop ' + RULES.STOP_PCT +
      '% · trail ' + RULES.TRAIL_PCT + '% · liquidity floor ' + fmtUsd(RULES.MIN_LIQ_USD) +
      ' · board floor $100K market cap', null);
    log('boot', 'BOOT  scanning Solana pairs from DEX Screener · decisions by the model on fal.ai', null);
  } else {
    log('boot', 'BOOT  session restored · ' + Agent.positions.length + ' open · ' +
      Agent.nTx + ' transactions on the tape', null);
  }
  return Agent;
};

global.TradoorAgent = Agent;
})(window);
