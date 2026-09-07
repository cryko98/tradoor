/* ============================================================================
   TRADOOR — the agent (browser side)
   A thin wrapper around core.js. Two modes:

   · shared — /api/state exists (Redis attached on Vercel): the book lives on
     the server, one wallet for everybody, and this file just adopts whatever
     the server says. No local trading, no localStorage.

   · solo — no shared state available (local preview, or no Redis): the same
     core runs right here in the browser, per visitor, persisted locally.
============================================================================ */
(function (global) {
'use strict';

var M = global.TradoorMarket;
var C = global.TradoorCore;
var RULES = C.RULES;

var STORE_KEY = 'tradoor.book.v3';

/* the Agent IS the book — app.js reads its fields directly */
var Agent = C.newBook(Date.now(), Math.random);

Agent.RULES = RULES;
Agent.fmtAmt = C.fmtAmt; Agent.fmtUsd = C.fmtUsd; Agent.fmtPrice = C.fmtPrice; Agent.sgn = C.sgn;
Agent.score = C.score;
Agent.snipeWindow = C.snipeWindow;
Agent.shared = false;

function ctx() {
  return { byAddress: M.byAddress, ethUsd: M.ethUsd, now: Date.now(), rand: Math.random };
}

Agent.log = function (kind, text, symbol) { C.log(Agent, Date.now(), kind, text, symbol); };

Agent.ranked = function () {
  return C.rankPairs(M.pairs.filter(function (p) { return true; }));
};

Agent.equityNow = function () { return C.equityNow(Agent, ctx()); };
Agent.stats = function () { return C.stats(Agent, ctx()); };

/* ------------------------------------------------------------ solo mode -- */
function save() {
  if (Agent.shared) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      day: Agent.day, startedAt: Agent.startedAt, wallet: Agent.wallet, cash: Agent.cash,
      positions: Agent.positions, closed: Agent.closed.slice(-60), txs: Agent.txs.slice(0, 40),
      logs: Agent.logs.slice(-120), equity: Agent.equity.slice(-600), archive: Agent.archive.slice(-14),
      watch: Agent.watch,
      peak: Agent.peak, maxDD: Agent.maxDD, fees: Agent.fees, nClosed: Agent.nClosed,
      nWins: Agent.nWins, nTx: Agent.nTx, realized: Agent.realized, scans: Agent.scans,
      llmCalls: Agent.llmCalls, model: Agent.model, logN: Agent.logN,
      cooldowns: Agent.cooldowns, lossStreak: Agent.lossStreak, pausedUntil: Agent.pausedUntil,
      lastAutoBuy: Agent.lastAutoBuy, lastLlm: Agent.lastLlm, lastEquityAt: Agent.lastEquityAt
    }));
  } catch (e) { /* private mode, quota — the agent just forgets on reload */ }
}

function restore() {
  var raw;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return false; }
  if (!raw) return false;
  try {
    var s = JSON.parse(raw);
    /* a bumped BOOK_GEN wipes the local book: start clean, keep nothing */
    if (!s || s.gen !== C.BOOK_GEN) {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      return false;
    }
    if (s.day !== C.todayOf(Date.now())) {
      if (s && s.day) {
        /* archive yesterday before the fresh start */
        var ghost = C.newBook(Date.now(), Math.random);
        ghost.day = s.day; ghost.equity = s.equity || []; ghost.archive = s.archive || [];
        ghost.nTx = s.nTx || 0; ghost.nWins = s.nWins || 0; ghost.nClosed = s.nClosed || 0;
        C.rollDayIfNeeded(ghost, { now: Date.now() });
        Agent.archive = ghost.archive;
      }
      return false;
    }
    Object.keys(s).forEach(function (k) { if (s[k] !== undefined) Agent[k] = s[k]; });
    return true;
  } catch (e) { return false; }
}

function askModel(ranked) {
  Agent.brainState = 'thinking';
  var cx = ctx();
  var payload = {
    equity: C.equityNow(Agent, cx),
    cash: Agent.cash,
    pnlPct: (C.equityNow(Agent, cx) / RULES.START_ETH - 1) * 100,
    positions: C.positionsForModel(Agent, cx),
    candidates: ranked.slice(0, 14).map(function (r) { return r.p; })
  };

  return fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (r) { return r.json(); }).then(function (res) {
    var cx2 = ctx();
    if (!res || !res.ok) {
      Agent.brainSource = 'heuristic';
      var why = res && res.reason;
      Agent.warned = Agent.warned || {};
      if (why && !Agent.warned[why]) {
        Agent.warned[why] = true;
        if (why === 'no-key') {
          Agent.log('boot', 'NOTE  no FAL_KEY on this deployment — running the built-in scoring model instead', null);
        } else if (why === 'fal-error' || why === 'unparseable') {
          Agent.log('boot', 'NOTE  model call failed (' + String(res.error || res.raw || '').slice(0, 120) +
            ') — falling back to the built-in scoring model', null);
        }
      }
      C.heuristicDecision(Agent, cx2, ranked);
      return;
    }
    Agent.llmCalls++;
    Agent.model = res.model;
    Agent.brainSource = 'model';
    if (res.thesis) {
      Agent.thesis = res.thesis;
      Agent.log('scan', 'READ  ' + res.thesis, null);
    }
    var acted = C.applyModelActions(Agent, cx2, res, ranked);
    if (!acted && (!res.actions || !res.actions.length)) {
      Agent.log('think', 'HOLD  model sees nothing worth the risk right now · ' +
        ranked.length + ' pairs scored · leader ' + (ranked[0] ? ranked[0].p.symbol : '—'), null);
    }
  }).catch(function () {
    Agent.brainSource = 'heuristic';
    C.heuristicDecision(Agent, ctx(), ranked);
  }).then(function () { save(); });
}

Agent.tick = function () {
  if (Agent.shared || !M.ready) return;
  var cx = ctx();
  var ranked = C.tick(Agent, cx, M.pairs);

  if (cx.now - Agent.lastLlm >= RULES.LLM_INTERVAL_MS) {
    Agent.lastLlm = cx.now;
    askModel(ranked);
  }
  save();
};

/* ---------------------------------------------------------- shared mode -- */
/* the server's book replaces ours wholesale — one wallet for everybody */
Agent.adoptShared = function (book) {
  Agent.shared = true;
  ['day', 'startedAt', 'wallet', 'cash', 'positions', 'closed', 'txs', 'logs', 'watch',
   'equity', 'archive', 'peak', 'maxDD', 'fees', 'nClosed', 'nWins', 'nTx', 'realized',
   'scans', 'llmCalls', 'model', 'thesis', 'brainState', 'brainSource', 'logN', 'pausedUntil'
  ].forEach(function (k) { if (book[k] !== undefined) Agent[k] = book[k]; });
};

Agent.init = function () {
  var restored = restore();
  if (!restored) {
    C.bootLogs(Agent, Date.now());
  } else {
    Agent.log('boot', 'BOOT  session restored · ' + Agent.positions.length + ' open · ' +
      Agent.nTx + ' transactions on the tape', null);
  }
  return Agent;
};

global.TradoorAgent = Agent;
})(window);
