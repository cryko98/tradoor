/* ============================================================================
   GET /api/pairs
   Trending memecoins on Robinhood Chain, straight from the public
   DEX Screener API.

   Discovery (cached 3 minutes, ~11 requests):
     token-boosts/top · token-boosts/latest · token-profiles/latest
     community-takeovers/latest · ads/latest · a handful of searches,
     everything filtered to chainId "robinhood"
   Enrichment (every 20 seconds, ~5 requests):
     tokens/v1/robinhood/{addresses}   — 30 per call

   That is roughly 17 requests a minute against DEX Screener's limit of 60,
   no matter how much traffic the page gets, because both layers are cached
   here and on the CDN.

   Output: { ethUsd, updatedAt, count, universe, pairs: [ ...normalised ] }
============================================================================ */

const CHAIN = 'robinhood';

/* wrapped natives and stables — never board material. On this chain the
   quote side is often a tokenized stock (GME, AAPL, HIMS…), which is fine;
   these are only checked against the BASE token. */
const EXCLUDE_SYMBOLS = new Set(['WETH', 'ETH', 'USDG', 'USDC', 'USDT', 'WBTC', 'DAI']);

/* $TRADOOR itself. It trades on this very board, but the agent must never
   touch it: a simulated buy of the token this site promotes would read as
   real buy pressure on the tape, which it is not. */
const SELF_TOKEN = '0xb47efcc461d3cd6b270daf15388a77a3fae64ad1';

const SEARCH_TERMS = ['robinhood', 'hood', 'stonk', 'moon', 'pepe', 'doge'];

const MIN_MCAP  = 20000;       // the board floor the site advertises
const MAX_MCAP  = 80000000;    // above this it is not a memecoin trade any more
const MIN_LIQ   = 4000;        // a pool this thin cannot be exited at all
const MAX_PAIRS = 90;
const MAX_ADDRS = 150;

const FRESH_MS = 3 * 3600000;  // a pair this young is a fresh launch

const DISCOVERY_TTL = 180000;
const CACHE_MS = 20000;

let discCache = { at: 0, addresses: [], boosts: {} };
let cache = { at: 0, body: null };

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(url.slice(0, 70) + ' → ' + r.status);
  return r.json();
}
function soft(url) { return getJSON(url).catch(() => null); }
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ------------------------------------------------------------- discovery -- */
const LISTS = [
  'https://api.dexscreener.com/token-boosts/top/v1',
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-profiles/latest/v1',
  'https://api.dexscreener.com/community-takeovers/latest/v1',
  'https://api.dexscreener.com/ads/latest/v1'
];

async function discover() {
  if (Date.now() - discCache.at < DISCOVERY_TTL && discCache.addresses.length) return discCache;

  const [lists, searches] = await Promise.all([
    Promise.all(LISTS.map(soft)),
    Promise.all(SEARCH_TERMS.map((q) =>
      soft('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q))))
  ]);

  const seen = new Set();
  const addresses = [];
  const boosts = {};
  const add = (a) => {
    if (!a || seen.has(a)) return;
    seen.add(a); addresses.push(a);
  };

  /* the promoted lists first — that is where the fresh listings are */
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (!t || t.chainId !== CHAIN) continue;
      if (t.totalAmount) boosts[t.tokenAddress] = t.totalAmount;
      add(t.tokenAddress);
    }
  }
  /* then whatever the searches turned up, deepest pools first */
  for (const res of searches) {
    if (!res || !Array.isArray(res.pairs)) continue;
    const found = res.pairs
      .filter((p) => p && p.chainId === CHAIN && p.baseToken && p.priceUsd)
      .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    for (const p of found) add(p.baseToken.address);
  }

  discCache = { at: Date.now(), addresses: addresses.slice(0, MAX_ADDRS), boosts };
  return discCache;
}

/* ----------------------------------------------------------- normalising -- */
function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
function tx(t) { return { buys: (t && t.buys) || 0, sells: (t && t.sells) || 0 }; }

function normalise(p, boosts) {
  const info = p.info || {};
  const socials = Array.isArray(info.socials) ? info.socials : [];
  const sites = Array.isArray(info.websites) ? info.websites : [];
  const created = p.pairCreatedAt || 0;
  return {
    address: p.baseToken.address,
    pairAddress: p.pairAddress,
    url: p.url,
    dexId: p.dexId,
    labels: p.labels || [],
    symbol: (p.baseToken.symbol || '???').slice(0, 12),
    name: (p.baseToken.name || p.baseToken.symbol || 'Unknown').slice(0, 42),
    quote: p.quoteToken ? p.quoteToken.symbol : '',
    image: info.imageUrl || null,
    website: sites.length ? sites[0].url : null,
    socials: socials.map((s) => ({ type: s.type, url: s.url })).slice(0, 3),
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
    boosts: (p.boosts && p.boosts.active) || boosts[p.baseToken.address] || 0,
    /* a pair this young is a fresh listing — the snipe lane's hunting ground */
    isFresh: created > 0 && Date.now() - created < FRESH_MS
  };
}

function eligible(p) {
  if (EXCLUDE_SYMBOLS.has(p.symbol.toUpperCase())) return false;
  if (p.address.toLowerCase() === SELF_TOKEN) return false;
  /* fresh listings start tiny — the normal floor would blind the agent to
     the exact window it hunts, so they get a lower one */
  const mcapFloor = p.isFresh ? 8000 : MIN_MCAP;
  if (p.marketCap < mcapFloor || p.marketCap > MAX_MCAP) return false;
  if (p.liqUsd < MIN_LIQ) return false;
  if (!p.priceUsd) return false;
  return true;
}

/* liveliness, with a thumb on the scale for anything freshly listed */
function rank(p) {
  const turnover = p.liqUsd > 0 ? p.vol.h1 / p.liqUsd : 0;
  let r = Math.log10(1 + p.vol.h24) * 1.6
        + Math.min(turnover, 12) * 1.1
        + Math.max(-30, Math.min(60, p.ch.h1)) * 0.05
        + Math.min(p.boosts, 1000) * 0.002;
  if (p.ageHours !== null) {
    if (p.ageHours < 6) r += 2.0;
    else if (p.ageHours < 24) r += 1.2;
    else if (p.ageHours < 72) r += 0.5;
  }
  if (p.isFresh) r += 2.5;              // brand-new listings stay on the board
  return r;
}

/* -------------------------------------------------------------- building -- */
async function build() {
  const disc = await discover();
  if (!disc.addresses.length) throw new Error('discovery returned nothing');

  const groups = chunk(disc.addresses, 30);
  const results = await Promise.all(
    groups.map((g) => soft('https://api.dexscreener.com/tokens/v1/' + CHAIN + '/' + g.join(',')))
  );

  const best = new Map();
  for (const list of results) {
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      if (!p || !p.baseToken || !p.priceUsd) continue;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      const prev = best.get(p.baseToken.address);
      if (!prev || liq > ((prev.liquidity && prev.liquidity.usd) || 0)) best.set(p.baseToken.address, p);
    }
  }

  const all = Array.from(best.values()).map((p) => normalise(p, disc.boosts));
  const pairs = all.filter(eligible).sort((a, b) => rank(b) - rank(a)).slice(0, MAX_PAIRS);

  /* ETH in dollars, backed out of the deepest WETH-quoted pool on the chain */
  let ethUsd = 0;
  const ethQuoted = all
    .filter((p) => /ETH$/.test(p.quote) && p.priceNative > 0 && p.priceUsd > 0)
    .sort((a, b) => b.liqUsd - a.liqUsd);
  if (ethQuoted.length) ethUsd = ethQuoted[0].priceUsd / ethQuoted[0].priceNative;

  return {
    ethUsd,
    updatedAt: Date.now(),
    count: pairs.length,
    universe: { discovered: disc.addresses.length, priced: all.length, listed: pairs.length },
    floor: { marketCapUsd: MIN_MCAP, liquidityUsd: MIN_LIQ },
    pairs,
    source: 'dexscreener:robinhood'
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=45');

  const now = Date.now();
  if (cache.body && now - cache.at < CACHE_MS) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache.body);
  }

  try {
    const body = await build();
    cache = { at: now, body };
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(body);
  } catch (err) {
    if (cache.body) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json(cache.body);
    }
    return res.status(502).json({ error: String((err && err.message) || err) });
  }
};

module.exports.build = build;
