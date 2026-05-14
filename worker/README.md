# PalestineList smart-search proxy

This folder is a Cloudflare Worker that holds the Thaura API key and forwards
recommendation/search requests from the static site at palestinelist.com.
The key never reaches the browser.

## Why a proxy?

The site is static HTML/JS. Anything you put in client JS is visible to every
visitor who views source. If we called Thaura directly from the page, anyone
could copy the key and use up your credits. The Worker sits in between: the
browser POSTs to the Worker, the Worker adds the key and forwards to Thaura.

## What it costs

Cloudflare Workers free plan: **100,000 requests/day**. PalestineList isn't a
high-traffic site, so you'll be nowhere near that.

Thaura usage: $0.50 per million input tokens, $2.00 per million output tokens.
A typical "help me decide" call sends ~30 candidates (~2,000 input tokens) and
gets a small JSON response (~150 output tokens), so each call costs roughly
**$0.0013** — under a fifth of a cent. 1000 calls a month is about $1.30.

## One-time setup

1. Install wrangler (Cloudflare's CLI):
   ```bash
   npm install -g wrangler
   ```
2. Log in to Cloudflare:
   ```bash
   wrangler login
   ```
   This opens a browser to authorize. Use the same Cloudflare account that
   manages palestinelist.com's DNS.
3. From this `worker/` folder, set the two secrets:
   ```bash
   wrangler secret put THAURA_API_KEY
   # paste your Thaura API key when prompted
   wrangler secret put ALLOWED_ORIGIN
   # type: https://palestinelist.com
   ```
4. Deploy:
   ```bash
   wrangler deploy
   ```
   Wrangler prints the URL it deployed to, something like
   `https://palestinelist-search.<your-subdomain>.workers.dev`.
   That's the URL the site will call.

## Wire it into the site

Open `/js/search.js` in the repo and update the constant:

```js
const WORKER_BASE = "https://palestinelist-search.<your-subdomain>.workers.dev";
```

(Or, if you set up a custom subdomain like `search.palestinelist.com` in
Cloudflare's Workers → Triggers, use that instead — it's cleaner.)

## Updating later

When you change `worker.js`, just run `wrangler deploy` again from this folder.
Secrets stay set across deploys.

## Testing locally

```bash
wrangler dev
```

Runs the worker on `http://127.0.0.1:8787`. You can `curl` it:

```bash
curl http://127.0.0.1:8787/api/healthz
# → ok
```

## Endpoints

- `POST /api/recommend` — "help me decide" flow. See `worker.js` header
  comment for the request shape.
- `POST /api/semantic-rank` — natural-language search. Takes a query and a
  pre-filtered candidate list, returns ranked ids.
- `GET  /api/healthz` — returns `ok`. Useful for uptime checks.
