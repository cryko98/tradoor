/* ============================================================================
   TRADOOR — the trading core
   Every rule the agent lives by, as pure functions over a plain "book"
   object. The same file runs in the browser (window.TradoorCore, solo mode)
   and inside the Vercel functions (require, shared mode) — one brain, two
   homes, zero drift between them.

   Nothing in here touches the DOM, localStorage, fetch or a clock: the
   caller passes a ctx { byAddress, ethUsd, now, rand } and collects the
   results from the book.
============================================================================ */
(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.TradoorCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* --------------------------------------------------------------- rulebook */
var RULES = {
  START_ETH:      1,
  MAX_POS:        5,
  MIN_SIZE_PCT:   12,
  MAX_SIZE_PCT:   25,
  MIN_LIQ_USD:    8000,

  TARGET_ETH:     0.055,  // what a normal winner is worth, net
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

  /* the launch snipe: a pair that was just listed on Robinhood Chain */
  SNIPE_AGE_MIN:  75,
  SNIPE_SIZE_PCT: 10,
  SNIPE_STOP:    -9,
  SNIPE_TIME_MIN: 15,
  SNIPE_MAX_M5:   90,
  SNIPE_SCORE:    56,

  /* discipline */
  REBUY_COOL_MIN: 10,
  LOSS_STREAK:    3,
  PAUSE_MIN:      10,
  AUTO_GAP_MS:    40000,

  SWAP_FEE:       0.01,
  NET_FEE:        0.000005,
  SCORE_BUY:      64,
  FAST_SCORE:     68,

  LLM_INTERVAL_MS: 40000
};

var ROUTES = ['Uniswap v4', 'Uniswap v3', '0x Router', '1inch', 'Matcha'];
var HEX = '0123456789abcdef';

/* Bump this to wipe the book everywhere on the next deploy: the server
   drops a stored book whose gen does not match, and so does every browser
   with a local one. The only reset switch there is. */
var BOOK_GEN = 4;

/* ----------------------------------------------------------------- helpers */
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
function hex(rand, n) {
  var s = '';
  for (var i = 0; i < n; i++) s += HEX[(rand() * 16) | 0];
  return s;
}
function todayOf(now) { return new Date(now).toISOString().slice(0, 10); }
function toEth(ctx, usd) { return ctx.ethUsd > 0 ? usd / ctx.ethUsd : 0; }
function toUsd(ctx, eth) { return eth * ctx.ethUsd; }

/* ---------------------------------------------------------------- the book */
function newBook(now, rand) {
  return {
    gen: BOOK_GEN,
    day: todayOf(now),
    startedAt: now,
    wallet: '0x7d00' + hex(rand || Math.random, 36),
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
    lastTick: 0,
    logN: 0,
    lastEquityAt: 0,
    cooldowns: {},
    lossStreak: 0,
    pausedUntil: 0,
    lastAutoBuy: 0
  };
}

function log(book, now, kind, text, symbol) {
  book.logN++;
  book.logs.push({ n: book.logN, t: now, kind: kind, text: text, symbol: symbol || null });
  if (book.logs.length > 240) book.logs.shift();
}

function bootLogs(book, now) {
  log(book, now, 'boot', 'BOOT  Tradoor online · agent wallet funded with 1.000 ETH', null);
  log(book, now, 'boot', 'BOOT  objective — bank 0.04 to 0.1 ETH a trade, and let the runner stretch it. No bag-holding.', null);
  log(book, now, 'boot', 'BOOT  risk limits — max ' + RULES.MAX_POS + ' positions · stop ' + RULES.STOP_PCT +
    '% · trail ' + RULES.TRAIL_PCT + '% · liquidity floor ' + fmtUsd(RULES.MIN_LIQ_USD) +
    ' · board floor $20K market cap', null);
  log(book, now, 'boot', 'BOOT  snipe lane armed — fresh listings get ' + RULES.SNIPE_SIZE_PCT +
    '% clips, stop ' + RULES.SNIPE_STOP + '%, ' + RULES.SNIPE_TIME_MIN + 'm time stop', null);
  log(book, now, 'boot', 'BOOT  scanning Robinhood Chain on DEX Screener · decisions by the model on fal.ai', null);
}

/* ------------------------------------------------------------- scoring --- */
function buyPressure(p) {
  var t = p.txns.m5.buys + p.txns.m5.sells;
  if (t < 4) {
    var h = p.txns.h1.buys + p.txns.h1.sells;
    return h ? p.txns.h1.buys / h : 0.5;
  }
  return p.txns.m5.buys / t;
}

function snipeWindow(p) {
  return !!p.isFresh && p.ageHours !== null && p.ageHours !== undefined &&
    p.ageHours * 60 <= RULES.SNIPE_AGE_MIN;
}

function score(p) {
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
  f.fresh = fresh ? (1 - (p.ageHours * 60) / RULES.SNIPE_AGE_MIN) * 8 : 0;

  var s = f.momentum + f.trend + f.volume + f.liquidity + f.pressure + f.quality + f.fresh;
  var flags = [];

  if (p.liqUsd < RULES.MIN_LIQ_USD) { s -= 26; flags.push('liquidity ' + fmtUsd(p.liqUsd) + ' under the floor'); }
  if (p.ch.h1 > 150 && !fresh)      { s -= 20; flags.push('1h already ' + sgn(p.ch.h1, 0) + ' — late to it'); }
  if (p.ch.m5 > (fresh ? RULES.SNIPE_MAX_M5 : RULES.MAX_M5))
                                    { s -= 12; flags.push('5m candle is vertical — no entry here'); }
  if (p.ch.m5 <= 0)                 { s -= 12; flags.push('no 5m impulse'); }
  if (p.ch.h24 < -55)               { s -= 10; flags.push('24h ' + sgn(p.ch.h24, 0)); }
  if (!fresh && p.ageHours !== null && p.ageHours < 0.25) { s -= 12; flags.push('under 15 minutes old'); }
  if (turnover < 0.08 && !fresh)    { s -= 12; flags.push('volume too thin against the pool'); }
  if (buyPressure(p) < 0.45)        { s -= 10; flags.push('sellers in control on 5m'); }

  return { score: clamp(s, 0, 100), f: f, flags: flags, turnover: turnover,
           pressure: buyPressure(p), fresh: fresh };
}

function rankPairs(pairs) {
  var out = pairs.map(function (p) {
    var s = score(p);
    p.score = s.score;
    p.flags = s.flags;
    p.turnover = s.turnover;
    p.pressure = s.pressure;
    return { p: p, s: s };
  });
  out.sort(function (a, b) { return b.s.score - a.s.score; });
  return out;
}

/* the hard gate — the model and the built-in brain both go through it */
function veto(p) {
  var fresh = snipeWindow(p);
  if (p.liqUsd < RULES.MIN_LIQ_USD)
    return 'liquidity ' + fmtUsd(p.liqUsd) + ' is under the ' + fmtUsd(RULES.MIN_LIQ_USD) + ' floor';
  if (!fresh && p.ch.h1 > RULES.MAX_H1)
    return '1h already ' + sgn(p.ch.h1, 0) + ' — that is somebody else’s exit';
  if (p.ch.m5 > (fresh ? RULES.SNIPE_MAX_M5 : RULES.MAX_M5))
    return '5m candle is vertical (' + sgn(p.ch.m5, 0) + ') — not chasing it';
  return null;
}

function entryBlock(book, p, now) {
  if (book.positions.length >= RULES.MAX_POS) return 'book full at ' + RULES.MAX_POS;
  if (now < book.pausedUntil)
    return 'cooling off after ' + RULES.LOSS_STREAK + ' straight losses (' +
      Math.ceil((book.pausedUntil - now) / 60000) + 'm left)';
  var held = book.positions.some(function (x) { return x.address === p.address; });
  if (held) return 'already holding it';
  var cool = book.cooldowns[p.address] || 0;
  if (now < cool) return 'just traded it — ' + Math.ceil((cool - now) / 60000) + 'm cooldown';
  return veto(p);
}

/* ------------------------------------------------------------ execution -- */
function impactPct(sizeUsd, liqUsd) {
  if (!liqUsd) return 45;
  return Math.min(45, (sizeUsd / (liqUsd * 0.5 + sizeUsd)) * 100 * 1.35);
}

function equityNow(book, ctx) {
  var v = book.cash;
  book.positions.forEach(function (pos) {
    var p = ctx.byAddress[pos.address];
    var priceUsd = p ? p.priceUsd : pos.lastUsd;
    v += toEth(ctx, pos.tokens * priceUsd);
  });
  return v;
}

/* anti-martingale: press a little when the day works, shrink when it does not */
function sizeMult(book, ctx) {
  var pnl = (equityNow(book, ctx) / RULES.START_ETH - 1) * 100;
  return pnl > 10 ? 1.15 : pnl < -10 ? 0.8 : 1;
}

function recordTx(book, ctx, o) {
  var tx = {
    sig: '0x' + hex(ctx.rand, 64),
    slot: 21400000 + Math.floor((ctx.now - 1767225600000) / 1000),
    t: ctx.now,
    side: o.side, symbol: o.symbol, address: o.address, url: o.url,
    sol: o.sol, tokens: o.tokens, priceUsd: o.priceUsd,
    impact: o.impact, fee: o.fee, priority: o.priority,
    cu: 120000 + ((ctx.rand() * 230000) | 0),
    route: ROUTES[(ctx.rand() * ROUTES.length) | 0],
    pnl: o.pnl === undefined ? null : o.pnl,
    status: 'confirmed'
  };
  book.txs.unshift(tx);
  book.nTx++;
  if (book.txs.length > 60) book.txs.pop();
  return tx;
}

function buy(book, ctx, p, sizeEth, reason, conviction, lane) {
  var sizeUsd = toUsd(ctx, sizeEth);
  var imp = impactPct(sizeUsd, p.liqUsd);
  var priority = 0.00001 + ctx.rand() * 0.00003;
  var spend = sizeEth + RULES.NET_FEE + priority;
  if (spend > book.cash) return null;

  var snipe = lane === 'snipe';
  var fillUsd = p.priceUsd * (1 + imp / 100);
  var tokens = toUsd(ctx, sizeEth * (1 - RULES.SWAP_FEE)) / fillUsd;

  book.cash -= spend;
  book.fees += RULES.NET_FEE + priority + sizeEth * RULES.SWAP_FEE;

  var exitCost = RULES.SWAP_FEE * 100 + imp;
  var targetPct = snipe
    ? clamp((RULES.TARGET_ETH * 0.85 / sizeEth) * 100 + exitCost, 18, 45)
    : clamp((RULES.TARGET_ETH / sizeEth) * 100 + exitCost,
            RULES.TARGET_MIN_PCT, RULES.TARGET_MAX_PCT);

  var pos = {
    address: p.address, symbol: p.symbol, name: p.name, image: p.image, url: p.url,
    tokens: tokens, costEth: sizeEth, entryUsd: sizeUsd / tokens, lastUsd: p.priceUsd,
    entryAt: ctx.now, peakUsd: p.priceUsd, peakPct: 0, scaled: false, trail: false,
    banked: false, liqAtEntry: p.liqUsd, reason: reason || '', conviction: conviction || 0,
    lane: snipe ? 'snipe' : 'swing',
    stopPct: snipe ? RULES.SNIPE_STOP : RULES.STOP_PCT,
    timeStopMin: snipe ? RULES.SNIPE_TIME_MIN : RULES.TIME_STOP_MIN,
    exitCost: exitCost, targetPct: targetPct,
    targetEth: sizeEth * (targetPct - exitCost) / 100
  };
  book.positions.push(pos);

  recordTx(book, ctx, {
    side: 'BUY', symbol: p.symbol, address: p.address, url: p.url, sol: sizeEth,
    tokens: tokens, priceUsd: fillUsd, impact: imp, fee: RULES.NET_FEE, priority: priority
  });

  log(book, ctx.now, 'exec', 'BUY  ' + sizeEth.toFixed(3) + ' ETH → ' + fmtAmt(tokens) + ' ' +
    p.symbol + ' @ ' + fmtPrice(fillUsd) + ' · impact ' + imp.toFixed(2) + '%', p.symbol);
  log(book, ctx.now, 'manage', 'PLAN  ' + p.symbol + (snipe ? ' [snipe]' : '') + ' target +' +
    targetPct.toFixed(1) + '% ≈ +' + pos.targetEth.toFixed(3) + ' ETH net · scale ' +
    Math.round(RULES.SCALE_PORTION * 100) + '% at +' + (targetPct * RULES.SCALE_AT).toFixed(1) +
    '% · stop ' + pos.stopPct + '% · time stop ' + pos.timeStopMin + 'm', p.symbol);
  return pos;
}

function sell(book, ctx, pos, portion, reason) {
  var p = ctx.byAddress[pos.address];
  var priceUsd = p ? p.priceUsd : pos.lastUsd;
  var tokens = pos.tokens * portion;
  var grossUsd = tokens * priceUsd;
  var imp = impactPct(grossUsd, p ? p.liqUsd : grossUsd * 4);
  var priority = 0.00001 + ctx.rand() * 0.00003;
  var outEth = toEth(ctx, grossUsd * (1 - imp / 100) * (1 - RULES.SWAP_FEE));
  var basis = pos.costEth * portion;
  var pnl = outEth - basis;

  book.cash += outEth - RULES.NET_FEE - priority;
  book.fees += RULES.NET_FEE + priority + toEth(ctx, grossUsd) * RULES.SWAP_FEE;
  pos.tokens -= tokens;
  pos.costEth -= basis;

  recordTx(book, ctx, {
    side: 'SELL', symbol: pos.symbol, address: pos.address, url: pos.url, sol: outEth,
    tokens: tokens, priceUsd: priceUsd * (1 - imp / 100), impact: imp,
    fee: RULES.NET_FEE, priority: priority, pnl: pnl
  });

  var rec = {
    symbol: pos.symbol, name: pos.name, image: pos.image, address: pos.address, url: pos.url,
    sol: outEth, pnl: pnl, pct: basis > 0 ? pnl / basis : 0, reason: reason,
    heldMs: ctx.now - pos.entryAt, t: ctx.now, portion: portion
  };
  book.closed.push(rec);
  if (book.closed.length > 80) book.closed.shift();
  book.nClosed++;
  if (pnl > 0) book.nWins++;
  book.realized += pnl;

  log(book, ctx.now, pnl >= 0 ? 'win' : 'loss',
    'SELL ' + fmtAmt(tokens) + ' ' + pos.symbol + ' → ' + outEth.toFixed(3) + ' ETH · ' +
    (pnl >= 0 ? '+' : '') + pnl.toFixed(3) + ' ETH (' + sgn(rec.pct * 100) + ') · ' + reason,
    pos.symbol);

  if (portion >= 0.999 || pos.tokens <= 0) {
    var i = book.positions.indexOf(pos);
    if (i > -1) book.positions.splice(i, 1);

    var coolMin = pnl < 0 ? RULES.REBUY_COOL_MIN * 2 : RULES.REBUY_COOL_MIN;
    book.cooldowns[pos.address] = ctx.now + coolMin * 60000;
    if (pnl < 0) {
      book.lossStreak++;
      if (book.lossStreak >= RULES.LOSS_STREAK) {
        book.pausedUntil = ctx.now + RULES.PAUSE_MIN * 60000;
        book.lossStreak = 0;
        log(book, ctx.now, 'risk', 'PAUSE ' + RULES.LOSS_STREAK + ' losses in a row — no new entries for ' +
          RULES.PAUSE_MIN + ' minutes, the tape is not ours right now', null);
      }
    } else {
      book.lossStreak = 0;
    }
  }
  return pnl;
}

/* ------------------------------------------------------------ risk pass -- */
function manage(book, ctx) {
  for (var i = book.positions.length - 1; i >= 0; i--) {
    var pos = book.positions[i];
    var p = ctx.byAddress[pos.address];
    if (!p) {
      pos.staleSince = pos.staleSince || ctx.now;
      if (ctx.now - pos.staleSince > 600000) {
        log(book, ctx.now, 'risk', 'RISK  ' + pos.symbol + ' has had no quote for 10 minutes — closing at the last mark', pos.symbol);
        sell(book, ctx, pos, 1, 'no market data');
      }
      continue;
    }
    pos.staleSince = 0;
    pos.lastUsd = p.priceUsd;
    if (p.priceUsd > pos.peakUsd) pos.peakUsd = p.priceUsd;
    if (pos.stopPct === undefined) { pos.stopPct = RULES.STOP_PCT; pos.timeStopMin = RULES.TIME_STOP_MIN; }

    var pnlPct = (p.priceUsd / pos.entryUsd - 1) * 100;
    var heldMin = (ctx.now - pos.entryAt) / 60000;
    if (pnlPct > pos.peakPct) pos.peakPct = pnlPct;

    if (p.liqUsd < pos.liqAtEntry * (1 - RULES.RUG_LIQ_DROP)) {
      log(book, ctx.now, 'risk', 'RISK  ' + pos.symbol + ' pool down to ' + fmtUsd(p.liqUsd) + ' from ' +
        fmtUsd(pos.liqAtEntry) + ' — getting out now', pos.symbol);
      sell(book, ctx, pos, 1, 'liquidity guard'); continue;
    }

    if (pnlPct <= pos.stopPct) { sell(book, ctx, pos, 1, 'stop loss'); continue; }

    /* momentum gone: red, sellers in control, tape rolling over */
    if (pnlPct < -5 && heldMin > 4 && buyPressure(p) < 0.42 && p.ch.m5 < -2) {
      sell(book, ctx, pos, 1, 'momentum gone'); continue;
    }

    /* a scaled winner is never allowed to turn red */
    if (pos.scaled && pnlPct <= pos.exitCost * 0.6) {
      sell(book, ctx, pos, 1, 'breakeven stop'); continue;
    }

    /* profit lock: the stop ratchets up behind the high water mark */
    var lock = -Infinity;
    if (pos.peakPct >= 12) lock = pos.exitCost * 0.6;
    if (pos.peakPct >= 20) lock = 8;
    if (pos.peakPct >= 32) lock = 16;
    if (pos.peakPct >= 48) lock = 28;
    if (pos.peakPct >= 70) lock = 45;
    if (pnlPct <= lock) { sell(book, ctx, pos, 1, 'profit lock'); continue; }

    /* target reached — bank most of it, the runner stays on the trail */
    if (!pos.banked && pnlPct >= pos.targetPct) {
      pos.banked = true;
      pos.trail = true;
      log(book, ctx.now, 'manage', 'BANK  ' + pos.symbol + ' ' + sgn(pnlPct) + ' — target hit, taking ' +
        Math.round(RULES.BANK_PORTION * 100) + '%, the runner trails ' + RULES.TRAIL_PCT +
        '% under the high for more', pos.symbol);
      sell(book, ctx, pos, RULES.BANK_PORTION, 'target hit'); continue;
    }
    if (pos.banked && pnlPct >= pos.targetPct * RULES.RUNNER_CAP) {
      sell(book, ctx, pos, 1, 'runner cap'); continue;
    }

    if (!pos.scaled && pnlPct >= pos.targetPct * RULES.SCALE_AT) {
      pos.scaled = true;
      pos.trail = true;
      log(book, ctx.now, 'manage', 'SCALE ' + pos.symbol + ' ' + sgn(pnlPct) + ' — taking ' +
        Math.round(RULES.SCALE_PORTION * 100) + '% off, trailing the rest ' +
        RULES.TRAIL_PCT + '% under the high', pos.symbol);
      sell(book, ctx, pos, RULES.SCALE_PORTION, 'scale out'); continue;
    }

    if (pos.trail && p.priceUsd <= pos.peakUsd * (1 - RULES.TRAIL_PCT / 100)) {
      sell(book, ctx, pos, 1, 'trailing stop'); continue;
    }

    if (pos.peakPct > pos.exitCost + 4 && pnlPct <= pos.peakPct * (1 - RULES.GIVEBACK)) {
      log(book, ctx.now, 'manage', 'FADE  ' + pos.symbol + ' gave back half of ' + sgn(pos.peakPct) +
        ' — closing what is left', pos.symbol);
      sell(book, ctx, pos, 1, 'giving back the gain'); continue;
    }

    if (heldMin > pos.timeStopMin && pnlPct < pos.exitCost + 2) {
      sell(book, ctx, pos, 1, 'time stop'); continue;
    }
  }
}

/* ------------------------------------------------------------- entries --- */
function takeEntry(book, ctx, r, why, lane) {
  var snipe = lane === 'snipe';
  var equity = equityNow(book, ctx);
  var size = Math.min(equity * (snipe ? RULES.SNIPE_SIZE_PCT / 100 : 0.20) * sizeMult(book, ctx),
                      book.cash - 0.005);
  if (size < 0.012) return false;
  log(book, ctx.now, 'thesis', 'THESIS ' + r.p.symbol + (snipe ? ' [launch snipe]' : '') + ' — 5m ' +
    sgn(r.p.ch.m5) + ' · 1h ' + sgn(r.p.ch.h1) +
    ' · LP ' + fmtUsd(r.p.liqUsd) + ' · turnover ×' + r.s.turnover.toFixed(2) +
    ' · buy pressure ' + (r.s.pressure * 100).toFixed(0) + '% → score ' +
    r.s.score.toFixed(1) + '/100 · ' + why, r.p.symbol);
  buy(book, ctx, r.p, size, why, Math.round(r.s.score), lane);
  book.lastAutoBuy = ctx.now;
  return true;
}

function heuristicDecision(book, ctx, ranked) {
  book.brainSource = 'heuristic';
  if (!ranked.length) return;
  if (ctx.now - book.lastAutoBuy < RULES.AUTO_GAP_MS) return;

  var spoke = false;
  for (var i = 0; i < Math.min(ranked.length, 8); i++) {
    var r = ranked[i];
    if (r.s.score < RULES.SCORE_BUY) {
      if (!spoke && r.s.score > 50) {
        log(book, ctx.now, 'think', 'PASS  ' + r.p.symbol + ' ' + r.s.score.toFixed(1) + '/100 — ' +
          (r.s.flags[0] || 'conviction under threshold') + ' · threshold ' + RULES.SCORE_BUY, r.p.symbol);
      }
      break;
    }
    var no = entryBlock(book, r.p, ctx.now);
    if (no) {
      if (!spoke && no !== 'already holding it') {
        spoke = true; log(book, ctx.now, 'think', 'PASS  ' + r.p.symbol + ' — ' + no, r.p.symbol);
      }
      continue;
    }
    takeEntry(book, ctx, r, 'momentum + liquidity filter', snipeWindow(r.p) ? 'snipe' : 'swing');
    return;
  }
}

function autoEntries(book, ctx, ranked) {
  if (ctx.now - book.lastAutoBuy < RULES.AUTO_GAP_MS) return;

  var snipes = [], strong = [];
  for (var i = 0; i < ranked.length; i++) {
    var r = ranked[i];
    if (snipeWindow(r.p) && r.s.score >= RULES.SNIPE_SCORE && r.s.pressure >= 0.52 &&
        r.p.ch.m5 > 0 && !entryBlock(book, r.p, ctx.now)) snipes.push(r);
    else if (r.s.score >= RULES.FAST_SCORE && !entryBlock(book, r.p, ctx.now)) strong.push(r);
  }

  if (snipes.length) {
    snipes.sort(function (a, b) { return a.p.ageHours - b.p.ageHours; });
    var s = snipes[0];
    log(book, ctx.now, 'alert', 'SNIPE ' + s.p.symbol + ' listed on Robinhood Chain ' +
      Math.round(s.p.ageHours * 60) + 'm ago · LP ' + fmtUsd(s.p.liqUsd) +
      ' · buys ' + s.p.txns.m5.buys + '/' + s.p.txns.m5.sells + ' on 5m', s.p.symbol);
    takeEntry(book, ctx, s, 'fresh Robinhood Chain listing', 'snipe');
    return;
  }
  if (strong.length) takeEntry(book, ctx, strong[0], 'high-conviction momentum', 'swing');
}

/* --------------------------------------------------------- model actions -- */
function applyModelActions(book, ctx, res, ranked) {
  var byAddr = {};
  ranked.forEach(function (r) { byAddr[r.p.address] = r.p; });
  var acted = false;

  (res.actions || []).forEach(function (a) {
    if (!a || !a.address) return;
    var p = byAddr[a.address] || ctx.byAddress[a.address];
    var holding = book.positions.filter(function (x) { return x.address === a.address; })[0];

    if (String(a.type).toUpperCase() === 'SELL') {
      if (!holding) { log(book, ctx.now, 'think', 'REJECT model wanted to sell something the book does not hold', null); return; }
      log(book, ctx.now, 'thesis', 'MODEL ' + holding.symbol + ' — ' + (a.reason || 'close it'), holding.symbol);
      sell(book, ctx, holding, 1, 'model exit');
      acted = true;
      return;
    }

    if (String(a.type).toUpperCase() !== 'BUY') return;
    if (!p) { log(book, ctx.now, 'think', 'REJECT model proposed a token that is not on the board', null); return; }
    if (holding) return;
    var blocked = entryBlock(book, p, ctx.now);
    if (blocked) {
      log(book, ctx.now, 'think', 'REJECT BUY ' + p.symbol + ' — ' + blocked, p.symbol);
      return;
    }
    var snipe = snipeWindow(p);
    var equity = equityNow(book, ctx);
    var pctSize = snipe
      ? Math.min(clamp(Number(a.sizePct) || RULES.SNIPE_SIZE_PCT, 8, 14), 14)
      : clamp(Number(a.sizePct) || 15, RULES.MIN_SIZE_PCT, RULES.MAX_SIZE_PCT);
    var size = Math.min(equity * pctSize / 100 * sizeMult(book, ctx), book.cash - 0.005);
    if (size < 0.012) {
      log(book, ctx.now, 'think', 'REJECT BUY ' + p.symbol + ' — only ' + book.cash.toFixed(3) + ' ETH free', p.symbol);
      return;
    }
    log(book, ctx.now, 'thesis', 'MODEL ' + p.symbol + (snipe ? ' [launch snipe]' : '') + ' — 5m ' +
      sgn(p.ch.m5) + ' · 1h ' + sgn(p.ch.h1) +
      ' · LP ' + fmtUsd(p.liqUsd) + ' · vol 1h ' + fmtUsd(p.vol.h1) +
      ' · conviction ' + (a.conviction || '?') + '/100 → ' + (a.reason || 'buy'), p.symbol);
    buy(book, ctx, p, size, a.reason, a.conviction, snipe ? 'snipe' : 'swing');
    book.lastAutoBuy = ctx.now;
    acted = true;
  });

  if (Array.isArray(res.watch) && res.watch.length) {
    var w = [];
    res.watch.forEach(function (it) {
      var p = byAddr[it.address] || ctx.byAddress[it.address];
      if (!p) return;
      w.push({ address: p.address, symbol: p.symbol,
               note: String(it.reason || 'watching').slice(0, 110), score: p.score || 0 });
    });
    if (w.length) book.watch = w.slice(0, 6);
  }
  return acted;
}

function heuristicWatch(book, ranked) {
  var held = {};
  book.positions.forEach(function (p) { held[p.address] = 1; });
  book.watch = ranked.filter(function (r) {
    return !held[r.p.address] && r.s.score > 30;
  }).slice(0, 6).map(function (r) {
    return {
      address: r.p.address, symbol: r.p.symbol, score: r.s.score,
      note: r.s.score >= RULES.SCORE_BUY ? 'entry conditions met — sizing the order'
          : r.s.flags[0] ? r.s.flags[0]
          : 'waiting for a clean 5m impulse'
    };
  });
}

/* --------------------------------------------------------------- session -- */
function archiveFrom(book) {
  var close = book.equity && book.equity.length
    ? book.equity[book.equity.length - 1][1] : RULES.START_ETH;
  book.archive = (book.archive || []).concat([{
    date: book.day,
    close: close,
    pnlPct: close / RULES.START_ETH - 1,
    trades: book.nTx || 0,
    winRate: book.nClosed ? (book.nWins || 0) / book.nClosed : 0
  }]).slice(-14);
}

function rollDayIfNeeded(book, ctx) {
  var t = todayOf(ctx.now);
  if (book.day === t) return false;
  archiveFrom(book);
  book.day = t;
  book.startedAt = ctx.now;
  book.cash = RULES.START_ETH;
  book.positions = []; book.closed = []; book.txs = []; book.equity = [];
  book.peak = RULES.START_ETH; book.maxDD = 0; book.fees = 0;
  book.nClosed = 0; book.nWins = 0; book.nTx = 0; book.realized = 0;
  book.scans = 0; book.llmCalls = 0; book.thesis = '';
  book.cooldowns = {}; book.lossStreak = 0; book.pausedUntil = 0;
  log(book, ctx.now, 'boot', 'BOOT  new session · wallet reset to ' + RULES.START_ETH.toFixed(3) + ' ETH', null);
  return true;
}

/* one full pass over the book. The (async) model decision is the caller's
   job — this returns the ranked board so the caller can build a prompt. */
function tick(book, ctx, pairs) {
  rollDayIfNeeded(book, ctx);

  var live = pairs || [];
  var ranked = rankPairs(live);
  book.scans++;
  manage(book, ctx);
  autoEntries(book, ctx, ranked);

  if (book.brainSource !== 'model' || !book.watch.length) heuristicWatch(book, ranked);

  if (ctx.now - book.lastEquityAt > 60000) {
    book.lastEquityAt = ctx.now;
    var eq = equityNow(book, ctx);
    book.equity.push([ctx.now, eq]);
    if (book.equity.length > 1500) book.equity.shift();
    if (eq > book.peak) book.peak = eq;
    var dd = 1 - eq / book.peak;
    if (dd > book.maxDD) book.maxDD = dd;
  }

  book.brainState = ctx.now < book.pausedUntil ? 'cooling off'
    : book.positions.length >= RULES.MAX_POS ? 'fully allocated'
    : book.positions.length ? 'in position' : 'hunting';
  book.lastTick = ctx.now;
  return ranked;
}

function positionsForModel(book, ctx) {
  return book.positions.map(function (pos) {
    var p = ctx.byAddress[pos.address];
    var mark = p ? p.priceUsd : pos.lastUsd;
    var value = toEth(ctx, pos.tokens * mark);
    return {
      symbol: pos.symbol, address: pos.address,
      entryUsd: pos.entryUsd, markUsd: mark,
      pnlPct: (mark / pos.entryUsd - 1) * 100,
      pnlEth: value - pos.costEth,
      valueEth: value,
      targetPct: pos.targetPct || 0,
      scaledOut: !!pos.scaled,
      lane: pos.lane || 'swing',
      heldMinutes: (ctx.now - pos.entryAt) / 60000
    };
  });
}

function stats(book, ctx) {
  var eq = equityNow(book, ctx);
  var best = null, worst = null;
  book.closed.forEach(function (t) {
    if (!best || t.pct > best.pct) best = t;
    if (!worst || t.pct < worst.pct) worst = t;
  });
  return {
    equity: eq, cash: book.cash,
    pnl: eq - RULES.START_ETH, pnlPct: eq / RULES.START_ETH - 1,
    realized: book.realized, trades: book.nTx, closed: book.nClosed, wins: book.nWins,
    winRate: book.nClosed ? book.nWins / book.nClosed : 0,
    best: best, worst: worst, fees: book.fees, maxDD: book.maxDD,
    open: book.positions.length, scans: book.scans, llmCalls: book.llmCalls,
    state: book.brainState, source: book.brainSource, model: book.model
  };
}

return {
  RULES: RULES, BOOK_GEN: BOOK_GEN,
  fmtAmt: fmtAmt, fmtUsd: fmtUsd, fmtPrice: fmtPrice, sgn: sgn, clamp: clamp,
  todayOf: todayOf,
  newBook: newBook, bootLogs: bootLogs, log: log,
  buyPressure: buyPressure, snipeWindow: snipeWindow, score: score, rankPairs: rankPairs,
  veto: veto, entryBlock: entryBlock,
  equityNow: equityNow, buy: buy, sell: sell, manage: manage,
  heuristicDecision: heuristicDecision, autoEntries: autoEntries,
  applyModelActions: applyModelActions, heuristicWatch: heuristicWatch,
  rollDayIfNeeded: rollDayIfNeeded, tick: tick,
  positionsForModel: positionsForModel, stats: stats
};
});
