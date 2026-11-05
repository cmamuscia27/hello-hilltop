import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import {
  cdnImageUrl,
  decryptToken,
  encryptToken,
  instagramPostUrl,
  normalizeMedia,
  parsePinUrls,
  postsFromMedia,
  renderInstagram,
  shouldRefreshToken,
} from "../src/instagram.js";
import worker from "../src/worker.js";

const migration = readFileSync(new URL("../migrations/0003_instagram.sql", import.meta.url), "utf8");
const originalFetch = globalThis.fetch;
const TOKEN = "IGAATOKEN1234567890abcdef";
const LONG_TOKEN = "LONGLIVEDTOKEN1234567890abcd";
const REFRESHED = "REFRESHEDTOKEN1234567890abcd";

const PAGE = `<!doctype html><section id="instagram"><!--IG_POSTS_START-->
<p class="ig-note">Photos from the block will show up here.</p>
<a class="btn btn-orange" href="https://www.instagram.com/hilltopneighborhooddenver/">Follow us on Instagram</a>
<!--IG_POSTS_END--></section>`;

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  function statement(sql) {
    const stmt = {
      _args: [],
      bind(...args) {
        stmt._args = args;
        return stmt;
      },
      async run() {
        const prepared = db.prepare(sql);
        const info = stmt._args.length ? prepared.run(...stmt._args) : prepared.run();
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
      async all() {
        const prepared = db.prepare(sql);
        const results = stmt._args.length ? prepared.all(...stmt._args) : prepared.all();
        return { results };
      },
      async first() {
        const prepared = db.prepare(sql);
        const row = stmt._args.length ? prepared.get(...stmt._args) : prepared.get();
        return row ?? null;
      },
    };
    return stmt;
  }
  return {
    prepare: statement,
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const stmt of statements) await stmt.run();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function envWith(db, extra = {}) {
  return {
    EXPORT_TOKEN: "export-secret",
    DB: db,
    ASSETS: {
      async fetch() {
        return new Response(PAGE, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    },
    ...extra,
  };
}

function auth(extra = {}) {
  return { Authorization: "Bearer export-secret", ...extra };
}

function mediaItem(overrides = {}) {
  return {
    id: "17890000000000001",
    caption: "Pumpkin walk on the block",
    media_type: "IMAGE",
    media_url: "https://scontent.cdninstagram.com/v/pumpkin.jpg",
    permalink: "https://www.instagram.com/p/AbC123xyz/?utm_source=ig",
    timestamp: "2026-10-31T18:00:00+0000",
    username: "hilltopneighborhooddenver",
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Instagram URL and media checks", () => {
  it("accepts public post URLs and rejects everything else", () => {
    assert.equal(instagramPostUrl("https://www.instagram.com/p/AbC123xyz/"), "https://www.instagram.com/p/AbC123xyz/");
    assert.equal(instagramPostUrl("https://instagram.com/reel/AbC123_x/?hl=en"), "https://www.instagram.com/reel/AbC123_x/");
    assert.equal(instagramPostUrl("https://instagr.am/tv/AbC123xyz"), "https://www.instagram.com/tv/AbC123xyz/");
    assert.equal(instagramPostUrl("https://www.instagram.com/reels/AbC123xyz/"), "https://www.instagram.com/reel/AbC123xyz/");
    assert.equal(instagramPostUrl("https://www.instagram.com/hilltopneighborhooddenver/"), "");
    assert.equal(instagramPostUrl("https://www.instagram.com/stories/hilltopneighborhooddenver/1/"), "");
    assert.equal(instagramPostUrl("http://www.instagram.com/p/AbC123xyz/"), "");
    assert.equal(instagramPostUrl("javascript:alert(1)"), "");
    assert.equal(instagramPostUrl("https://evil.example/p/AbC123xyz/"), "");
  });

  it("allows Instagram image CDNs and drops video files", () => {
    assert.equal(cdnImageUrl("https://scontent.cdninstagram.com/v/pumpkin.jpg"), "https://scontent.cdninstagram.com/v/pumpkin.jpg");
    assert.match(cdnImageUrl("https://instagram.fxyz1-1.fna.fbcdn.net/v/clip.jpg?stp=dst"), /fbcdn\.net/);
    assert.equal(cdnImageUrl("https://scontent.cdninstagram.com/v/clip.mp4"), "");
    assert.equal(cdnImageUrl("http://scontent.cdninstagram.com/v/pumpkin.jpg"), "");
    assert.equal(cdnImageUrl("https://evil.example/pumpkin.jpg"), "");
    assert.equal(cdnImageUrl("javascript:alert(1)"), "");
  });

  it("normalizes official media and refuses another account", () => {
    const image = normalizeMedia(mediaItem({ caption: "Pie <b>swap</b>" }));
    assert.equal(image.permalink, "https://www.instagram.com/p/AbC123xyz/");
    assert.equal(image.posted_at, "2026-10-31T18:00:00.000Z");
    assert.match(image.caption, /Pie/);
    const video = normalizeMedia(mediaItem({
      id: "17890000000000002",
      media_type: "VIDEO",
      media_url: "https://scontent.cdninstagram.com/v/clip.mp4",
      thumbnail_url: "https://scontent.cdninstagram.com/v/clip.jpg",
      permalink: "https://www.instagram.com/reel/Def456uvw/",
    }));
    assert.equal(video.image_url, "https://scontent.cdninstagram.com/v/clip.jpg");
    assert.equal(normalizeMedia(mediaItem({ username: "someoneelse" })), null);
    const foreign = postsFromMedia({ data: [mediaItem({ username: "SomeoneElse" })] });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error, "unexpected_account");
    const empty = postsFromMedia({ data: [] });
    assert.equal(empty.ok, true);
    assert.equal(empty.posts.length, 0);
  });

  it("renders escaped cards, a follow link, and an official embed without raw HTML", () => {
    const html = renderInstagram([
      normalizeMedia(mediaItem({ caption: "Hello <img src=x onerror=alert(1)>" })),
      {
        permalink: "https://www.instagram.com/reel/Def456uvw/",
        source: "oembed",
        caption: "<script>alert(1)</script>",
      },
    ]);
    assert.match(html, /Follow us on Instagram/);
    assert.match(html, /https:\/\/www\.instagram\.com\/p\/AbC123xyz\//);
    assert.match(html, /referrerpolicy="no-referrer"/);
    assert.match(html, /data-instgrm-permalink="https:\/\/www\.instagram\.com\/reel\/Def456uvw\/"/);
    assert.match(html, /https:\/\/www\.instagram\.com\/embed\.js/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img[^>]*onerror/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.equal(renderInstagram([]), "");
    const pins = parsePinUrls({ urls: ["https://www.instagram.com/p/AbC123xyz/", "https://www.instagram.com/p/AbC123xyz/?hl=en"] });
    assert.deepEqual(pins.urls, ["https://www.instagram.com/p/AbC123xyz/"]);
    assert.equal(parsePinUrls({ urls: ["https://example.com"] }).ok, false);
    assert.equal(parsePinUrls({ urls: Array(7).fill("https://www.instagram.com/p/AbC123xyz/") }).ok, false);
  });

  it("refreshes a token inside the last 10 days, after it is a day old", () => {
    const now = Date.parse("2026-11-05T00:00:00Z");
    assert.equal(shouldRefreshToken({
      token_expires_at: "2026-11-10T00:00:00Z",
      token_stored_at: "2026-10-01T00:00:00Z",
    }, now), true);
    assert.equal(shouldRefreshToken({
      token_expires_at: "2026-12-20T00:00:00Z",
      token_stored_at: "2026-10-01T00:00:00Z",
    }, now), false);
    assert.equal(shouldRefreshToken({
      token_expires_at: "2026-11-06T00:00:00Z",
      token_stored_at: "2026-11-04T12:00:00Z",
    }, now), false);
  });

  it("round-trips the token cipher and rejects the wrong key", async () => {
    const cipher = await encryptToken(TOKEN, "key-material-1234567890");
    assert.equal(cipher.includes(TOKEN), false);
    assert.equal(await decryptToken(cipher, "key-material-1234567890"), TOKEN);
    assert.equal(await decryptToken(cipher, "other-key-1234567890abcd"), "");
  });
});

describe("Instagram on the homepage", { concurrency: 1 }, () => {
  it("keeps the follow link and does not call Instagram when nothing is configured", async () => {
    const env = envWith(createDb());
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("should not fetch");
    };
    const res = await worker.fetch(new Request("https://hellohilltop.org/"), env, { waitUntil() {} });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Follow us on Instagram/);
    assert.match(html, /Photos from the block will show up here/);
    assert.equal(fetches, 0);
    const denied = await worker.fetch(new Request("https://hellohilltop.org/api/admin/instagram"), env);
    assert.equal(denied.status, 401);
  });

  it("caches official media, hides the token, and keeps the last posts when Instagram fails", async () => {
    const env = envWith(createDb(), { INSTAGRAM_ACCESS_TOKEN: TOKEN });
    const calls = [];
    let fail = false;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.Authorization, redirect: init.redirect });
      if (fail) return new Response(JSON.stringify({ error: { code: 190, message: "bad token " + TOKEN } }), { status: 401 });
      return new Response(JSON.stringify({
        data: [
          mediaItem({ caption: "Pumpkin walk <script>alert(1)</script>" }),
          mediaItem({
            id: "17890000000000002",
            media_type: "VIDEO",
            caption: "Reel from the park",
            media_url: "https://scontent.cdninstagram.com/v/clip.mp4",
            thumbnail_url: "https://scontent.cdninstagram.com/v/clip.jpg",
            permalink: "https://www.instagram.com/reel/Def456uvw/",
          }),
          mediaItem({ id: "17890000000000003", username: "someoneelse", permalink: "https://www.instagram.com/p/Nope99999/" }),
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const jobs = [];
    const first = await worker.fetch(new Request("https://hellohilltop.org/"), env, { waitUntil(promise) { jobs.push(promise); } });
    const firstHtml = await first.text();
    assert.match(firstHtml, /Photos from the block/);
    assert.doesNotMatch(firstHtml, /Pumpkin walk/);
    await Promise.all(jobs);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].redirect, "manual");
    assert.equal(calls[0].url.includes("access_token"), false);
    assert.match(calls[0].url, /graph\.instagram\.com\/v23\.0\/me\/media/);

    const page = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(page, /Pumpkin walk/);
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(page, /https:\/\/scontent\.cdninstagram\.com\/v\/clip\.jpg/);
    assert.doesNotMatch(page, /clip\.mp4/);
    assert.doesNotMatch(page, /someoneelse|Nope99999/);
    assert.match(page, /Follow us on Instagram/);
    assert.doesNotMatch(page, /embed\.js/);
    assert.equal(page.includes(TOKEN), false);
    const after = calls.length;
    await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.equal(calls.length, after);

    const status = await worker.fetch(new Request("https://hellohilltop.org/api/admin/instagram", { headers: auth() }), env);
    const body = await status.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, "graph");
    assert.equal(body.posts, 2);
    assert.equal(body.configured, true);
    assert.equal(body.token_saved, true);
    assert.equal(JSON.stringify(body).includes(TOKEN), false);
    const stored = await env.DB.prepare("SELECT token_cipher FROM instagram_meta WHERE id = 1").first();
    assert.ok(stored.token_cipher);
    assert.equal(stored.token_cipher.includes(TOKEN), false);
    const exported = await worker.fetch(new Request("https://hellohilltop.org/api/export?list=instagram_meta", { headers: auth() }), env);
    assert.equal(exported.status, 400);

    fail = true;
    const refresh = await worker.fetch(new Request("https://hellohilltop.org/api/admin/instagram/refresh", {
      method: "POST",
      headers: auth(),
    }), env);
    const refreshBody = await refresh.json();
    assert.equal(refresh.status, 200);
    assert.equal(refreshBody.ok, false);
    assert.equal(refreshBody.kept_previous, true);
    assert.equal(refreshBody.last_error, "instagram_190");
    assert.equal(JSON.stringify(refreshBody).includes(TOKEN), false);
    const still = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(still, /Pumpkin walk/);
  });

  it("exchanges a short token and later refreshes the long-lived one", async () => {
    const env = envWith(createDb(), { INSTAGRAM_ACCESS_TOKEN: TOKEN, INSTAGRAM_APP_SECRET: "app-secret-1234" });
    const calls = [];
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("/refresh_access_token")) {
        return new Response(JSON.stringify({ access_token: REFRESHED, token_type: "bearer", expires_in: 5184000 }));
      }
      if (href.includes("/access_token")) {
        assert.match(href, /grant_type=ig_exchange_token/);
        assert.match(href, /client_secret=app-secret-1234/);
        return new Response(JSON.stringify({ access_token: LONG_TOKEN, token_type: "bearer", expires_in: 5184000 }));
      }
      assert.equal(init.headers.Authorization, `Bearer ${calls.some((item) => item.includes("/refresh_access_token")) ? REFRESHED : LONG_TOKEN}`);
      return new Response(JSON.stringify({ data: [mediaItem()] }));
    };
    const first = await worker.fetch(new Request("https://hellohilltop.org/api/admin/instagram/refresh", {
      method: "POST",
      headers: auth(),
    }), env);
    assert.equal((await first.json()).ok, true);
    assert.match(calls[0], /\/access_token\?/);
    assert.match(calls[1], /\/me\/media/);

    await env.DB.prepare(
      "UPDATE instagram_meta SET token_expires_at = ?1, token_stored_at = ?2 WHERE id = 1"
    ).bind("2020-01-01T00:00:00.000Z", "2019-01-01T00:00:00.000Z").run();
    calls.length = 0;
    const second = await worker.fetch(new Request("https://hellohilltop.org/api/admin/instagram/refresh", {
      method: "POST",
      headers: auth(),
    }), env);
    const secondBody = await second.json();
    assert.equal(secondBody.ok, true);
    assert.ok(calls.some((href) => href.includes("/refresh_access_token") && href.includes(encodeURIComponent(LONG_TOKEN))));
    assert.equal(calls.some((href) => href.includes(TOKEN) && !href.includes(LONG_TOKEN)), false);
    const page = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(page, /Pumpkin walk/);
    assert.equal(page.includes(REFRESHED), false);
  });

  it("embeds pinned public posts with oEmbed and ignores Instagram's HTML", async () => {
    const env = envWith(createDb());
    globalThis.fetch = async (url) => {
      const href = String(url);
      assert.match(href, /graph\.facebook\.com\/v23\.0\/instagram_oembed/);
      assert.equal(href.includes("access_token"), false);
      const post = new URL(href).searchParams.get("url");
      if (post.endsWith("/Missing999/")) {
        return new Response(JSON.stringify({ error: { message: "missing", code: 24, error_subcode: 2207045 } }), { status: 400 });
      }
      return new Response(JSON.stringify({
        version: "1.0",
        type: "rich",
        provider_name: "Instagram",
        provider_url: "https://www.instagram.com/",
        html: `<blockquote class="instagram-media"><script>alert(1)</script></blockquote>`,
      }));
    };
    const bad = await worker.fetch(new Request("https://hellohilltop.org/api/admin/instagram/pins", {
      method: "PUT",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ urls: ["https://evil.example/p/AbC123xyz/"] }),
    }), env);
    assert.equal(bad.status, 400);

    const saved = await worker.fetch(new Request("https://hellohilltop.org/api/admin/instagram/pins", {
      method: "PUT",
      headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ urls: [
        "https://instagram.com/p/AbC123xyz/?hl=en",
        "https://www.instagram.com/reel/Def456uvw/",
        "https://www.instagram.com/p/Missing999/",
      ] }),
    }), env);
    const body = await saved.json();
    assert.equal(saved.status, 200);
    assert.equal(body.mode, "pins");
    assert.equal(body.posts, 2);
    assert.equal(body.last_error, "instagram_pin_incomplete");
    const page = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(page, /data-instgrm-permalink="https:\/\/www\.instagram\.com\/p\/AbC123xyz\/"/);
    assert.match(page, /data-instgrm-permalink="https:\/\/www\.instagram\.com\/reel\/Def456uvw\/"/);
    assert.match(page, /https:\/\/www\.instagram\.com\/embed\.js/);
    assert.match(page, /Follow us on Instagram/);
    assert.doesNotMatch(page, /alert\(1\)|Missing999/);
  });

  it("leaves the fallback in place when the tables are missing", async () => {
    const env = envWith({
      prepare() {
        return { bind() { return this; }, async all() { throw new Error("no such table: instagram_posts"); }, async first() { throw new Error("no such table"); } };
      },
    }, { INSTAGRAM_ACCESS_TOKEN: TOKEN });
    const res = await worker.fetch(new Request("https://hellohilltop.org/"), env, { waitUntil() { throw new Error("no seed"); } });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Follow us on Instagram/);
    assert.match(html, /Photos from the block/);
  });

  it("shows the follow link in the static homepage", () => {
    const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    assert.match(home, /<!--IG_POSTS_START-->/);
    assert.match(home, /Follow us on Instagram/);
    assert.match(home, /https:\/\/www\.instagram\.com\/hilltopneighborhooddenver\//);
    assert.match(css, /\.ig-posts\{[^}]*grid-template-columns:1fr 1fr/);
    assert.match(css, /@media \(min-width:700px\)\{[\s\S]*\.ig-posts\{grid-template-columns:repeat\(3,1fr\)/);
  });
});
