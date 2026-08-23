/* ============================================================================
   GET /api/pairs
   Trending Solana memecoins, straight from the public DEX Screener API.

   Discovery  : token-boosts/top + token-boosts/latest + token-profiles/latest
   Enrichment : tokens/v1/solana/{addresses}  (30 per call)
   Output     : { solUsd, updatedAt, count, pairs: [ ...normalised pairs ] }

   Cached in memory for 20s and on the CDN for 15s, so a busy page does not
   walk into DEX Screener's 60 requests/minute limit.
============================================================================ */

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const CACHE_MS = 20000;
const MAX_TOKENS = 90;
const MIN_LIQ_USD = 4000;

let cache = { at: 0, body: null };

const DISCOVERY = [
  'https://api.dexscreener.com/token-boosts/top/v1',
  'https://api.dexscreener.com/token-boosts/latest/v1',
  'https://api.dexscreener.com/token-profiles/latest/v1'
];

async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(url + ' → ' + r.status);
  return r.json();
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function discover() {
  const lists = await Promise.allSettled(DISCOVERY.map(getJSON));
  const seen = new Set();
  const addresses = [];
  const boosts = {};

  for (const res of lists) {
    if (res.status !== 'fulfilled') continue;
    const list = Array.isArray(res.value) ? res.value : [];
    for (const t of list) {
      if (!t || t.chainId !== 'solana' || !t.tokenAddress) continue;
      if (t.totalAmount) boosts[t.tokenAddress] = t.totalAmount;
      if (seen.has(t.tokenAddress)) continue;
      seen.add(t.tokenAddress);
      addresses.push(t.tokenAddress);
    }
  }
  return { addresses: addresses.slice(0, MAX_TOKENS), boosts };
}

function normalise(p, boosts) {
  const liq = (p.liquidity && p.liquidity.usd) || 0;
  const created = p.pairCreatedAt || 0;
  const info = p.info || {};
  const socials = Array.isArray(info.socials) ? info.socials : [];
  const sites = Array.isArray(info.websites) ? info.websites : [];

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
    liqUsd: liq,
    liqBase: (p.liquidity && p.liquidity.base) || 0,
    liqQuote: (p.liquidity && p.liquidity.quote) || 0,
    fdv: p.fdv || 0,
    marketCap: p.marketCap || p.fdv || 0,
    createdAt: created,
    ageHours: created ? (Date.now() - created) / 3600000 : null,
    boosts: (p.boosts && p.boosts.active) || boosts[p.baseToken.address] || 0
  };
}

function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
function tx(t) { return { buys: (t && t.buys) || 0, sells: (t && t.sells) || 0 }; }

/* a coarse pre-rank so the client always gets the liveliest names first */
function rank(p) {
  const turnover = p.liqUsd > 0 ? p.vol.h1 / p.liqUsd : 0;
  return Math.log10(1 + p.vol.h24) * 1.6
       + Math.min(turnover, 12) * 1.1
       + Math.max(-30, Math.min(60, p.ch.h1)) * 0.05
       + Math.min(p.boosts, 1000) * 0.002;
}

async function build() {
  const { addresses, boosts } = await discover();
  if (!addresses.length) throw new Error('discovery returned nothing');

  const groups = chunk(addresses, 30);
  const results = await Promise.allSettled(
    groups.map((g) => getJSON('https://api.dexscreener.com/tokens/v1/solana/' + g.join(',')))
  );

  /* keep the deepest pair per base token */
  const best = new Map();
  for (const res of results) {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const p of res.value) {
      if (!p || !p.baseToken || !p.priceUsd) continue;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      if (liq < MIN_LIQ_USD) continue;
      const prev = best.get(p.baseToken.address);
      if (!prev || liq > ((prev.liquidity && prev.liquidity.usd) || 0)) {
        best.set(p.baseToken.address, p);
      }
    }
  }

  const pairs = Array.from(best.values())
    .map((p) => normalise(p, boosts))
    .sort((a, b) => rank(b) - rank(a))
    .slice(0, 44);

  /* SOL in dollars, from its own deepest pair */
  let solUsd = 0;
  try {
    const solPairs = await getJSON('https://api.dexscreener.com/tokens/v1/solana/' + SOL_MINT);
    if (Array.isArray(solPairs)) {
      const deep = solPairs
        .filter((p) => p.baseToken && p.baseToken.address === SOL_MINT && p.priceUsd)
        .sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
      if (deep) solUsd = parseFloat(deep.priceUsd) || 0;
    }
  } catch (e) { /* the client can still work from priceNative */ }

  return { solUsd, updatedAt: Date.now(), count: pairs.length, pairs, source: 'dexscreener' };
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
    return res.status(502).json({ error: String(err && err.message || err) });
  }
};
