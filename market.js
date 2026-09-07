/* ============================================================================
   TRADOOR — market data
   Live Robinhood Chain pairs from DEX Screener. Tries /api/pairs first
   (cached on the edge, one call for everybody); if that route is not
   deployed it talks to DEX Screener straight from the browser instead.

   Price history: DEX Screener has no public candle endpoint, so a pair's
   chart is seeded from its own 24h/6h/1h/5m change figures and then filled
   in with real observations, one every refresh. Nothing is invented.
============================================================================ */
(function (global) {
'use strict';

var DS = 'https://api.dexscreener.com';
var CHAIN = 'robinhood';
var MAX_POINTS = 720;
var FRESH_MS = 3 * 3600000;

/* the board floor — same numbers the edge function uses */
var MIN_MCAP = 20000;
var MAX_MCAP = 80000000;
var MIN_LIQ = 4000;
var MAX_PAIRS = 90;
var EXCLUDE_SYMBOLS = { WETH: 1, ETH: 1, USDG: 1, USDC: 1, USDT: 1, WBTC: 1, DAI: 1 };

var Market = {
  pairs: [],
  byAddress: {},
  ethUsd: 0,
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
    isFresh: created > 0 && Date.now() - created < FRESH_MS
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
  if (p.isFresh) r += 2.5;
  return r;
}

function eligible(p) {
  if (EXCLUDE_SYMBOLS[p.symbol.toUpperCase()]) return false;
  var mcapFloor = p.isFresh ? 8000 : MIN_MCAP;
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
  var searches = ['robinhood', 'hood', 'stonk', 'moon', 'pepe'].map(function (q) {
    return soft(DS + '/latest/dex/search?q=' + encodeURIComponent(q));
  });

  return Promise.all([Promise.all(lists), Promise.all(searches)]).then(function (both) {
    var seen = {}, addresses = [], boosts = {};
    var add = function (a) {
      if (!a || seen[a]) return;
      seen[a] = 1; addresses.push(a);
    };
    both[0].forEach(function (list) {
      (Array.isArray(list) ? list : []).forEach(function (t) {
        if (!t || t.chainId !== CHAIN || !t.tokenAddress) return;
        if (t.totalAmount) boosts[t.tokenAddress] = t.totalAmount;
        add(t.tokenAddress);
      });
    });
    both[1].forEach(function (res) {
      if (!res || !Array.isArray(res.pairs)) return;
      res.pairs.filter(function (p) {
        return p && p.chainId === CHAIN && p.baseToken && p.priceUsd;
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
    if (!d.addresses.length) throw new Error('no robinhood-chain tokens discovered');
    var groups = chunk(d.addresses, 30).slice(0, 4);
    var calls = groups.map(function (g) {
      return json(DS + '/tokens/v1/' + CHAIN + '/' + g.join(',')).catch(function () { return []; });
    });

    return Promise.all(calls).then(function (res) {
      var best = {};
      res.forEach(function (list) {
        (Array.isArray(list) ? list : []).forEach(function (p) {
          if (!p || !p.baseToken || !p.priceUsd) return;
          var liq = (p.liquidity && p.liquidity.usd) || 0;
          var prev = best[p.baseToken.address];
          if (!prev || liq > ((prev.liquidity && prev.liquidity.usd) || 0)) best[p.baseToken.address] = p;
        });
      });

      var all = Object.keys(best).map(function (k) { return normalise(best[k], d.boosts); });
      var pairs = all.filter(eligible)
        .sort(function (a, b) { return rank(b) - rank(a); })
        .slice(0, MAX_PAIRS);

      /* ETH in dollars, backed out of the deepest WETH-quoted pool */
      var ethUsd = 0;
      var ethQuoted = all.filter(function (p) {
        return /ETH$/.test(p.quote) && p.priceNative > 0 && p.priceUsd > 0;
      }).sort(function (a, b) { return b.liqUsd - a.liqUsd; });
      if (ethQuoted.length) ethUsd = ethQuoted[0].priceUsd / ethQuoted[0].priceNative;

      return { pairs: pairs, ethUsd: ethUsd, updatedAt: Date.now(), source: 'dexscreener-direct:robinhood' };
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

/* ------------------------------------------------------------- pinned ----
   Open positions must always have a live mark, even after the token drops
   off the trending board — otherwise a stop loss could never fire.
--------------------------------------------------------------------------- */
Market.pinned = [];

function fetchPinned(byAddress) {
  var missing = Market.pinned.filter(function (a) { return a && !byAddress[a]; }).slice(0, 25);
  if (!missing.length) return Promise.resolve([]);
  return json(DS + '/tokens/v1/' + CHAIN + '/' + missing.join(',')).catch(function () { return []; });
}

/* -------------------------------------------------------------- refresh -- */
Market.refresh = function () {
  var load = Market.useApi
    ? json('/api/pairs').catch(function (e) { Market.useApi = false; return fetchDirect(); })
    : fetchDirect();

  return load.then(function (data) {
    if (!data || !Array.isArray(data.pairs) || !data.pairs.length) throw new Error('empty payload');

    Market.pairs = data.pairs;
    Market.byAddress = {};
    data.pairs.forEach(function (p) {
      Market.byAddress[p.address] = p;
      pushHistory(p);
    });
    Market.ethUsd = data.ethUsd || Market.ethUsd || 0;
    if (!Market.ethUsd) {
      for (var i = 0; i < data.pairs.length; i++) {
        var p = data.pairs[i];
        if (/ETH$/.test(p.quote) && p.priceNative > 0 && p.priceUsd > 0) {
          Market.ethUsd = p.priceUsd / p.priceNative; break;
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
      Object.keys(best).forEach(function (a) {
        var pair = normalise(best[a], null);
        pair.offBoard = true;
        Market.byAddress[a] = pair;
        pushHistory(pair);
      });
      return Market;
    }, function () { return Market; });
  }).catch(function (err) {
    Market.error = String(err && err.message || err);
    if (!Market.ready) throw err;
    return Market;
  });
};

Market.toEth = function (usd) { return Market.ethUsd > 0 ? usd / Market.ethUsd : 0; };
Market.toUsd = function (eth) { return eth * Market.ethUsd; };

global.TradoorMarket = Market;
})(window);
