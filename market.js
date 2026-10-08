/* ============================================================================
   TRADOOR — market data
   Live Solana pairs from DEX Screener. Tries /api/pairs first (cached on the
   edge, one call for everybody); if that route is not deployed it talks to
   DEX Screener straight from the browser instead.

   Price history: DEX Screener has no public candle endpoint, so a pair's chart
   is seeded from its own 24h/6h/1h/5m change figures and then filled in with
   real observations, one every refresh. Nothing is invented in between.
============================================================================ */
(function (global) {
'use strict';

var DS = 'https://api.dexscreener.com';
var SOL_MINT = 'So11111111111111111111111111111111111111112';
var MAX_POINTS = 720;

/* the board floor — same numbers the edge function uses */
var MIN_MCAP = 25000;
var MAX_MCAP = 80000000;
var MIN_LIQ = 8000;
var MAX_PAIRS = 90;
var EXCLUDE = {};
[SOL_MINT,
 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'].forEach(function (a) { EXCLUDE[a] = 1; });
/* $TRADOOR itself, once it has a mint — never tradeable by the agent */
var SELF_TOKEN = '';

var Market = {
  pairs: [],
  byAddress: {},
  launchpad: [],        // pump.fun coins still on the bonding curve
  solUsd: 0,
  updatedAt: 0,
  source: '',
  ready: false,
  error: null,
  history: {},          // address -> [{ t, p, live }]
  discovery: { at: 0, addresses: [], boosts: {} },
  useApi: true
};

function json(url) {
  return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
    if (!r.ok) throw new Error(url.slice(0, 60) + ' → ' + r.status);
    return r.json();
  });
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
function tx(t) { return { buys: (t && t.buys) || 0, sells: (t && t.sells) || 0 }; }

/* --------------------------------------------------------- normalisation -- */
function normalise(p, boosts) {
  var info = p.info || {};
  var socials = Array.isArray(info.socials) ? info.socials : [];
  var sites = Array.isArray(info.websites) ? info.websites : [];
  var created = p.pairCreatedAt || 0;
  return {
    address: p.baseToken.address,
    pairAddress: p.pairAddress,
    url: p.url,
    dexId: p.dexId,
    symbol: (p.baseToken.symbol || '???').slice(0, 12),
    name: (p.baseToken.name || p.baseToken.symbol || 'Unknown').slice(0, 42),
    quote: p.quoteToken ? p.quoteToken.symbol : '',
    image: info.imageUrl || null,
    website: sites.length ? sites[0].url : null,
    socials: socials.map(function (s) { return { type: s.type, url: s.url }; }).slice(0, 3),
    priceUsd: parseFloat(p.priceUsd) || 0,
    priceNative: parseFloat(p.priceNative) || 0,
    ch: {
      m5: num(p.priceChange && p.priceChange.m5),
      h1: num(p.priceChange && p.priceChange.h1),
      h6: num(p.priceChange && p.priceChange.h6),
      h24: num(p.priceChange && p.priceChange.h24)
    },
    vol: {
      m5: num(p.volume && p.volume.m5),
      h1: num(p.volume && p.volume.h1),
      h6: num(p.volume && p.volume.h6),
      h24: num(p.volume && p.volume.h24)
    },
    txns: {
      m5: tx(p.txns && p.txns.m5),
      h1: tx(p.txns && p.txns.h1),
      h24: tx(p.txns && p.txns.h24)
    },
    liqUsd: (p.liquidity && p.liquidity.usd) || 0,
    liqBase: (p.liquidity && p.liquidity.base) || 0,
    liqQuote: (p.liquidity && p.liquidity.quote) || 0,
    fdv: p.fdv || 0,
    marketCap: p.marketCap || p.fdv || 0,
    createdAt: created,
    ageHours: created ? (Date.now() - created) / 3600000 : null,
    boosts: (p.boosts && p.boosts.active) || (boosts && boosts[p.baseToken.address]) || 0,
    /* a PumpSwap pair is born the moment a pump.fun coin graduates */
    isMigration: p.dexId === 'pumpswap' && created > 0 && Date.now() - created < 3 * 3600000
  };
}

function rank(p) {
  var turnover = p.liqUsd > 0 ? p.vol.h1 / p.liqUsd : 0;
  var r = Math.log10(1 + p.vol.h24) * 1.6
        + Math.min(turnover, 12) * 1.1
        + Math.max(-30, Math.min(60, p.ch.h1)) * 0.05
        + Math.min(p.boosts, 1000) * 0.002;
  if (p.ageHours !== null) {
    if (p.ageHours < 6) r += 2.0;
    else if (p.ageHours < 24) r += 1.2;
    else if (p.ageHours < 72) r += 0.5;
  }
  if (p.isMigration) r += 2.5;
  return r;
}

function eligible(p) {
  if (EXCLUDE[p.address]) return false;
  if (SELF_TOKEN && p.address === SELF_TOKEN) return false;
  /* fresh PumpSwap graduates arrive around $69K, under the normal floor */
  var mcapFloor = p.isMigration ? 20000 : MIN_MCAP;
  return p.priceUsd > 0 &&
    p.marketCap >= mcapFloor && p.marketCap <= MAX_MCAP && p.liqUsd >= MIN_LIQ;
}

/* ------------------------------------------------------- direct fallback -- */
function chunk(a, n) { var o = []; for (var i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

function discoverDirect() {
  var fresh = Date.now() - Market.discovery.at < 180000;
  if (fresh && Market.discovery.addresses.length) return Promise.resolve(Market.discovery);

  var soft = function (u) { return json(u).catch(function () { return null; }); };
  var lists = [
    DS + '/token-boosts/top/v1',
    DS + '/token-boosts/latest/v1',
    DS + '/token-profiles/latest/v1',
    DS + '/community-takeovers/latest/v1',
    DS + '/ads/latest/v1'
  ].map(soft);
  var searches = ['pump', 'bonk', 'cat', 'dog', 'meme'].map(function (q) {
    return soft(DS + '/latest/dex/search?q=' + encodeURIComponent(q));
  });

  return Promise.all([Promise.all(lists), Promise.all(searches)]).then(function (both) {
    var seen = {}, addresses = [], boosts = {};
    var add = function (a) {
      if (!a || EXCLUDE[a] || seen[a]) return;
      seen[a] = 1; addresses.push(a);
    };
    both[0].forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (t) {
        if (!t || t.chainId !== 'solana' || !t.tokenAddress) return;
        if (t.totalAmount) boosts[t.tokenAddress] = t.totalAmount;
        add(t.tokenAddress);
      });
    });
    both[1].forEach(function (res) {
      if (!res || !Array.isArray(res.pairs)) return;
      res.pairs.filter(function (p) {
        return p && p.chainId === 'solana' && p.baseToken && p.priceUsd;
      }).sort(function (a, b) {
        return ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0);
      }).forEach(function (p) { add(p.baseToken.address); });
    });
    Market.discovery = { at: Date.now(), addresses: addresses.slice(0, 120), boosts: boosts };
    return Market.discovery;
  });
}

function fetchDirect() {
  return discoverDirect().then(function (d) {
    if (!d.addresses.length) throw new Error('no solana tokens discovered');
    var groups = chunk(d.addresses, 30).slice(0, 4);
    var calls = groups.map(function (g) {
      return json(DS + '/tokens/v1/solana/' + g.join(',')).catch(function () { return []; });
    });
    calls.push(json(DS + '/tokens/v1/solana/' + SOL_MINT).catch(function () { return []; }));

    return Promise.all(calls).then(function (res) {
      var solPairs = res.pop();
      var best = {};
      res.forEach(function (list) {
        (Array.isArray(list) ? list : []).forEach(function (p) {
          if (!p || !p.baseToken || !p.priceUsd) return;
          var liq = (p.liquidity && p.liquidity.usd) || 0;
          var prev = best[p.baseToken.address];
          if (!prev || liq > ((prev.liquidity && prev.liquidity.usd) || 0)) best[p.baseToken.address] = p;
        });
      });

      var solUsd = 0;
      var deep = (Array.isArray(solPairs) ? solPairs : [])
        .filter(function (p) { return p.baseToken && p.baseToken.address === SOL_MINT && p.priceUsd; })
        .sort(function (a, b) {
          return ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0);
        })[0];
      if (deep) solUsd = parseFloat(deep.priceUsd) || 0;

      var pairs = Object.keys(best).map(function (k) { return normalise(best[k], d.boosts); })
        .filter(eligible)
        .sort(function (a, b) { return rank(b) - rank(a); })
        .slice(0, MAX_PAIRS);

      return { pairs: pairs, solUsd: solUsd, updatedAt: Date.now(), source: 'dexscreener-direct' };
    });
  });
}

/* ------------------------------------------------------------- history --- */
function seedHistory(p) {
  var now = Date.now(), P = p.priceUsd, pts = [];
  var back = function (hours, changePct) {
    var past = P / (1 + changePct / 100);
    if (isFinite(past) && past > 0) pts.push({ t: now - hours * 3600000, p: past, live: false });
  };
  back(24, p.ch.h24);
  back(6, p.ch.h6);
  back(1, p.ch.h1);
  back(5 / 60, p.ch.m5);
  pts.sort(function (a, b) { return a.t - b.t; });
  pts.push({ t: now, p: P, live: true });
  Market.history[p.address] = pts;
}

function pushHistory(p) {
  var h = Market.history[p.address];
  if (!h) { seedHistory(p); return; }
  var last = h[h.length - 1];
  if (last && Math.abs(last.p - p.priceUsd) < 1e-18 && p.priceUsd > 0 && Date.now() - last.t < 10000) return;
  h.push({ t: Date.now(), p: p.priceUsd, live: true });
  if (h.length > MAX_POINTS) h.splice(0, h.length - MAX_POINTS);
}

Market.seriesFor = function (address, windowMs) {
  var h = Market.history[address] || [];
  if (!windowMs) return h.slice();
  var cut = Date.now() - windowMs;
  var out = h.filter(function (pt) { return pt.t >= cut; });
  return out.length > 1 ? out : h.slice(-2);
};

/* ------------------------------------------------------------ live feed ---
   PumpPortal streams pump.fun events over a free, read-only WebSocket: every
   new token and every graduation onto PumpSwap, the second it happens.
   Graduations are pinned so the very next refresh prices them and puts them
   on the board; launches feed the launchpad strip whenever pump.fun's own
   REST API is throttling. One connection, two free subscriptions, no key.
--------------------------------------------------------------------------- */
var LIVE_URL = 'wss://pumpportal.fun/api/data';
var MIGRATION_TTL = 3 * 3600000;

Market.live = { ws: null, ok: false, migrations: {}, launches: [], tries: 0, seen: 0 };

function liveConnect() {
  if (typeof WebSocket === 'undefined') return;
  var L = Market.live;
  if (L.ws && (L.ws.readyState === 0 || L.ws.readyState === 1)) return;
  var ws;
  try { ws = new WebSocket(LIVE_URL); } catch (e) { return; }
  L.ws = ws;

  ws.onopen = function () {
    L.ok = true; L.tries = 0;
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    ws.send(JSON.stringify({ method: 'subscribeMigration' }));
  };
  ws.onmessage = function (ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || typeof m !== 'object' || !m.mint) return;
    L.seen++;
    var now = Date.now();
    var type = String(m.txType || '').toLowerCase();

    /* a graduation: the PumpSwap pool exists from this moment. Checked after
       "create", because new-token messages carry a pool field too. */
    if (type === 'migrate' || type === 'migration') {
      L.migrations[m.mint] = now;
      return;
    }
    /* a brand-new token on the bonding curve */
    if (type === 'create') {
      var capUsd = (m.marketCapSol || 0) * (Market.solUsd || 0);
      L.launches.unshift({
        mint: m.mint,
        symbol: String(m.symbol || '???').slice(0, 12),
        name: String(m.name || m.symbol || 'Unknown').slice(0, 42),
        image: null,
        mcapUsd: Math.round(capUsd),
        progress: Math.max(0, Math.min(1, capUsd / 69000)),
        createdAt: now, ageMin: 0, replies: 0, live: false, kind: 'new'
      });
      if (L.launches.length > 40) L.launches.length = 40;
    }
  };
  ws.onclose = function () {
    L.ok = false; L.ws = null; L.tries++;
    setTimeout(liveConnect, Math.min(60000, 4000 * L.tries));
  };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}

function liveMigrations() {
  var cut = Date.now() - MIGRATION_TTL, out = [], M2 = Market.live.migrations;
  Object.keys(M2).forEach(function (a) {
    if (M2[a] < cut) delete M2[a]; else out.push(a);
  });
  return out;
}

/* ------------------------------------------------------------- pinned ----
   Open positions must always have a live mark, even after the token drops off
   the trending board — otherwise a stop loss could never fire. Anything in
   Market.pinned gets its own lookup when it is missing from the board, and
   so does every graduation the live feed has seen in the last three hours.
--------------------------------------------------------------------------- */
Market.pinned = [];

function fetchPinned(byAddress) {
  var want = Market.pinned.concat(liveMigrations());
  var seen = {}, missing = [];
  want.forEach(function (a) { if (a && !byAddress[a] && !seen[a]) { seen[a] = 1; missing.push(a); } });
  missing = missing.slice(0, 30);
  if (!missing.length) return Promise.resolve([]);
  return json(DS + '/tokens/v1/solana/' + missing.join(',')).catch(function () { return []; });
}

/* -------------------------------------------------------------- refresh -- */
Market.refresh = function () {
  var load = Market.useApi
    ? json('/api/pairs').catch(function (e) { Market.useApi = false; return fetchDirect(); })
    : fetchDirect();

  return load.then(function (data) {
    if (!data || !Array.isArray(data.pairs) || !data.pairs.length) throw new Error('empty payload');

    Market.pairs = data.pairs;
    Market.launchpad = Array.isArray(data.launchpad) ? data.launchpad : [];
    /* pump.fun's REST throttling? the live stream carries the launchpad */
    if (!Market.launchpad.length && Market.live.launches.length) {
      Market.launchpad = Market.live.launches.slice(0, 12);
    }
    Market.byAddress = {};
    data.pairs.forEach(function (p) {
      Market.byAddress[p.address] = p;
      pushHistory(p);
    });
    Market.solUsd = data.solUsd || Market.solUsd || 0;
    if (!Market.solUsd) {
      for (var i = 0; i < data.pairs.length; i++) {
        var p = data.pairs[i];
        if (p.quote === 'SOL' && p.priceNative > 0 && p.priceUsd > 0) {
          Market.solUsd = p.priceUsd / p.priceNative; break;
        }
      }
    }
    Market.updatedAt = data.updatedAt || Date.now();
    Market.source = data.source || (Market.useApi ? 'edge' : 'dexscreener-direct');
    Market.ready = true;
    Market.error = null;

    /* held names that fell off the board still need a price */
    return fetchPinned(Market.byAddress).then(function (extra) {
      var best = {};
      (Array.isArray(extra) ? extra : []).forEach(function (p) {
        if (!p || !p.baseToken || !p.priceUsd) return;
        var liq = (p.liquidity && p.liquidity.usd) || 0;
        var prev = best[p.baseToken.address];
        if (!prev || liq > ((prev.liquidity && prev.liquidity.usd) || 0)) best[p.baseToken.address] = p;
      });
      var migrated = Market.live.migrations;
      Object.keys(best).forEach(function (a) {
        var pair = normalise(best[a], null);
        Market.byAddress[a] = pair;
        pushHistory(pair);
        /* a graduation the live feed caught: it belongs ON the board, tagged
           as the fresh migration we know it to be, so the agent can snipe it */
        if (migrated[a] && eligible(pair)) {
          pair.isMigration = true;
          pair.liveMigration = true;
          Market.pairs.unshift(pair);
        } else {
          pair.offBoard = true;
        }
      });
      return Market;
    }, function () { return Market; });
  }).catch(function (err) {
    Market.error = String(err && err.message || err);
    if (!Market.ready) throw err;
    return Market;
  });
};

Market.toSol = function (usd) { return Market.solUsd > 0 ? usd / Market.solUsd : 0; };
Market.toUsd = function (s) { return s * Market.solUsd; };

liveConnect();

global.TradoorMarket = Market;
})(window);
