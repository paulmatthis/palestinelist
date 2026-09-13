# Supplements meta Worker

Fixes link previews when sharing a Supplements subtab (e.g. "It's a Genocide" or "It's Apartheid"). Without this, a crawler (Threads, Twitter/X, Facebook, Discord) fetching a shared link only ever sees the site's one static `<head>`, no matter what tab you meant to share, because the old `#supplements/genocide`-style hash links never reach the server at all. URL fragments are client-side only.

`js/main.js` now writes real paths to the address bar instead (`/supplements/genocide`, `/supplements/apartheid`, etc). This Worker sits in front of just those paths, fetches the live `index.html`, rewrites the `<title>`/meta tags to match that subtab, and returns it. Every other request on the domain doesn't match the route and never touches this Worker.

## One-time setup (do this before deploying)

1. In the Cloudflare dashboard, under DNS for `palestinelist.com`, proxy (orange-cloud) the A record for `palestinelist.com` and the wildcard record. They're currently "DNS only" (grey-cloud). A Worker route can't intercept traffic that isn't proxied through Cloudflare.
2. Under SSL/TLS, set the encryption mode to **Full (strict)**. The origin already has a valid Let's Encrypt cert, so this is a one-time setting, not a migration. Leaving it on "Flexible" can cause redirect loops if the origin also forces HTTPS.
3. Confirm the site still loads correctly at `https://palestinelist.com/` after step 1. This part is reversible: flip the DNS record back to "DNS only" any time if something looks wrong.

## Deploy

```bash
cd worker-supplements
npm install -g wrangler   # if you don't already have it
wrangler login
wrangler deploy
```

This reuses your existing Cloudflare account (same one already running `palestinelist-search` at `search.palestinelist.com`). No new secrets needed, since this Worker doesn't call any external API.

## Test

```bash
curl -s https://palestinelist.com/supplements/genocide | grep -E '<title>|og:title|og:description'
```

Should show `It's a Genocide | The Palestine List | …`, not the generic site title. Paste the URL into a link-preview debugger (e.g. Facebook's Sharing Debugger, or Twitter's Card Validator) to see exactly what a crawler will render.

## Maintaining `SUBTAB_META`

`worker.js` has one entry per Supplements subtab (`solidarity`, `liberation`, `genocide`, `apartheid`, `timeline`), each with a `title` and a one-line `description`. If a subtab is ever added, renamed, or removed under Supplements, update `TAB_SUBTABS.supplements` in `js/main.js` **and** the `SUBTAB_META` object here to match. The two aren't auto-synced.

## Not auto-deployed

Unlike `worker/` (the search proxy), this directory isn't wired into `.github/workflows/deploy-worker.yml`. That workflow only watches `worker/**`. Deploy manually with `wrangler deploy` above, or copy that workflow if you want it to auto-deploy on push.
