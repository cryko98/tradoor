# Tradoor — $TRADOOR

An autonomous memecoin trading agent for Solana, as a website.

Tradoor pulls the **real** trending Solana board from the public DEX Screener API,
scores every pair, hands the shortlist to a language model on **fal.ai**, and trades
a **10 SOL paper wallet** on its own — with hard risk rules the model cannot argue
with. Every decision, thesis and fill is printed live in the terminal.

```
index.html    markup
styles.css    all styling (dark terminal, mint accent from the logo)
market.js     DEX Screener feed, normalisation, price history
agent.js      the book: scoring, execution, risk rules, persistence
app.js        rendering, charts, wiring — CONFIG lives at the top
api/pairs.js  serverless: trending Solana pairs, cached on the edge
api/analyze.js serverless: the fal.ai call (keeps your key server-side)
logo.jpg      logo + favicon
```

Static site plus two serverless functions. No build step, no dependencies.

---

## What is real and what is not

| Real | Simulated |
|---|---|
| Tokens, prices, liquidity, volume, buys/sells, pair age (DEX Screener) | The 10 SOL wallet |
| The scoring model and the risk rules | Fills, slippage, fees |
| The model's analysis and reasoning | Transaction signatures and slots |

Nothing is broadcast to a validator, no funds can be deposited or withdrawn, and the
footer says so in plain language. Keep it that way — the terminal is a demonstration,
not a brokerage.

---

## Deploy on Vercel

1. Push this repo to GitHub (already done if you are reading it there).
2. Vercel → **New Project** → import the repo → framework preset **Other** → Deploy.
   No build command, no output directory. The `api/` folder is picked up automatically.
3. Add the environment variable, then redeploy:

| Variable | Required | Default | What it does |
|---|---|---|---|
| `FAL_KEY` | yes | — | Your fal.ai API key. Without it the site still runs, on the built-in scoring model. |
| `FAL_MODEL` | no | `google/gemini-2.5-flash-lite` | Any model id the endpoint accepts, e.g. `openai/gpt-4.1-mini`, `anthropic/claude-haiku-4.5`. |
| `FAL_ENDPOINT` | no | `openrouter/router` | fal endpoint id. `fal-ai/any-llm` also works. |
| `LLM_MAX_PER_MIN` | no | `25` | Hard ceiling on model calls per minute per instance. Spend control. |
| `LLM_IP_INTERVAL_MS` | no | `35000` | Per-visitor cooldown between model calls. |

The site degrades gracefully at every step: no key → built-in scoring; the function
missing → the browser calls DEX Screener directly; the feed down → it retries and says
so in the stream.

### Cost

One decision cycle is roughly 1.5k input and 300 output tokens — a fraction of a cent
on a Flash-class model. `LLM_MAX_PER_MIN` is the ceiling that matters: at the default
25/minute you cannot spend more than about a dollar an hour no matter how much traffic
the page gets.

---

## Things to fill in before launch

Everything editable lives at the top of **`app.js`**:

```js
var CONFIG = {
  X_URL:    "",   // every X link. Empty leaves them inert and marked "Coming soon"
  BUY_URL:  "",   // every Buy button. Empty makes them scroll to the token section
  CONTRACT: ""    // fills the contract box and the copy buttons
};
```

---

## How the agent works

1. **Scan** — every 20s: boosted and newly profiled Solana tokens, then full pair data.
2. **Filter** — under $15K liquidity or already +250% on the hour is thrown out.
3. **Score** — conviction out of 100: momentum 26, trend 14, volume/LP 18, liquidity 13,
   5m buy pressure 14, token quality 15.
4. **Think** — top 14 plus the current book go to the model, which answers with a thesis
   and at most two actions.
5. **Execute** — every proposal is re-checked against the rulebook (position count, size
   cap, free SOL, liquidity floor) before it fills. Slippage comes off real pool depth.
6. **Manage** — stop −18%, half off at +42%, trailing stop 15% under the high, time stop
   at 45 minutes, instant exit if the pool drains 45%.

The rulebook is in `agent.js` under `RULES`, and the terminal on the site documents the
same numbers — change one, change the other.

## Session and state

A session is one UTC day. The wallet resets to 10.000 SOL at 00:00 UTC and the previous
day drops into the archive strip. The book lives in the visitor's `localStorage`, so it
survives a reload but is per-browser; the market data is shared by everybody.

To give every visitor the *same* book, put the state behind a KV store (Vercel KV or
Upstash) and move `agent.js`'s tick into a cron function — the module boundaries are
already drawn for it.

## Local preview

Any static server works for the front end (the API routes only exist on Vercel, and the
client falls back to calling DEX Screener directly when they 404):

```bash
npx serve .
```

For the full thing, including `/api`, use the Vercel CLI:

```bash
vercel dev
```
