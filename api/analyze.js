/* ============================================================================
   POST /api/analyze
   Tradoor's brain. Takes the current book plus the trending pairs and asks a
   cheap-but-sharp LLM on fal.ai what to do next.

   Environment (set these on Vercel):
     FAL_KEY              required — your fal.ai key. Without it the endpoint
                          answers { ok:false, reason:"no-key" } and the client
                          falls back to its built-in scoring model.
     FAL_MODEL            default "google/gemini-2.5-flash-lite"
     FAL_ENDPOINT         default "openrouter/router"  (also try "fal-ai/any-llm")
     LLM_MAX_PER_MIN      default 25 — hard ceiling on spend, per instance
     LLM_IP_INTERVAL_MS   default 35000 — per-visitor cooldown

   The model only ever proposes. Position limits, sizing caps, stop losses and
   liquidity floors are enforced client-side in agent.js, so a hallucinated
   answer cannot break the book.
============================================================================ */

const FAL_MODEL    = process.env.FAL_MODEL || 'google/gemini-2.5-flash-lite';
const FAL_ENDPOINT = process.env.FAL_ENDPOINT || 'openrouter/router';
const MAX_PER_MIN  = parseInt(process.env.LLM_MAX_PER_MIN || '25', 10);
const IP_INTERVAL  = parseInt(process.env.LLM_IP_INTERVAL_MS || '35000', 10);

/* per-instance throttles — resets whenever Vercel spins a cold lambda */
let windowStart = 0;
let windowCount = 0;
const lastByIp = new Map();

const SYSTEM = [
  'You are Tradoor, an autonomous memecoin trader on Solana.',
  'You run a 10 SOL paper wallet with no human supervision.',
  '',
  'Your job is a steady stream of meaningful, realised wins — not moonshots, not scraps.',
  'A good trade banks 0.4 to 1 SOL net of fees on a position of roughly 2 SOL, so you',
  'are hunting 20-50% moves with an obvious invalidation right below the entry. When a',
  'trade works, most of it is banked at the target and a runner is left trailing for',
  'more — so pick setups with room to actually run: real volume, a fresh narrative, a',
  'chart that has not already done its move. Skip anything only good for a 5% wiggle,',
  'and skip anything you cannot see paying out within the hour.',
  '',
  'Some candidates carry "justMigratedMin": minutes since that coin graduated from the',
  'pump.fun bonding curve onto PumpSwap. A fresh graduate is a special play: the pool is',
  'brand new, the first 30-60 minutes decide everything, and the whole 1h change is just',
  'its life since migration — so the +150% rule does not apply there. Snipe them small',
  '(8-14%), aim for 20-40%, and never marry one. If buys dry up, it is over.',
  '',
  'Hard rules you must respect:',
  '- Maximum 5 open positions at once.',
  '- A single new position is 12-25% of total equity (8-14% for a fresh migration).',
  '- Never buy a pair with less than $15,000 of liquidity, you will not get out.',
  '- Never buy a non-migration pair whose 1h change is already above +150%: that is exit liquidity.',
  '- Never buy into a vertical 5m candle (above +40%, or +90% for a fresh migration).',
  '- Prefer momentum confirmed by volume and by more buys than sells in the last 5 minutes.',
  '- Deep liquidity relative to your size matters more than a big headline number:',
  '  slippage in and out is what turns a 15% move into a losing trade.',
  '- Treat a collapsing 5m against a strong 24h as distribution, not a dip to buy.',
  '- Cut losers fast, take the win when it is there, never average down.',
  '- Doing nothing is a valid, frequently correct answer.',
  '',
  'You answer with JSON only. No markdown, no commentary, no code fences.',
  'Schema:',
  '{"thesis":"one sentence on the state of the board",',
  ' "actions":[{"type":"BUY"|"SELL","address":"<mint from the candidate list>",',
  '             "sizePct":<12-25, BUY only>,"conviction":<0-100>,',
  '             "reason":"<max 160 chars, concrete numbers, no fluff>"}],',
  ' "watch":[{"address":"<mint>","reason":"<max 90 chars, what you are waiting for>"}]}',
  'Return at most 2 actions. Use an empty actions array when nothing is worth doing.'
].join('\n');

function trimCandidate(c) {
  return {
    symbol: c.symbol,
    name: c.name,
    address: c.address,
    priceUsd: r(c.priceUsd, 8),
    liqUsd: Math.round(c.liqUsd || 0),
    fdvUsd: Math.round(c.marketCap || c.fdv || 0),
    ageHours: c.ageHours === null || c.ageHours === undefined ? null : r(c.ageHours, 1),
    change: { m5: r(c.ch.m5, 1), h1: r(c.ch.h1, 1), h6: r(c.ch.h6, 1), h24: r(c.ch.h24, 1) },
    volumeUsd: { m5: Math.round(c.vol.m5), h1: Math.round(c.vol.h1), h24: Math.round(c.vol.h24) },
    txns5m: c.txns && c.txns.m5 ? c.txns.m5.buys + '/' + c.txns.m5.sells + ' buys/sells' : null,
    boosts: c.boosts || 0,
    socials: c.socials ? c.socials.length : 0,
    dex: c.dexId || null,
    justMigratedMin: c.isMigration && c.ageHours !== null && c.ageHours !== undefined
      ? Math.round(c.ageHours * 60) : null
  };
}
function r(v, d) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

function extractJSON(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

async function callFal(key, endpoint, payload) {
  const url = 'https://fal.run/' + endpoint;
  const attempt = async (scheme) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': scheme + ' ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    return { status: res.status, text };
  };

  let out = await attempt('Key');
  if (out.status === 401 || out.status === 403) out = await attempt('Bearer');
  if (out.status < 200 || out.status >= 300) {
    throw new Error('fal ' + out.status + ': ' + out.text.slice(0, 300));
  }
  try { return JSON.parse(out.text); } catch (e) { return { output: out.text }; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });

  const key = process.env.FAL_KEY || process.env.FAL_AI_KEY || '';
  if (!key) return res.status(200).json({ ok: false, reason: 'no-key' });

  /* ---- throttles: the key is yours, the traffic might not be ---- */
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; windowCount = 0; }
  if (windowCount >= MAX_PER_MIN) {
    return res.status(200).json({ ok: false, reason: 'throttled', retryInMs: 60000 - (now - windowStart) });
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'local';
  const last = lastByIp.get(ip) || 0;
  if (now - last < IP_INTERVAL) {
    return res.status(200).json({ ok: false, reason: 'cooldown', retryInMs: IP_INTERVAL - (now - last) });
  }
  if (lastByIp.size > 5000) lastByIp.clear();
  lastByIp.set(ip, now);

  /* ---- payload ---- */
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !Array.isArray(body.candidates)) {
    return res.status(400).json({ ok: false, reason: 'bad-body' });
  }

  const candidates = body.candidates.slice(0, 14).map(trimCandidate);
  const positions = (body.positions || []).slice(0, 6).map((p) => ({
    symbol: p.symbol,
    address: p.address,
    entryUsd: r(p.entryUsd, 8),
    markUsd: r(p.markUsd, 8),
    pnlPct: r(p.pnlPct, 1),
    pnlSol: r(p.pnlSol, 3),
    valueSol: r(p.valueSol, 3),
    targetPct: r(p.targetPct, 1),
    scaledOut: !!p.scaledOut,
    lane: p.lane || undefined,
    heldMinutes: Math.round(p.heldMinutes || 0)
  }));

  const user = JSON.stringify({
    wallet: {
      equitySol: r(body.equity, 3),
      freeSol: r(body.cash, 3),
      openPositions: positions.length,
      maxPositions: 5,
      sessionPnlPct: r(body.pnlPct, 1)
    },
    positions: positions,
    candidates: candidates,
    note: 'Prices are live from DEX Screener. Only addresses in candidates may be traded. ' +
          'Open positions already carry an automatic target, scale-out, trailing stop, ' +
          'stop loss and time stop — only propose SELL when the thesis itself has broken.'
  });

  windowCount++;
  const t0 = Date.now();

  try {
    const data = await callFal(key, FAL_ENDPOINT, {
      model: FAL_MODEL,
      system_prompt: SYSTEM,
      prompt: user,
      temperature: 0.35,
      max_tokens: 700
    });

    const raw = data.output || data.response || (data.data && data.data.output) || '';
    const parsed = extractJSON(raw);
    if (!parsed) {
      return res.status(200).json({ ok: false, reason: 'unparseable', raw: String(raw).slice(0, 400) });
    }

    return res.status(200).json({
      ok: true,
      model: FAL_MODEL,
      latencyMs: Date.now() - t0,
      thesis: typeof parsed.thesis === 'string' ? parsed.thesis.slice(0, 300) : '',
      actions: Array.isArray(parsed.actions) ? parsed.actions.slice(0, 2) : [],
      watch: Array.isArray(parsed.watch) ? parsed.watch.slice(0, 6) : [],
      usage: data.usage || null
    });
  } catch (err) {
    return res.status(200).json({ ok: false, reason: 'fal-error', error: String(err && err.message || err).slice(0, 300) });
  }
};
