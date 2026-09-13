# Supplements meta Worker

**Status: deployed and live** at `palestinelist.com/supplements/*` and `www.palestinelist.com/supplements/*` (Worker name: `palestinelist-supplements-meta`). Verified working: `curl -s https://palestinelist.com/supplements/genocide` returns the correct per-subtab `<title>`/`og:title`/`og:description`.

Fixes link previews when sharing a Supplements subtab (e.g. "It's a Genocide" or "It's Apartheid"). Without this, a crawler (Threads, Twitter/X, Facebook, Discord) fetching a shared link only ever sees the site's one static `<head>`, no matter what tab you meant to share, because the old `#supplements/genocide`-style hash links never reach the server at all. URL fragments are client-side only.

`js/main.js` writes real paths to the address bar for Supplements (`/supplements/genocide`, `/supplements/apartheid`, etc), everything else stays on the hash scheme. This Worker sits in front of just those paths, fetches the live `index.html`, rewrites the `<title>`/meta tags to match that subtab, and returns it. Every other request on the domain doesn't match the route and never touches this Worker.

## Prerequisites this relies on (already done)

- `palestinelist.com` and `www.palestinelist.com` A records are proxied (orange-cloud) through Cloudflare.
- SSL/TLS mode is **Full (strict)**.

If either of those ever gets reverted (e.g. someone flips a DNS record back to "DNS only" while debugging something unrelated), this Worker stops receiving traffic silently, no error, requests just go straight to origin, and `/supplements/*` links start 404ing since the origin has no file there. Check those two settings first if link previews stop working.

## Redeploying after a change to `worker.js`

```bash
cd worker-supplements
wrangler deploy
```

No login/secrets step needed, `wrangler login` was already done and persists. No secrets needed either since this Worker doesn't call any external API.

## Test after any change

```bash
curl -s https://palestinelist.com/supplements/genocide | grep -E '<title>|og:title|og:description'
```

Should show `It's a Genocide | The Palestine List | …`, not the generic site title. Paste the URL into a link-preview debugger (e.g. Facebook's Sharing Debugger, or Twitter's Card Validator) to see exactly what a crawler will render.

## Maintaining `SUBTAB_META`

`worker.js` has one entry per Supplements subtab (`solidarity`, `liberation`, `genocide`, `apartheid`, `timeline`), each with a `title` and a one-line `description`. If a subtab is ever added, renamed, or removed under Supplements, update `TAB_SUBTABS.supplements` in `js/main.js` **and** the `SUBTAB_META` object here to match. The two aren't auto-synced.

## Not auto-deployed

Unlike `worker/` (the search proxy), this directory isn't wired into `.github/workflows/deploy-worker.yml`. That workflow only watches `worker/**`. Deploy manually with `wrangler deploy` above, or copy that workflow if you want it to auto-deploy on push.
