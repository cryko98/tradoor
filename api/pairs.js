/* ============================================================================
   GET /api/pairs
   Trending Solana memecoins, straight from the public DEX Screener API,
   plus the pump.fun launchpad: brand-new launches still on the bonding
   curve and coins that just graduated onto PumpSwap.

   Discovery (cached 3 minutes, ~16 requests):
     token-boosts/top · token-boosts/latest · token-profiles/latest
     community-takeovers/latest · ads/latest · a handful of searches
     pump.fun: newest launches · closest to graduation · freshly graduated
   Enrichment (every 20 seconds, ~6 requests):
     tokens/v1/solana/{addresses}   — 30 per call

   That is roughly 22 requests a minute against DEX Screener's limit of 60,
   no matter how much traffic the page gets, because both layers are cached
   here and on the CDN.

   Output: { solUsd, updatedAt, count, universe, launchpad, pairs: [...] }
============================================================================ */

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/* majors and stables — never memecoin board material */
const EXCLUDE = new Set([
  SOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',   // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',    // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',   // jitoSOL
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'    // wETH
]);

const SEARCH_TERMS = ['pump', 'bonk', 'cat', 'dog', 'meme', 'moon', 'baby', 'wif'];

const MIN_MCAP  = 100000;      // the board floor the site advertises
const MAX_MCAP  = 80000000;    // above this it is not a memecoin trade any more
const MIN_LIQ   = 8000;        // a pool this thin cannot be exited at all
const MAX_PAIRS = 90;
const MAX_ADDRS = 150;

const DISCOVERY_TTL = 180000;
const CACHE_MS = 20000;

/* pump.fun bonding-curve mechanics: a coin graduates to PumpSwap around
   this USD market cap. Used only to draw the launchpad progress bar. */
const PUMP = 'https://frontend-api-v3.pump.fun';
const GRADUATION_USD = 69000;

let discCache = { at: 0, addresses: [], boosts: {}, launchpad: [] };
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

/* one bonding-curve coin from the pump.fun API, trimmed for the launchpad */
function launchEntry(c, kind) {
  return {
    mint: c.mint,
    symbol: (c.symbol || '???').slice(0, 12),
    name: (c.name || c.symbol || 'Unknown').slice(0, 42),
    image: c.image_uri || null,
    mcapUsd: Math.round(c.usd_market_cap || 0),
    progress: Math.max(0, Math.min(1, (c.usd_market_cap || 0) / GRADUATION_USD)),
    createdAt: c.created_timestamp || 0,
    ageMin: c.created_timestamp ? Math.round((Date.now() - c.created_timestamp) / 60000) : null,
    replies: c.reply_count || 0,
    live: !!c.is_currently_live,
    kind: kind                          // 'new' | 'graduating'
  };
}

async function discover() {
  if (Date.now() - discCache.at < DISCOVERY_TTL && discCache.addresses.length) return discCache;

  const [lists, searches, pumpNew, pumpActive, pumpGrad] = await Promise.all([
    Promise.all(LISTS.map(soft)),
    Promise.all(SEARCH_TERMS.map((q) =>
      soft('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q)))),
    soft(PUMP + '/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false'),
    /* recently-traded bonding coins — the ones actually climbing the curve
       (the market_cap sort is polluted with stale junk, this one is not) */
    soft(PUMP + '/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&complete=false&includeNsfw=false'),
    soft(PUMP + '/coins?offset=0&limit=50&sort=last_trade_timestamp&order=DESC&complete=true&includeNsfw=false')
  ]);

  const seen = new Set();
  const addresses = [];
  const boosts = {};
  const add = (a) => {
    if (!a || EXCLUDE.has(a) || seen.has(a)) return;
    seen.add(a); addresses.push(a);
  };

  /* freshly graduated pump.fun coins first — the PumpSwap pool is brand new
     and this is exactly the window the migration snipe wants */
  if (Array.isArray(pumpGrad)) {
    for (const c of pumpGrad) {
      if (c && c.complete && !c.is_banned) add(c.mint);
    }
  }

  /* the promoted lists — that is where the trending names are */
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (!t || t.chainId !== 'solana') continue;
      if (t.totalAmount) boosts[t.tokenAddress] = t.totalAmount;
      add(t.tokenAddress);
    }
  }
  /* then whatever the searches turned up, deepest pools first */
  for (const res of searches) {
    if (!res || !Array.isArray(res.pairs)) continue;
    const solana = res.pairs
      .filter((p) => p && p.chainId === 'solana' && p.baseToken && p.priceUsd)
      .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
    for (const p of solana) add(p.baseToken.address);
  }

  /* the launchpad strip: still on the curve, so DEX Screener cannot price
     them yet — the agent watches these and pounces when they migrate */
  const launchpad = [];
  const lpSeen = new Set();
  const pushLaunch = (c, kind) => {
    if (!c || !c.mint || lpSeen.has(c.mint) || c.is_banned || c.complete) return;
    if (!c.usd_market_cap || c.usd_market_cap < 6000) return;
    lpSeen.add(c.mint);
    launchpad.push(launchEntry(c, kind));
  };
  if (Array.isArray(pumpActive)) {
    for (const c of pumpActive) {
      /* trading right now and meaningfully up the curve */
      if (c && c.usd_market_cap >= 15000 && c.usd_market_cap <= GRADUATION_USD * 1.05) pushLaunch(c, 'graduating');
    }
  }
  if (Array.isArray(pumpNew)) {
    for (const c of pumpNew) {
      if (c && c.created_timestamp && Date.now() - c.created_timestamp < 90 * 60000) pushLaunch(c, 'new');
    }
  }
  launchpad.sort((a, b) => b.progress - a.progress);

  discCache = {
    at: Date.now(),
    addresses: addresses.slice(0, MAX_ADDRS),
    boosts,
    launchpad: launchpad.slice(0, 12)
  };
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
    /* a PumpSwap pair is created at the moment a pump.fun coin graduates,
       so dexId + pair age together identify a fresh migration */
    isMigration: p.dexId === 'pumpswap' && created > 0 && Date.now() - created < 3 * 3600000
  };
}

function eligible(p) {
  if (EXCLUDE.has(p.address)) return false;
  /* fresh PumpSwap graduates arrive around $69K — the $100K floor would blind
     the agent to the exact window it hunts, so migrations bypass it */
  const mcapFloor = p.isMigration ? 45000 : MIN_MCAP;
  if (p.marketCap < mcapFloor || p.marketCap > MAX_MCAP) return false;
  if (p.liqUsd < MIN_LIQ) return false;
  if (!p.priceUsd) return false;
  return true;
}

/* liveliness, with a thumb on the scale for anything launched today */
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
  if (p.isMigration) r += 2.5;          // fresh PumpSwap graduates stay on the board
  return r;
}

/* -------------------------------------------------------------- building -- */
async function build() {
  const disc = await discover();
  if (!disc.addresses.length) throw new Error('discovery returned nothing');

  const groups = chunk(disc.addresses, 30);
  const results = await Promise.all(
    groups.map((g) => soft('https://api.dexscreener.com/tokens/v1/solana/' + g.join(',')))
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

  /* SOL in dollars, from its own deepest pool */
  let solUsd = 0;
  const solPairs = await soft('https://api.dexscreener.com/tokens/v1/solana/' + SOL_MINT);
  if (Array.isArray(solPairs)) {
    const deep = solPairs
      .filter((p) => p.baseToken && p.baseToken.address === SOL_MINT && p.priceUsd)
      .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
    if (deep) solUsd = parseFloat(deep.priceUsd) || 0;
  }

  /* a launchpad coin that has graduated since discovery ran is priced now —
     drop it from the strip, the board has it */
  const listed = new Set(pairs.map((p) => p.address));
  const launchpad = (disc.launchpad || []).filter((c) => !listed.has(c.mint));

  return {
    solUsd,
    updatedAt: Date.now(),
    count: pairs.length,
    universe: { discovered: disc.addresses.length, priced: all.length, listed: pairs.length },
    floor: { marketCapUsd: MIN_MCAP, liquidityUsd: MIN_LIQ },
    launchpad,
    pairs,
    source: 'dexscreener+pumpfun'
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
