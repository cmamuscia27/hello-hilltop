# Hello! Hilltop: hellohilltop.org (Phase 1)

A site for Hello! Hilltop, a neighbor-run community group in Hilltop, Denver. It runs as one Cloudflare Worker with static assets, and a D1 database stores the email signups, Idea Box submissions, neighborhood events, and a cached local-news strip. There's no framework, no build step, and no third-party form services.

## Layout

```
wrangler.jsonc      Worker config: assets, D1 binding, cron, custom domains
src/worker.js       API, page rendering, cron, www→apex redirect, security headers
src/events.js       Event validation, admin queries, event cards
src/news.js         RSS/Atom parse, neighborhood filter, news cache
src/instagram.js    Official Instagram media cache, oEmbed pins, token renewal
src/page.js         Fills the homepage and /events from D1
src/time.js         America/Denver clocks
public/             Static site (index.html, events.html, styles.css, app.js, 404.html, img/, favicons)
migrations/         D1 migrations. 0001 adds events and news. 0003 adds Instagram.
schema.sql          Full D1 schema for a brand-new database (signups, ideas, events, news, Instagram)
test/               Worker checks for forms, events, and the news filter
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
| Secrets | `EXPORT_TOKEN` (bearer token for the export endpoint) and `TURNSTILE_SECRET` (Turnstile siteverify). Both are Worker secrets, already set on the deployed Worker, and neither belongs in git. `INSTAGRAM_ACCESS_TOKEN` is the long-lived Instagram token for recent posts. It is not set until the account owner creates it. Optional `INSTAGRAM_APP_SECRET` is only for exchanging a 1-hour token. None of these belong in git. |

## Forms

- `POST /api/signup` takes `email` (required), `name` (optional), and `volunteer` (checkbox). A repeat email updates the existing row instead of adding a duplicate.
- `POST /api/ideas` takes `idea` (required, 3–2000 chars), `name` (optional), `email` (optional), and `would_help` (checkbox).
- Both endpoints accept JSON (used by app.js, which shows the success message inline) or a regular form post (without JS, the visitor is redirected to `/?thanks=signup#signup` and similar).
- Spam protection, in order:
  - A hidden `website` honeypot on both forms. Submissions that fill it get a fake success response and nothing is saved.
  - Cloudflare Turnstile (managed widget, shown only when a check is needed) on both forms. The public site key is in the page. The Worker checks the token with `https://challenges.cloudflare.com/turnstile/v0/siteverify` (secret `TURNSTILE_SECRET`, visitor IP from `CF-Connecting-IP`) before any D1 insert. A missing or invalid token gets a friendly error and is not saved. The page stays put after submit, so the widget is reset for the next try.
  - Idea Box only: a conservative server-side filter rejects URLs and a short list of SEO pitches (`SEO`, `search engine`, `ranking`, `index your site`, `backlinks`, `google index`). Ordinary neighbor notes, including words like "Seoul" or "season", still go through.
- The site does not send a Content-Security-Policy header, so nothing else is required for Turnstile. A future CSP must allow `https://challenges.cloudflare.com` on `script-src` and `frame-src`.

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

## What's happening in your hood

The homepage section (and `/events`) is filled from D1 when the page is served. A visit never fetches an RSS feed. If the news tables are missing, the page keeps the friendly empty state instead of erroring.

### Events

Events are managed by us. There is no public submission form. Times are America/Denver. Send a Denver wall time like `2026-11-21T14:00` (no timezone), or a full ISO timestamp with `Z` or an offset. The response includes both the UTC instant and the Denver clock time.

An event with no end time stays up through the end of its Denver start day, then drops off. An event with an end time drops off at that end time. Same title and same Denver start time updates the existing row instead of adding a second one.

The homepage shows the next two upcoming events, with a link to `/events` for the full list. The header has an Events link on desktop and on a phone. Icons are chosen from the title and description (storytime gets a book, zoo lights get sparkles, and so on). Send `"icon": "🦁"` to pick one yourself, or `"icon": null` to clear it. That column is `migrations/0002_event_icon.sql`. Like the first hood migration, `wrangler deploy` does not apply it:

```bash
npx wrangler d1 migrations apply hello-hilltop-db --remote
```

Until that runs, events still show and the page picks the icon. Saving a custom icon answers with a reminder to apply the migration.

```bash
TOKEN=...   # the same EXPORT_TOKEN as /api/export

# Upcoming events. Add ?all=1 to include ones that already ended.
curl -H "Authorization: Bearer $TOKEN" "https://hellohilltop.org/api/admin/events"

# Create. Repeat the same title and start time to update that row.
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Pie swap","starts_at":"2026-11-21T14:00","ends_at":"2026-11-21T16:00","location":"Cranmer Park","description":"Bring a pie, leave with a different one.","link":"https://hellohilltop.org/#hood","source_name":"Hello! Hilltop"}' \
  "https://hellohilltop.org/api/admin/events"

# Update one field, or delete.
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"location":"Cranmer Park, north lawn"}' \
  "https://hellohilltop.org/api/admin/events/1"
curl -X DELETE -H "Authorization: Bearer $TOKEN" "https://hellohilltop.org/api/admin/events/1"
```

`PUT` works the same as `PATCH`. A missing or wrong token is 401.

### Local news

A Cron Trigger runs every 4 hours (`0 */4 * * *`, UTC) and fetches:

- https://denverite.com/feed/
- https://news.google.com/rss/search?q=%22Hilltop%22+Denver+OR+%22Cherry+Creek%22+Denver&hl=en-US&gl=US&ceid=US:en
- https://cherrycreeknorth.com/feed/
- https://www.9news.com/feeds/syndication/rss/news/local
- https://www.denver7.com/news/local-news.rss

Items are kept when the title or description mentions Hilltop (in a Denver context), Cherry Creek, Crestmoor, Lowry, Glendale, Hale, Montclair, Congress Park, Cranmer Park, Colorado Blvd, 6th Ave, Alameda, Holly, Monaco, Steck, Graland, East High, or Cherry Creek Schools. Crime and traffic stories are dropped (shooting, killed, homicide, crash, arrest, stabbing, and close cousins). A "Hilltop" story that isn't Denver, or that names another city or state, is dropped. Duplicates collapse by link and by title, and a direct article link wins over a Google News link.

The strip shows up to 6 headlines from the last 30 days, with the source name and the Denver date. Each headline opens the feed's link in a new tab. No article text or images are stored or shown. If fewer than 3 neighborhood matches are in that window, Denverite stories about community, food, parks, and family can fill in. Politics and government-meeting stories (elections, ballots, council votes, the RTD board, and similar) are not used as filler. If nothing suitable is left, the strip shows fewer headlines, or a short friendly line. Google News items credit the publisher named in the feed. Those links are Google News article URLs, because that feed doesn't include the publisher's own article URL.

Each feed is requested with a normal browser user agent. A 503, a timeout, or a body that isn't a feed is tried once more with a second browser. 9NEWS items that put the story URL in `<guid>` instead of `<link>` are still kept. A feed that still fails leaves its previous rows in place.

If a feed fails, its previous rows stay. If every feed fails, the whole last good list stays. When the news cache has never been filled, the first page view starts one background refresh and still renders whatever is already stored (the empty state, until that refresh finishes). It does not call the feeds again on later visits. To fill the strip immediately, use the refresh endpoint:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" "https://hellohilltop.org/api/admin/news/refresh"
```

The JSON lists each feed as `ok` or an error, plus how many items were saved. A failed refresh returns `"kept_previous": true` and does not clear the strip.

## Instagram

The homepage section `#instagram` shows recent posts from [@hilltopneighborhooddenver](https://www.instagram.com/hilltopneighborhooddenver/) and a Follow us on Instagram link. A visit reads D1 only. If the Instagram tables are missing, the token is missing, or Instagram returns an error, the colorful follow-us block stays in place and the page still loads.

Two official Meta paths are used. Nothing is scraped, and no unofficial Instagram API is called.

### Automatic posts (preferred)

This uses the [Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started). The cron (`0 */4 * * *`, the same trigger as news) calls `GET https://graph.instagram.com/v23.0/me/media` with `instagram_business_basic` and caches up to 6 posts. Photos and carousel covers use `media_url`. Videos and Reels use `thumbnail_url` only, because `media_url` on a video is a video file. Those CDN links expire, so the cron refreshes them. The rendered page does not load Instagram's script.

The site does not log anyone in. The owner generates a token in the Meta app dashboard and stores it as a Worker secret.

1. In the Instagram app, switch `@hilltopneighborhooddenver` to a professional account (Business or Creator). Instagram Login does not need a linked Facebook Page.
2. Create a Meta app at [developers.facebook.com/apps](https://developers.facebook.com/apps). Add the product **Instagram API with Instagram login** (the dashboard may say "API setup with Instagram business login").
3. Add `@hilltopneighborhooddenver` to the app. In development mode the account has to be an app admin, developer, or Instagram tester. App Review is not required for this app to read its own posts. Do not request publish, comment, or message permissions. `instagram_business_basic` is the one this site uses.
4. In the Instagram API setup screen, choose **Generate token**, log in as `@hilltopneighborhooddenver`, and accept the permission. A token from that screen is long-lived (about 60 days). A token from the browser login-code flow is only good for about an hour. Copy the token once. It is a secret.
5. Store it, and do not put it in git, in `wrangler.jsonc`, or in a build variable:

```bash
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
```

6. Apply the migration. `wrangler deploy` does not apply it:

```bash
npx wrangler d1 migrations apply hello-hilltop-db --remote
```

7. Deploy, then fill the section without waiting for the cron:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" "https://hellohilltop.org/api/admin/instagram/refresh"
curl -H "Authorization: Bearer $TOKEN" "https://hellohilltop.org/api/admin/instagram"
```

`$TOKEN` is the existing `EXPORT_TOKEN`, not the Instagram token. The status JSON includes `mode`, `posts`, `token_expires_at`, and `last_error`. It never includes the Instagram token. `mode` is `graph` when the automatic feed is cached.

Only posts whose username is `hilltopneighborhooddenver` are kept. A token for a different account is rejected and the follow-us block stays up.

### What the owner still has to do

The code cannot authorize the Instagram account. Until `INSTAGRAM_ACCESS_TOKEN` is set on the Worker, the homepage shows the follow link and the color tiles, not live posts. After the secret is set, the first page view starts one background refresh, and the cron keeps doing it.

Token renewal:

- The first successful save treats the secret as good for about 50 days. That is shorter than Meta's 60-day dashboard token, so the first refresh has room to fail and retry.
- When the stored expiry is inside 10 days, and the saved token is at least 24 hours old, the cron calls `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`. Meta only refreshes a long-lived token that has not expired.
- The new token is encrypted with AES-GCM and stored in `instagram_meta.token_cipher`. The key is `INSTAGRAM_ACCESS_TOKEN`, so that secret has to stay in place. It is the encryption key even after Meta would have expired the original token string. The Worker then sends the refreshed token, not the original one.
- Media requests send the token in an `Authorization` header, not the query string. Meta's refresh and exchange calls are the exception: their documented URLs put the token (and, for an exchange, the app secret) in the query string. The Worker does not write those URLs or the token into its logs.
- Check `token_expires_at` and `last_error` with `GET /api/admin/instagram`. `instagram_190` means Meta rejected the token. Generate a new dashboard token and run `npx wrangler secret put INSTAGRAM_ACCESS_TOKEN` again.
- If this D1 database is recreated after the original token has expired, generate a new token. The secret is the fallback when no encrypted token can be read.
- Optional. Only if the secret is a 1-hour token from the code flow, also set the Instagram app secret (not the token) so the Worker can exchange it once:

```bash
npx wrangler secret put INSTAGRAM_APP_SECRET
```

The exchange calls `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`. A dashboard 60-day token does not need this secret. If the exchange fails, the Worker does not store that short-lived token as if it lasted 50 days. It retries the exchange on a later refresh.

Locally, put `INSTAGRAM_ACCESS_TOKEN=...` in `.dev.vars` (gitignored). Leave it unset to see the follow-us state.

### Pinned posts (temporary)

Until the token exists, an admin can name up to 6 public post, Reel, or IGTV URLs. The Worker checks each one with tokenless [Instagram oEmbed](https://developers.facebook.com/docs/graph-api/reference/instagram-oembed/) (`GET https://graph.facebook.com/v23.0/instagram_oembed`, no access token, since 15 June 2026) and, if Instagram confirms it, renders Instagram's official embed. oEmbed does not provide a profile timeline. Pinned URLs are not used while the automatic feed is available. An empty `urls` list clears the pins.

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"urls":["https://www.instagram.com/p/SHORTCODE/","https://www.instagram.com/reel/SHORTCODE/"]}' \
  "https://hellohilltop.org/api/admin/instagram/pins"
```

A bad URL is rejected. The embed loads `https://www.instagram.com/embed.js` in the visitor's browser. The automatic feed does not. If a Content-Security-Policy is added later, pinned embeds need `https://www.instagram.com` on `script-src`, and the automatic photos need `https://*.cdninstagram.com` and `https://*.fbcdn.net` on `img-src`.

## Deploy

### Option A: wrangler (once an API token or `wrangler login` is available)

```bash
npm i -D wrangler
npx wrangler d1 execute hello-hilltop-db --remote --file=schema.sql   # only for a fresh database
npx wrangler d1 migrations apply hello-hilltop-db --remote             # existing database: events, news, Instagram
npx wrangler secret put EXPORT_TOKEN                                  # only once
npx wrangler secret put TURNSTILE_SECRET                              # already set; do not commit the value
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN                        # after the Meta dashboard token exists
npx wrangler deploy
```

`wrangler deploy` does not apply D1 migrations, and neither does a Workers Builds deploy that only runs `npx wrangler deploy`. Run the migrations command yourself before or right after the code deploys. The new tables are additive, so applying the migration before the new code is live is safe. After the first deploy, `POST /api/admin/news/refresh` fills the strip without waiting for the cron.

### Option B: Cloudflare Workers Builds

Connect the existing Worker so a push to `main` deploys https://hellohilltop.org by itself.

1. In the Cloudflare dashboard, open **Workers & Pages → hello-hilltop → Settings → Build → Connect to Git**.
2. Authorize the Cloudflare GitHub app for this repo if GitHub asks, then choose `cmamuscia27/hello-hilltop`. Set the production branch to `main`.
3. Leave the build command empty. This site has no build step. Set the deploy command to `npx wrangler deploy`, and leave the root directory as the repo root. The Worker name in the dashboard must stay `hello-hilltop`, matching `name` in `wrangler.jsonc`, or the build fails.
4. Save. The next push to `main` runs that deploy. It does not apply `migrations/`. Run `npx wrangler d1 migrations apply hello-hilltop-db --remote` once so the Instagram tables exist.

`EXPORT_TOKEN` stays a Worker secret under **Settings → Variables and Secrets**. Do not put its value in the repo, in `wrangler.jsonc`, or in a build variable. A normal `wrangler deploy` keeps the secret already stored on the Worker.

### Option C: raw API (how the first deploy was done)

1. `POST /accounts/{id}/workers/scripts/hello-hilltop/assets-upload-session` with a manifest of `{ "/path": { hash, size } }`. The hash is 32 hex chars; we used sha256(base64(file) + ext) truncated to 32.
2. Upload each returned bucket to `POST /accounts/{id}/workers/assets/upload?base64=true`, using `Authorization: Bearer <session jwt>` and multipart fields named by hash. The last upload returns the completion JWT.
3. `PUT /accounts/{id}/workers/scripts/hello-hilltop` as multipart, with metadata `{ main_module: "worker.js", compatibility_date, assets: { jwt, config: { run_worker_first: true, not_found_handling: "404-page" } }, bindings: [assets ASSETS, d1 DB, secret_text EXPORT_TOKEN] }` plus the `worker.js` module part.
4. `PUT /accounts/{id}/workers/domains` for each hostname, with `service: "hello-hilltop"`.

If you redeploy the script through the API, re-send the `secret_text` binding, or use `"keep_bindings": ["secret_text"]`, so the export token isn't lost.

## Local check

```bash
npx wrangler d1 migrations apply hello-hilltop-db --local
npx wrangler dev --test-scheduled
# in another shell, with the port wrangler printed (8787 below):
curl "http://localhost:8787/__scheduled?cron=0+*/4+*+*+*"
# Wrangler also accepts /cdn-cgi/local/scheduled?cron=0+*/4+*+*+*
curl -H "Authorization: Bearer $TOKEN" "http://localhost:8787/api/admin/events"
```

Put `EXPORT_TOKEN=...` in `.dev.vars` (gitignored) so the local admin routes accept the same header. Add `INSTAGRAM_ACCESS_TOKEN` there only when a real token is available. `node --test` runs the form, hood, and Instagram checks without wrangler.

## Content notes

- Membership tiers are shown as **coming soon**. No payments are collected yet (Phase 2: Ghost + Stripe).
- Stroll & Tell is a teaser. No editorial partner is named.
- Don't add the names, ages, or contact info of minors without a parent's OK.
