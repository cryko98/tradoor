/* ============================================================================
   GET /api/state
   The shared session: ONE book for every visitor, kept in Redis and advanced
   by a lazy tick — whoever's poll finds the book more than 15 seconds stale
   triggers the next step, under a lock so only one tick runs at a time. As
   long as anybody has the page open, the agent trades; if nobody watches for
   an hour, the next visitor wakes it and it picks up at current prices.

   Storage: Upstash Redis over REST. Attach one on Vercel (Marketplace →
   Upstash, or Vercel KV) and the env vars appear by themselves:
     KV_REST_API_URL + KV_REST_API_TOKEN        (Vercel KV naming)
     UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
   Without them this route answers { shared:false } and every browser falls
   back to running its own local book, exactly as before.

   The model call happens HERE in shared mode — one brain for the whole
   site, at most one call per 40 seconds regardless of traffic, which is
   cheaper than the per-visitor route it replaces.
============================================================================ */

const core = require('../core.js');
const pairsApi = require('./pairs.js');
const analyze = require('./analyze.js');

const BOOK_KEY = 'tradoor:book';
const LOCK_KEY = 'tradoor:tick-lock';
const TICK_STALE_MS = 15000;

/* ------------------------------------------------------------------ redis */
function redisEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url, token } : null;
}

async function redis(env, command) {
  const r = await fetch(env.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  if (!r.ok) throw new Error('redis ' + r.status + ': ' + (await r.text()).slice(0, 160));
  const out = await r.json();
  if (out && out.error) throw new Error('redis: ' + String(out.error).slice(0, 160));
  return out ? out.result : null;
}

/* -------------------------------------------------------------- the book -- */
async function loadBook(env) {
  const raw = await redis(env, ['GET', BOOK_KEY]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function saveBook(env, book) {
  /* keep the stored copy lean — same caps the browser used */
  const lean = Object.assign({}, book, {
    closed: book.closed.slice(-60),
    txs: book.txs.slice(0, 40),
    logs: book.logs.slice(-140),
    equity: book.equity.slice(-600),
    archive: book.archive.slice(-14)
  });
  await redis(env, ['SET', BOOK_KEY, JSON.stringify(lean)]);
}

/* ------------------------------------------------------------------- tick */
async function runTick(env, book, now) {
  const data = await pairsApi.build();
  const byAddress = {};
  (data.pairs || []).forEach((p) => { byAddress[p.address] = p; });

  /* open positions that fell off the board still need a mark */
  const missing = book.positions
    .map((pos) => pos.address)
    .filter((a) => a && !byAddress[a])
    .slice(0, 25);
  if (missing.length) {
    try {
      const r = await fetch('https://api.dexscreener.com/tokens/v1/robinhood/' + missing.join(','),
        { headers: { accept: 'application/json' } });
      if (r.ok) {
        const extra = await r.json();
        const best = {};
        (Array.isArray(extra) ? extra : []).forEach((p) => {
          if (!p || !p.baseToken || !p.priceUsd) return;
          const liq = (p.liquidity && p.liquidity.usd) || 0;
          const prev = best[p.baseToken.address];
          if (!prev || liq > ((prev.liquidity && prev.liquidity.usd) || 0)) best[p.baseToken.address] = p;
        });
        Object.keys(best).forEach((a) => {
          const p = best[a];
          byAddress[a] = {
            address: a, symbol: (p.baseToken.symbol || '?').slice(0, 12),
            name: p.baseToken.name || '', url: p.url, image: null, website: null,
            socials: [], boosts: 0,
            priceUsd: parseFloat(p.priceUsd) || 0,
            ch: { m5: 0, h1: 0, h6: 0, h24: 0 },
            vol: { m5: 0, h1: 0, h6: 0, h24: 0 },
            txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
            liqUsd: (p.liquidity && p.liquidity.usd) || 0,
            marketCap: p.marketCap || 0, fdv: p.fdv || 0,
            createdAt: p.pairCreatedAt || 0,
            ageHours: p.pairCreatedAt ? (now - p.pairCreatedAt) / 3600000 : null,
            isFresh: false
          };
        });
      }
    } catch (e) { /* the 10-minute stale guard in core handles the rest */ }
  }

  const ctx = { byAddress, ethUsd: data.ethUsd || 0, now, rand: Math.random };
  const ranked = core.tick(book, ctx, data.pairs || []);

  /* the shared brain: one model call per interval for the whole site */
  if (now - (book.lastLlm || 0) >= core.RULES.LLM_INTERVAL_MS) {
    book.lastLlm = now;
    book.brainState = 'thinking';
    const payload = {
      equity: core.equityNow(book, ctx),
      cash: book.cash,
      pnlPct: (core.equityNow(book, ctx) / core.RULES.START_ETH - 1) * 100,
      positions: core.positionsForModel(book, ctx),
      candidates: ranked.slice(0, 14).map((r) => r.p)
    };
    try {
      const res = await analyze.runModel(payload);
      if (res && res.ok) {
        book.llmCalls++;
        book.model = res.model;
        book.brainSource = 'model';
        if (res.thesis) {
          book.thesis = res.thesis;
          core.log(book, now, 'scan', 'READ  ' + res.thesis, null);
        }
        const acted = core.applyModelActions(book, ctx, res, ranked);
        if (!acted && (!res.actions || !res.actions.length)) {
          core.log(book, now, 'think', 'HOLD  model sees nothing worth the risk right now · ' +
            ranked.length + ' pairs scored · leader ' + (ranked[0] ? ranked[0].p.symbol : '—'), null);
        }
      } else {
        if (res && res.reason === 'no-key' && !book.warnedNoKey) {
          book.warnedNoKey = true;
          core.log(book, now, 'boot', 'NOTE  no FAL_KEY on this deployment — running the built-in scoring model instead', null);
        }
        core.heuristicDecision(book, ctx, ranked);
      }
    } catch (e) {
      core.heuristicDecision(book, ctx, ranked);
    }
    book.brainState = now < book.pausedUntil ? 'cooling off'
      : book.positions.length >= core.RULES.MAX_POS ? 'fully allocated'
      : book.positions.length ? 'in position' : 'hunting';
  }
}

/* -------------------------------------------------------------- response -- */
function wireBook(book) {
  return {
    day: book.day, startedAt: book.startedAt, wallet: book.wallet, cash: book.cash,
    positions: book.positions, closed: book.closed.slice(-40), txs: book.txs.slice(0, 30),
    logs: book.logs.slice(-100), watch: book.watch, equity: book.equity.slice(-500),
    archive: book.archive, peak: book.peak, maxDD: book.maxDD, fees: book.fees,
    nClosed: book.nClosed, nWins: book.nWins, nTx: book.nTx, realized: book.realized,
    scans: book.scans, llmCalls: book.llmCalls, model: book.model, thesis: book.thesis,
    brainState: book.brainState, brainSource: book.brainSource, logN: book.logN,
    pausedUntil: book.pausedUntil, lastTick: book.lastTick
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const env = redisEnv();
  if (!env) return res.status(200).json({ shared: false, reason: 'no-store' });

  const now = Date.now();
  let book;
  try {
    book = await loadBook(env);
  } catch (err) {
    return res.status(200).json({ shared: false, reason: 'store-error', error: String(err.message || err).slice(0, 160) });
  }

  try {
    if (!book) {
      book = core.newBook(now, Math.random);
      core.bootLogs(book, now);
      core.log(book, now, 'boot', 'BOOT  shared session — every visitor is watching this one wallet', null);
      await saveBook(env, book);
    }

    /* lazy tick: first poll past the stale mark does the work, under a lock */
    if (now - (book.lastTick || 0) >= TICK_STALE_MS) {
      const got = await redis(env, ['SET', LOCK_KEY, String(now), 'NX', 'PX', '25000']);
      if (got) {
        try {
          await runTick(env, book, now);
          await saveBook(env, book);
        } finally {
          try { await redis(env, ['DEL', LOCK_KEY]); } catch (e) {}
        }
      }
    }
  } catch (err) {
    /* the tick failed — still serve the last known book */
    if (book) {
      return res.status(200).json({ shared: true, degraded: String(err.message || err).slice(0, 160),
        serverNow: now, book: wireBook(book) });
    }
    return res.status(200).json({ shared: false, reason: 'tick-error', error: String(err.message || err).slice(0, 160) });
  }

  return res.status(200).json({ shared: true, serverNow: now, book: wireBook(book) });
};
