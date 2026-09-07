/* ============================================================================
   TRADOOR — the agent
   Holds the book, scores the board, asks the model what to do, executes on
   live DEX Screener prices and enforces the risk rules that the model is not
   allowed to argue with.

   The wallet is paper: 1 ETH, simulated fills with real slippage maths and
   real fees, marked to real market prices. Nothing touches a chain.
============================================================================ */
(function (global) {
'use strict';

var M = global.TradoorMarket;

/* --------------------------------------------------------------- rulebook */
/* ----------------------------------------------------------------------------
   The book is run for a steady stream of small realised wins, not for
   moonshots. Every position carries an ETH target — 0.04 to 0.1 net after
   fees and slippage — which is turned into a percentage against the size
   actually bought. Half comes off early, the rest runs on a tight trail.
---------------------------------------------------------------------------- */
var RULES = {
  START_ETH:      1,
  MAX_POS:        5,
  MIN_SIZE_PCT:   12,
  MAX_SIZE_PCT:   25,
  MIN_LIQ_USD:    8000,

  TARGET_ETH:     0.055,   // what a normal winner is worth, net
  TARGET_MIN_PCT: 15,     // never take a trade for less than this move
  TARGET_MAX_PCT: 60,     // never sit there waiting for more than this
  SCALE_AT:       0.5,    // scale out at half the target...
  SCALE_PORTION:  0.35,   // ...selling this much of the position
  BANK_PORTION:   0.6,    // at the full target, bank this much of what is left...
  RUNNER_CAP:     2.2,    // ...and the runner is cut at target × this, no matter what
  GIVEBACK:       0.5,    // hand back at most half of an open gain

  MAX_H1:         150,    // above this the move is already somebody's exit
  MAX_M5:         40,     // never buy into a vertical candle
  STOP_PCT:      -11,
  TRAIL_PCT:      10,     // trail under the high water mark once scaled
  TIME_STOP_MIN:  35,     // dead money gets recycled
  RUG_LIQ_DROP:   0.40,

  /* the launch snipe: a pair that was just listed on Robinhood Chain.
     The first hour decides, so this lane is smaller, faster and tighter. */
  SNIPE_AGE_MIN:  75,     // tradeable as a snipe this long after listing
  SNIPE_SIZE_PCT: 10,     // smaller clip — these can halve in minutes
  SNIPE_STOP:    -9,
  SNIPE_TIME_MIN: 15,     // in and out; a stalled snipe is a failed snipe
  SNIPE_MAX_M5:   90,     // fresh listings are allowed a vertical candle
  SNIPE_SCORE:    56,     // lower bar — recency is the edge, not the score

  /* discipline */
  REBUY_COOL_MIN: 10,     // no re-entering a name just closed (20 after a loss)
  LOSS_STREAK:    3,      // this many full-close losses in a row...
  PAUSE_MIN:      10,     // ...parks new entries for this long
  AUTO_GAP_MS:    40000,  // built-in entries at most this often

  SWAP_FEE:       0.01,   // 1% router/platform fee
  NET_FEE:        0.000005,
  SCORE_BUY:      64,
  FAST_SCORE:     68      // above this the built-in brain fires between model calls
};

var LLM_INTERVAL_MS = 40000;
var STORE_KEY = 'tradoor.book.v3';
var HEX = '0123456789abcdef';

/* Robinhood Chain is an EVM L2, so everything is 0x-flavoured */
function hex(n) {
  var s = '';
  for (var i = 0; i < n; i++) s += HEX[(Math.random() * 16) | 0];
  return s;
}
function sig() { return '0x' + hex(64); }
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
  cash: RULES.START_ETH,
  positions: [],
  closed: [],
  txs: [],
  logs: [],
  watch: [],
  equity: [],
  archive: [],
  peak: RULES.START_ETH,
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
  lastEquityAt: 0,
  cooldowns: {},          // address -> timestamp until which it may not be rebought
  lossStreak: 0,
  pausedUntil: 0,
  lastAutoBuy: 0
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

/* a pair inside the launch-snipe window: a pair that hit Robinhood Chain
   less than SNIPE_AGE_MIN minutes ago */
function snipeWindow(p) {
  return !!p.isFresh && p.ageHours !== null && p.ageHours * 60 <= RULES.SNIPE_AGE_MIN;
}
Agent.snipeWindow = snipeWindow;

Agent.score = function (p) {
  var f = {};
  var turnover = p.liqUsd > 0 ? p.vol.h1 / p.liqUsd : 0;
  var fresh = snipeWindow(p);

  f.momentum  = clamp(p.ch.m5 / 14, 0, 1) * 26;
  f.trend     = clamp((p.ch.h1 + 8) / 70, 0, 1) * 14;
  f.volume    = clamp((turnover - 0.15) / 3.2, 0, 1) * 18;
  f.liquidity = clamp((Math.log10(Math.max(p.liqUsd, 1)) - 4) / 1.7, 0, 1) * 13;
  f.pressure  = clamp((buyPressure(p) - 0.46) / 0.26, 0, 1) * 14;
  f.quality   = (p.socials.length ? 5 : 0) + (p.image ? 2 : 0)
              + (p.boosts > 0 ? 4 : 0) + (p.website ? 2 : 0)
              + (p.ageHours !== null && p.ageHours > 1 && p.ageHours < 96 ? 2 : 0);
  /* the launch window itself is worth something — decaying as it closes */
  f.fresh = fresh ? (1 - (p.ageHours * 60) / RULES.SNIPE_AGE_MIN) * 8 : 0;

  var score = f.momentum + f.trend + f.volume + f.liquidity + f.pressure + f.quality + f.fresh;
  var flags = [];

  if (p.liqUsd < RULES.MIN_LIQ_USD) { score -= 26; flags.push('liquidity ' + fmtUsd(p.liqUsd) + ' under the floor'); }
  if (p.ch.h1 > 150 && !fresh)      { score -= 20; flags.push('1h already ' + sgn(p.ch.h1, 0) + ' — late to it'); }
  if (p.ch.m5 > (fresh ? RULES.SNIPE_MAX_M5 : RULES.MAX_M5))
                                    { score -= 12; flags.push('5m candle is vertical — no entry here'); }
  if (p.ch.m5 <= 0)                 { score -= 12; flags.push('no 5m impulse'); }
  if (p.ch.h24 < -55)               { score -= 10; flags.push('24h ' + sgn(p.ch.h24, 0)); }
  if (!fresh && p.ageHours !== null && p.ageHours < 0.25) { score -= 12; flags.push('under 15 minutes old'); }
  if (turnover < 0.08 && !fresh)    { score -= 12; flags.push('volume too thin against the pool'); }
  if (buyPressure(p) < 0.45)        { score -= 10; flags.push('sellers in control on 5m'); }

  return { score: clamp(score, 0, 100), f: f, flags: flags, turnover: turnover,
           pressure: buyPressure(p), fresh: fresh };
};

/* the hard gate. Scoring can argue about how good a setup is; this decides
   whether it is allowed at all, for the model and the built-in brain alike.
   Returns null when the pair is tradeable, or the reason it is not. */
function veto(p) {
  var fresh = snipeWindow(p);
  if (p.liqUsd < RULES.MIN_LIQ_USD)
    return 'liquidity ' + fmtUsd(p.liqUsd) + ' is under the ' + fmtUsd(RULES.MIN_LIQ_USD) + ' floor';
  /* a fresh listing's 1h change is its whole life on the chain — that spike
     the setup, not the exit. The cap only binds outside the snipe window. */
  if (!fresh && p.ch.h1 > RULES.MAX_H1)
    return '1h already ' + sgn(p.ch.h1, 0) + ' — that is somebody else’s exit';
  if (p.ch.m5 > (fresh ? RULES.SNIPE_MAX_M5 : RULES.MAX_M5))
    return '5m candle is vertical (' + sgn(p.ch.m5, 0) + ') — not chasing it';
  return null;
}
Agent.veto = veto;

/* everything that can block an entry, in one place */
function entryBlock(p) {
  var now = Date.now();
  if (Agent.positions.length >= RULES.MAX_POS) return 'book full at ' + RULES.MAX_POS;
  if (now < Agent.pausedUntil)
    return 'cooling off after ' + RULES.LOSS_STREAK + ' straight losses (' +
      Math.ceil((Agent.pausedUntil - now) / 60000) + 'm left)';
  var held = Agent.positions.some(function (x) { return x.address === p.address; });
  if (held) return 'already holding it';
  var cool = Agent.cooldowns[p.address] || 0;
  if (now < cool) return 'just traded it — ' + Math.ceil((cool - now) / 60000) + 'm cooldown';
  return veto(p);
}

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
var ROUTES = ['Uniswap v4', 'Uniswap v3', '0x Router', '1inch', 'Matcha'];

function recordTx(o) {
  var tx = {
    sig: sig(),
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
    cu: 120000 + ((Math.random() * 230000) | 0),      // gas used by the swap
    route: o.route,
    pnl: o.pnl === undefined ? null : o.pnl,
    status: 'confirmed'
  };
  /* a plausible block number: the L2 seals roughly one block a second */
  tx.slot = 21400000 + Math.floor((Date.now() - 1767225600000) / 1000);
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
    v += M.toEth(pos.tokens * priceUsd);
  });
  return v;
};

function buy(p, sizeSol, reason, conviction, lane) {
  var sizeUsd = M.toUsd(sizeSol);
  var imp = impactPct(sizeUsd, p.liqUsd);
  var priority = 0.00001 + Math.random() * 0.00003;
  var spend = sizeSol + RULES.NET_FEE + priority;
  if (spend > Agent.cash) return null;

  var snipe = lane === 'snipe';
  var fillUsd = p.priceUsd * (1 + imp / 100);
  var tokens = M.toUsd(sizeSol * (1 - RULES.SWAP_FEE)) / fillUsd;

  Agent.cash -= spend;
  Agent.fees += RULES.NET_FEE + priority + sizeSol * RULES.SWAP_FEE;

  /* what it costs to get back out: the router fee plus the slippage the exit
     will eat. The ETH target is set on top of that, so the number the tape
     prints is what actually lands in the wallet. */
  var exitCost = RULES.SWAP_FEE * 100 + imp;
  var targetPct = snipe
    ? clamp((RULES.TARGET_ETH * 0.85 / sizeSol) * 100 + exitCost, 18, 45)
    : clamp((RULES.TARGET_ETH / sizeSol) * 100 + exitCost,
            RULES.TARGET_MIN_PCT, RULES.TARGET_MAX_PCT);

  var pos = {
    address: p.address, symbol: p.symbol, name: p.name, image: p.image, url: p.url,
    tokens: tokens, costEth: sizeSol, entryUsd: sizeUsd / tokens, lastUsd: p.priceUsd,
    entryAt: Date.now(), peakUsd: p.priceUsd, peakPct: 0, scaled: false, trail: false,
    liqAtEntry: p.liqUsd, reason: reason || '', conviction: conviction || 0,
    lane: snipe ? 'snipe' : 'swing',
    stopPct: snipe ? RULES.SNIPE_STOP : RULES.STOP_PCT,
    timeStopMin: snipe ? RULES.SNIPE_TIME_MIN : RULES.TIME_STOP_MIN,
    exitCost: exitCost, targetPct: targetPct,
    targetEth: sizeSol * (targetPct - exitCost) / 100
  };
  Agent.positions.push(pos);

  var tx = recordTx({
    side: 'BUY', symbol: p.symbol, address: p.address, url: p.url, sol: sizeSol,
    tokens: tokens, priceUsd: fillUsd, impact: imp, fee: RULES.NET_FEE,
    priority: priority, route: ROUTES[(Math.random() * ROUTES.length) | 0]
  });

  log('exec', 'BUY  ' + sizeSol.toFixed(3) + ' ETH → ' + fmtAmt(tokens) + ' ' + p.symbol +
    ' @ ' + fmtPrice(fillUsd) + ' · impact ' + imp.toFixed(2) + '% · ' + tx.route, p.symbol);
  log('manage', 'PLAN  ' + p.symbol + (snipe ? ' [snipe]' : '') + ' target +' +
    targetPct.toFixed(1) + '% ≈ +' + pos.targetEth.toFixed(3) + ' ETH net · scale ' +
    Math.round(RULES.SCALE_PORTION * 100) + '% at +' + (targetPct * RULES.SCALE_AT).toFixed(1) +
    '% · stop ' + pos.stopPct + '% · time stop ' + pos.timeStopMin + 'm', p.symbol);
  save();
  return pos;
}

function sell(pos, portion, reason) {
  var p = M.byAddress[pos.address];
  var priceUsd = p ? p.priceUsd : pos.lastUsd;
  var tokens = pos.tokens * portion;
  var grossUsd = tokens * priceUsd;
  var imp = impactPct(grossUsd, p ? p.liqUsd : grossUsd * 4);
  var priority = 0.00001 + Math.random() * 0.00003;
  var outSol = M.toEth(grossUsd * (1 - imp / 100) * (1 - RULES.SWAP_FEE));
  var basis = pos.costEth * portion;
  var pnl = outSol - basis;

  Agent.cash += outSol - RULES.NET_FEE - priority;
  Agent.fees += RULES.NET_FEE + priority + M.toEth(grossUsd) * RULES.SWAP_FEE;
  pos.tokens -= tokens;
  pos.costEth -= basis;

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
    'SELL ' + fmtAmt(tokens) + ' ' + pos.symbol + ' → ' + outSol.toFixed(3) + ' ETH · ' +
    (pnl >= 0 ? '+' : '') + pnl.toFixed(3) + ' ETH (' + sgn(rec.pct * 100) + ') · ' + reason,
    pos.symbol);

  if (portion >= 0.999 || pos.tokens <= 0) {
    var i = Agent.positions.indexOf(pos);
    if (i > -1) Agent.positions.splice(i, 1);

    /* discipline: cooldown on the name, and a pause after a losing streak */
    var coolMin = pnl < 0 ? RULES.REBUY_COOL_MIN * 2 : RULES.REBUY_COOL_MIN;
    Agent.cooldowns[pos.address] = Date.now() + coolMin * 60000;
    if (pnl < 0) {
      Agent.lossStreak++;
      if (Agent.lossStreak >= RULES.LOSS_STREAK) {
        Agent.pausedUntil = Date.now() + RULES.PAUSE_MIN * 60000;
        Agent.lossStreak = 0;
        log('risk', 'PAUSE ' + RULES.LOSS_STREAK + ' losses in a row — no new entries for ' +
          RULES.PAUSE_MIN + ' minutes, the tape is not ours right now', null);
      }
    } else {
      Agent.lossStreak = 0;
    }
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
      pos.targetPct = clamp((RULES.TARGET_ETH / Math.max(pos.costEth, 0.01)) * 100 + pos.exitCost,
                            RULES.TARGET_MIN_PCT, RULES.TARGET_MAX_PCT);
      pos.targetEth = pos.costEth * (pos.targetPct - pos.exitCost) / 100;
      pos.scaled = !!pos.tp1;
      pos.peakPct = 0;
    }
    if (pos.stopPct === undefined) { pos.stopPct = RULES.STOP_PCT; pos.timeStopMin = RULES.TIME_STOP_MIN; }

    var pnlPct = (p.priceUsd / pos.entryUsd - 1) * 100;
    var heldMin = (Date.now() - pos.entryAt) / 60000;
    if (pnlPct > pos.peakPct) pos.peakPct = pnlPct;

    /* the pool is draining — nothing else matters */
    if (p.liqUsd < pos.liqAtEntry * (1 - RULES.RUG_LIQ_DROP)) {
      log('risk', 'RISK  ' + pos.symbol + ' pool down to ' + fmtUsd(p.liqUsd) + ' from ' +
        fmtUsd(pos.liqAtEntry) + ' — getting out now', pos.symbol);
      sell(pos, 1, 'liquidity guard'); continue;
    }

    if (pnlPct <= pos.stopPct) { sell(pos, 1, 'stop loss'); continue; }

    /* momentum gone: red, sellers in control, tape rolling over — do not
       wait around for the full stop to be hit */
    if (pnlPct < -5 && heldMin > 4 && buyPressure(p) < 0.42 && p.ch.m5 < -2) {
      sell(pos, 1, 'momentum gone'); continue;
    }

    /* a scaled winner is never allowed to turn red: once the first slice is
       banked, the rest exits at breakeven at worst */
    if (pos.scaled && pnlPct <= pos.exitCost * 0.6) {
      sell(pos, 1, 'breakeven stop'); continue;
    }

    /* profit lock: the stop ratchets up behind the high water mark, so an
       open gain can breathe but a real one cannot evaporate */
    var lock = -Infinity;
    if (pos.peakPct >= 12) lock = pos.exitCost * 0.6;   // breakeven, net of costs
    if (pos.peakPct >= 20) lock = 8;
    if (pos.peakPct >= 32) lock = 16;
    if (pos.peakPct >= 48) lock = 28;
    if (pos.peakPct >= 70) lock = 45;
    if (pnlPct <= lock) { sell(pos, 1, 'profit lock'); continue; }

    /* target reached — bank most of it, but the runner stays on the trail:
       the big winners come from the piece that is allowed to keep going */
    if (!pos.banked && pnlPct >= pos.targetPct) {
      pos.banked = true;
      pos.trail = true;
      log('manage', 'BANK  ' + pos.symbol + ' ' + sgn(pnlPct) + ' — target hit, taking ' +
        Math.round(RULES.BANK_PORTION * 100) + '%, the runner trails ' + RULES.TRAIL_PCT +
        '% under the high for more', pos.symbol);
      sell(pos, RULES.BANK_PORTION, 'target hit'); continue;
    }

    /* the runner does not get to ride forever */
    if (pos.banked && pnlPct >= pos.targetPct * RULES.RUNNER_CAP) {
      sell(pos, 1, 'runner cap'); continue;
    }

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
    if (heldMin > pos.timeStopMin && pnlPct < pos.exitCost + 2) {
      sell(pos, 1, 'time stop'); continue;
    }
  }
}

/* -------------------------------------------------------------- the LLM -- */
function positionsForModel() {
  return Agent.positions.map(function (pos) {
    var p = M.byAddress[pos.address];
    var mark = p ? p.priceUsd : pos.lastUsd;
    var value = M.toEth(pos.tokens * mark);
    return {
      symbol: pos.symbol, address: pos.address,
      entryUsd: pos.entryUsd, markUsd: mark,
      pnlPct: (mark / pos.entryUsd - 1) * 100,
      pnlEth: value - pos.costEth,
      valueEth: value,
      targetPct: pos.targetPct || 0,
      scaledOut: !!pos.scaled,
      lane: pos.lane || 'swing',
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
    var blocked = entryBlock(p);
    if (blocked) {
      log('think', 'REJECT BUY ' + p.symbol + ' — ' + blocked, p.symbol);
      return;
    }
    var snipe = snipeWindow(p);
    var equity = Agent.equityNow();
    var pctSize = snipe
      ? Math.min(clamp(Number(a.sizePct) || RULES.SNIPE_SIZE_PCT, 8, 14), 14)
      : clamp(Number(a.sizePct) || 15, RULES.MIN_SIZE_PCT, RULES.MAX_SIZE_PCT);
    var size = Math.min(equity * pctSize / 100 * sizeMult(), Agent.cash - 0.005);
    if (size < 0.012) {
      log('think', 'REJECT BUY ' + p.symbol + ' — only ' + Agent.cash.toFixed(3) + ' ETH free', p.symbol);
      return;
    }
    log('thesis', 'MODEL ' + p.symbol + (snipe ? ' [launch snipe]' : '') + ' — 5m ' +
      sgn(p.ch.m5) + ' · 1h ' + sgn(p.ch.h1) +
      ' · LP ' + fmtUsd(p.liqUsd) + ' · vol 1h ' + fmtUsd(p.vol.h1) +
      ' · conviction ' + (a.conviction || '?') + '/100 → ' + (a.reason || 'buy'), p.symbol);
    buy(p, size, a.reason, a.conviction, snipe ? 'snipe' : 'swing');
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

/* anti-martingale: press a little when the day is working, shrink when it
   is not. Never the other way around. */
function sizeMult() {
  var pnl = (Agent.equityNow() / RULES.START_ETH - 1) * 100;
  return pnl > 10 ? 1.15 : pnl < -10 ? 0.8 : 1;
}

function takeEntry(r, why, lane) {
  var snipe = lane === 'snipe';
  var equity = Agent.equityNow();
  var size = Math.min(equity * (snipe ? RULES.SNIPE_SIZE_PCT / 100 : 0.20) * sizeMult(),
                      Agent.cash - 0.005);
  if (size < 0.012) return false;
  log('thesis', 'THESIS ' + r.p.symbol + (snipe ? ' [launch snipe]' : '') + ' — 5m ' +
    sgn(r.p.ch.m5) + ' · 1h ' + sgn(r.p.ch.h1) +
    ' · LP ' + fmtUsd(r.p.liqUsd) + ' · turnover ×' + r.s.turnover.toFixed(2) +
    ' · buy pressure ' + (r.s.pressure * 100).toFixed(0) + '% → score ' +
    r.s.score.toFixed(1) + '/100 · ' + why, r.p.symbol);
  buy(r.p, size, why, Math.round(r.s.score), lane);
  Agent.lastAutoBuy = Date.now();
  return true;
}

function heuristicDecision(ranked) {
  Agent.brainSource = 'heuristic';
  if (!ranked.length) return;
  if (Date.now() - Agent.lastAutoBuy < RULES.AUTO_GAP_MS) return;

  var spoke = false;
  for (var i = 0; i < Math.min(ranked.length, 8); i++) {
    var r = ranked[i];

    /* sorted by score, so once we are under the threshold nothing below qualifies */
    if (r.s.score < RULES.SCORE_BUY) {
      if (!spoke && r.s.score > 50) {
        log('think', 'PASS  ' + r.p.symbol + ' ' + r.s.score.toFixed(1) + '/100 — ' +
          (r.s.flags[0] || 'conviction under threshold') + ' · threshold ' + RULES.SCORE_BUY, r.p.symbol);
      }
      break;
    }
    var no = entryBlock(r.p);
    if (no) {
      if (!spoke && no !== 'already holding it') {
        spoke = true; log('think', 'PASS  ' + r.p.symbol + ' — ' + no, r.p.symbol);
      }
      continue;
    }
    takeEntry(r, 'momentum + liquidity filter', snipeWindow(r.p) ? 'snipe' : 'swing');
    return;
  }
}

/* runs every scan, independent of the model cadence. Two fast lanes:
   the launch snipe (recency is the edge, the model is too slow for it)
   and a high-conviction momentum entry. One entry per pass, spaced out. */
function autoEntries(ranked) {
  if (Date.now() - Agent.lastAutoBuy < RULES.AUTO_GAP_MS) return;

  var snipes = [], strong = [];
  for (var i = 0; i < ranked.length; i++) {
    var r = ranked[i];
    if (snipeWindow(r.p) && r.s.score >= RULES.SNIPE_SCORE && r.s.pressure >= 0.52 &&
        r.p.ch.m5 > 0 && !entryBlock(r.p)) snipes.push(r);
    else if (r.s.score >= RULES.FAST_SCORE && !entryBlock(r.p)) strong.push(r);
  }

  if (snipes.length) {
    snipes.sort(function (a, b) { return a.p.ageHours - b.p.ageHours; });   // freshest first
    var s = snipes[0];
    log('alert', 'SNIPE ' + s.p.symbol + ' listed on Robinhood Chain ' +
      Math.round(s.p.ageHours * 60) + 'm ago · LP ' + fmtUsd(s.p.liqUsd) +
      ' · buys ' + s.p.txns.m5.buys + '/' + s.p.txns.m5.sells + ' on 5m', s.p.symbol);
    takeEntry(s, 'fresh Robinhood Chain listing', 'snipe');
    return;
  }
  if (strong.length) takeEntry(strong[0], 'high-conviction momentum', 'swing');
}

function askModel(ranked) {
  Agent.brainState = 'thinking';
  var payload = {
    equity: Agent.equityNow(),
    cash: Agent.cash,
    pnlPct: (Agent.equityNow() / RULES.START_ETH - 1) * 100,
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
    Agent.brainState = Date.now() < Agent.pausedUntil ? 'cooling off'
      : Agent.positions.length >= RULES.MAX_POS ? 'fully allocated'
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
  autoEntries(ranked);

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
    pnl: eq - RULES.START_ETH, pnlPct: eq / RULES.START_ETH - 1,
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
      llmCalls: Agent.llmCalls, model: Agent.model, logN: Agent.logN,
      cooldowns: Agent.cooldowns, lossStreak: Agent.lossStreak, pausedUntil: Agent.pausedUntil
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
    ['startedAt','cash','peak','maxDD','fees','nClosed','nWins','nTx','realized','scans','llmCalls','model','logN',
     'lossStreak','pausedUntil']
      .forEach(function (k) { if (s[k] !== undefined) Agent[k] = s[k]; });
    if (s.cooldowns && typeof s.cooldowns === 'object') Agent.cooldowns = s.cooldowns;
    ['positions','closed','txs','logs','equity','archive'].forEach(function (k) {
      if (Array.isArray(s[k])) Agent[k] = s[k];
    });
    Agent.day = s.day;
    return true;
  } catch (e) { return false; }
}

function archiveFrom(s) {
  if (!s || !s.day) return;
  var close = s.equity && s.equity.length ? s.equity[s.equity.length - 1][1] : RULES.START_ETH;
  Agent.archive = (Array.isArray(s.archive) ? s.archive : []).concat([{
    date: s.day,
    close: close,
    pnlPct: close / RULES.START_ETH - 1,
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
  Agent.cash = RULES.START_ETH;
  Agent.positions = []; Agent.closed = []; Agent.txs = []; Agent.equity = [];
  Agent.peak = RULES.START_ETH; Agent.maxDD = 0; Agent.fees = 0;
  Agent.nClosed = 0; Agent.nWins = 0; Agent.nTx = 0; Agent.realized = 0;
  Agent.scans = 0; Agent.llmCalls = 0; Agent.thesis = '';
  Agent.cooldowns = {}; Agent.lossStreak = 0; Agent.pausedUntil = 0;
  log('boot', 'BOOT  new session · wallet reset to ' + RULES.START_ETH.toFixed(3) + ' ETH', null);
  save();
}

/* the paper wallet's address — generated once per browser, then kept */
function walletAddress() {
  var k = 'tradoor.wallet.evm';
  try {
    var w = localStorage.getItem(k);
    if (w) return w;
  } catch (e) {}
  var w2 = '0x7d00' + hex(36);
  try { localStorage.setItem(k, w2); } catch (e) {}
  return w2;
}

Agent.init = function () {
  Agent.wallet = walletAddress();
  var restored = restore();
  if (!restored) {
    log('boot', 'BOOT  Tradoor online · paper wallet funded with 1.000 ETH', null);
    log('boot', 'BOOT  objective — bank 0.04 to 0.1 ETH a trade, and let the runner stretch it. No bag-holding.', null);
    log('boot', 'BOOT  risk limits — max ' + RULES.MAX_POS + ' positions · stop ' + RULES.STOP_PCT +
      '% · trail ' + RULES.TRAIL_PCT + '% · liquidity floor ' + fmtUsd(RULES.MIN_LIQ_USD) +
      ' · board floor $20K market cap', null);
    log('boot', 'BOOT  snipe lane armed — fresh listings get ' + RULES.SNIPE_SIZE_PCT +
      '% clips, stop ' + RULES.SNIPE_STOP + '%, ' + RULES.SNIPE_TIME_MIN + 'm time stop', null);
    log('boot', 'BOOT  scanning Robinhood Chain on DEX Screener · decisions by the model on fal.ai', null);
  } else {
    log('boot', 'BOOT  session restored · ' + Agent.positions.length + ' open · ' +
      Agent.nTx + ' transactions on the tape', null);
  }
  return Agent;
};

global.TradoorAgent = Agent;
})(window);
