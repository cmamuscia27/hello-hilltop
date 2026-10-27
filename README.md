# Hello! Hilltop: hellohilltop.org (Phase 1)

A one-page site for Hello! Hilltop, a neighbor-run community group in Hilltop, Denver. It runs as one Cloudflare Worker with static assets, and a D1 database stores the email signups and Idea Box submissions. There's no framework, no build step, and no third-party form services.

## Layout

```
wrangler.jsonc      Worker config: assets, D1 binding, custom domains
src/worker.js       API (/api/signup, /api/ideas, /api/export, /api/health), www→apex redirect, security headers
public/             Static site (index.html, styles.css, app.js, 404.html, img/, favicons)
schema.sql          D1 tables: signups, ideas
print/              QR code PNG + 8x10" table-sign PNG/PDF (300 dpi)
screenshots/        Live desktop and mobile screenshots
```

## Cloudflare resources

| Thing | Value |
|---|---|
| Account | c74b4a5d3545b51f59db846c41a52483 |
| Worker | `hello-hilltop` (workers.dev subdomain disabled) |
| D1 database | `hello-hilltop-db`, id `496719ee-16dd-418b-a280-94fc05d11fb1` |
| Custom domains | `hellohilltop.org` (serves the site) and `www.hellohilltop.org` (301 to the apex) |
| Secret | `EXPORT_TOKEN`: bearer token for the export endpoint (not in git) |

## Forms

- `POST /api/signup` takes `email` (required), `name` (optional), and `volunteer` (checkbox). A repeat email updates the existing row instead of adding a duplicate.
- `POST /api/ideas` takes `idea` (required, 3–2000 chars), `name` (optional), `email` (optional), and `would_help` (checkbox).
- Both endpoints accept JSON (used by app.js, which shows the success message inline) or a regular form post (without JS, the visitor is redirected to `/?thanks=signup#signup` and similar).
- Spam protection: a hidden `website` honeypot field. Bots that fill it get a fake success response and nothing is saved. Server-side checks cover email format and field length limits.

## Export the lists

Use the token from `EXPORT_TOKEN`. Courtney's copy is saved outside the repo in `/workspace/hilltop/.hello-hilltop-export-token`.

```bash
TOKEN=...   # the EXPORT_TOKEN value
curl -H "Authorization: Bearer $TOKEN" "https://hellohilltop.org/api/export?list=signups" -o signups.csv
curl -H "Authorization: Bearer $TOKEN" "https://hellohilltop.org/api/export?list=ideas"   -o ideas.csv
# JSON instead of CSV:  &format=json
```

Without a valid token, the endpoint returns 401. You can also pull the lists with no token:

- **Cloudflare dashboard:** Storage & Databases → D1 → `hello-hilltop-db` → Console. Run `SELECT * FROM signups;`.
- **API:** `POST /accounts/{account}/d1/database/496719ee-16dd-418b-a280-94fc05d11fb1/query` with `{"sql":"SELECT * FROM signups"}`.

Timestamps (`created_at`) are stored in UTC.

## Deploy

### Option A: wrangler (once an API token or `wrangler login` is available)

```bash
npm i -D wrangler
npx wrangler d1 execute hello-hilltop-db --remote --file=schema.sql   # only for a fresh database
npx wrangler secret put EXPORT_TOKEN                                  # only once
npx wrangler deploy
```

### Option B: Cloudflare Workers Builds

Connect the existing Worker so a push to `main` deploys https://hellohilltop.org by itself.

1. In the Cloudflare dashboard, open **Workers & Pages → hello-hilltop → Settings → Build → Connect to Git**.
2. Authorize the Cloudflare GitHub app for this repo if GitHub asks, then choose `cmamuscia27/hello-hilltop`. Set the production branch to `main`.
3. Leave the build command empty. This site has no build step. Set the deploy command to `npx wrangler deploy`, and leave the root directory as the repo root. The Worker name in the dashboard must stay `hello-hilltop`, matching `name` in `wrangler.jsonc`, or the build fails.
4. Save. The next push to `main` runs that deploy.

`EXPORT_TOKEN` stays a Worker secret under **Settings → Variables and Secrets**. Do not put its value in the repo, in `wrangler.jsonc`, or in a build variable. A normal `wrangler deploy` keeps the secret already stored on the Worker.

### Option C: raw API (how the first deploy was done)

1. `POST /accounts/{id}/workers/scripts/hello-hilltop/assets-upload-session` with a manifest of `{ "/path": { hash, size } }`. The hash is 32 hex chars; we used sha256(base64(file) + ext) truncated to 32.
2. Upload each returned bucket to `POST /accounts/{id}/workers/assets/upload?base64=true`, using `Authorization: Bearer <session jwt>` and multipart fields named by hash. The last upload returns the completion JWT.
3. `PUT /accounts/{id}/workers/scripts/hello-hilltop` as multipart, with metadata `{ main_module: "worker.js", compatibility_date, assets: { jwt, config: { run_worker_first: true, not_found_handling: "404-page" } }, bindings: [assets ASSETS, d1 DB, secret_text EXPORT_TOKEN] }` plus the `worker.js` module part.
4. `PUT /accounts/{id}/workers/domains` for each hostname, with `service: "hello-hilltop"`.

If you redeploy the script through the API, re-send the `secret_text` binding, or use `"keep_bindings": ["secret_text"]`, so the export token isn't lost.

## Content notes

- Membership tiers are shown as **coming soon**. No payments are collected yet (Phase 2: Ghost + Stripe).
- Stroll & Tell is a teaser. No editorial partner is named.
- Don't add the names, ages, or contact info of minors without a parent's OK.
