import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { parseDenverInput } from "../src/time.js";
import { iconForEvent } from "../src/events.js";
import { classifyItem, parseFeed, selectNews, titleKey } from "../src/news.js";
import worker from "../src/worker.js";

const migration = ["0001_hood.sql", "0002_event_icon.sql"]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const originalFetch = globalThis.fetch;

const HOME = `<!doctype html><html><body>
<div class="events"><!--HOOD_EVENTS_START-->
<p class="empty-hood">fallback events</p>
<!--HOOD_EVENTS_END--></div>
<div><!--HOOD_NEWS_START-->
<p class="empty-hood">fallback news</p>
<!--HOOD_NEWS_END--></div>
</body></html>`;

const EVENTS_PAGE = `<!doctype html><title>Upcoming events</title><body>
<div class="events"><!--HOOD_EVENTS_PAGE_START-->
<p>fallback page</p>
<!--HOOD_EVENTS_PAGE_END--></div>
</body></html>`;

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
      const results = [];
      db.exec("BEGIN");
      try {
        for (const stmt of statements) results.push(await stmt.run());
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return results;
    },
  };
}

function envWith(db, assetsHtml = HOME) {
  return {
    EXPORT_TOKEN: "export-secret",
    DB: db,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const html = path === "/events.html" ? EVENTS_PAGE : assetsHtml;
        return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
      },
    },
  };
}

function authHeaders(extra = {}) {
  return { Authorization: "Bearer export-secret", ...extra };
}

function eventBody(overrides = {}) {
  return {
    title: "Pie swap",
    starts_at: "2027-06-15T14:00",
    ends_at: "2027-06-15T16:00",
    location: "Cranmer Park",
    description: "Bring a pie, leave with a different one.",
    link: "https://hellohilltop.org/#hood",
    source_name: "Hello! Hilltop",
    ...overrides,
  };
}

async function postEvent(env, body, method = "POST", path = "/api/admin/events") {
  return worker.fetch(new Request(`https://hellohilltop.org${path}`, {
    method,
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  }), env);
}

function feed(name) {
  return { id: name, name, denverSource: name !== "google", fallback: name === "denverite" };
}

function rss(items) {
  const body = items.map((item) => `<item>
    <title>${item.title}</title>
    <link>${item.link}</link>
    <pubDate>${item.pubDate || new Date().toUTCString()}</pubDate>
    <description>${item.description || ""}</description>
    ${item.source ? `<source url="https://example.com">${item.source}</source>` : ""}
    ${(item.categories || []).map((category) => `<category>${category}</category>`).join("")}
  </item>`).join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel>${body}</channel></rss>`;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("event icons and the static page", () => {
  it("picks an icon from the title and description, and keeps a chosen emoji", () => {
    assert.equal(iconForEvent({ title: "Baby Storytime", description: "At the library" }).emoji, "📚");
    assert.equal(iconForEvent({ title: "Zoo Lights" }).emoji, "🎄");
    assert.equal(iconForEvent({ title: "Denver Zoo day", description: "See the animals" }).emoji, "🦁");
    assert.equal(iconForEvent({ title: "Sunday brunch" }).emoji, "🥞");
    assert.equal(iconForEvent({ title: "Free day at the museum" }).emoji, "🌳");
    assert.equal(iconForEvent({ title: "Makers market", description: "Bring a craft" }).emoji, "🎨");
    assert.equal(iconForEvent({ title: "Porch wave", description: "Come say hi" }).emoji, "🎉");
    assert.equal(iconForEvent({ title: "Porch wave", icon: "🦁" }).emoji, "🦁");
  });

  it("does not keep the Halloween card and links Events in the header", () => {
    const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const events = readFileSync(new URL("../public/events.html", import.meta.url), "utf8");
    assert.doesNotMatch(home, /Halloween|Oct 31|OCT 31|id="happenings"/);
    assert.match(home, /class="nav-events" href="\/events"/);
    assert.match(home, /See all events/);
    assert.match(events, /class="nav-events" href="\/events"/);
  });
});

describe("Denver event times", () => {
  it("treats a bare timestamp as America/Denver and keeps a zoned timestamp", () => {
    const winter = parseDenverInput("2026-11-04T10:00");
    assert.equal(winter.local, "2026-11-04T10:00");
    assert.equal(winter.utc.toISOString(), "2026-11-04T17:00:00.000Z");
    const summer = parseDenverInput("2026-07-15T10:00");
    assert.equal(summer.utc.toISOString(), "2026-07-15T16:00:00.000Z");
    const zoned = parseDenverInput("2026-11-04T17:00:00Z");
    assert.equal(zoned.local, "2026-11-04T10:00");
    assert.equal(parseDenverInput("2026-03-08T02:30"), null);
    assert.equal(parseDenverInput("next tuesday"), null);
  });
});

describe("news parsing and filters", () => {
  it("reads RSS and Atom, including entities, CDATA, and a Google News source", () => {
    const parsed = parseFeed(`<?xml version="1.0"?><rss><channel>
      <item>
        <title><![CDATA[Denver&#8217;s Hilltop pie swap]]></title>
        <link>https://denverite.com/pie</link>
        <pubDate>Wed, 04 Nov 2026 15:00:00 GMT</pubDate>
        <description><![CDATA[<p>Bring a pie to <b>Cranmer Park</b>.</p>]]></description>
      </item>
    </channel></rss>`);
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].title, /Hilltop pie swap/);
    assert.match(parsed[0].description, /Cranmer Park/);
    assert.doesNotMatch(parsed[0].description, /<p>/);
    assert.equal(parsed[0].published_at, "2026-11-04T15:00:00.000Z");

    const atom = parseFeed(`<?xml version="1.0"?><feed>
      <entry>
        <title>Cranmer Park concert</title>
        <link rel="alternate" href="https://example.com/cranmer"/>
        <published>2026-11-01T15:00:00Z</published>
        <summary>Music at Cranmer Park.</summary>
      </entry>
    </feed>`);
    assert.equal(atom[0].link, "https://example.com/cranmer");
    assert.equal(atom[0].title, "Cranmer Park concert");

    const google = parseFeed(`<?xml version="1.0"?><rss><channel><item>
      <title>Hilltop grocer dies at 79 - CBS News</title>
      <link>https://news.google.com/rss/articles/abc</link>
      <pubDate>Tue, 28 Jul 2026 07:00:00 GMT</pubDate>
      <description>A grocer in Denver's Hilltop.</description>
      <source url="https://www.cbsnews.com">CBS News</source>
    </item></channel></rss>`);
    assert.equal(google[0].source_name, "CBS News");
    assert.equal(titleKey(google[0].title), "hilltop grocer dies at 79");

    const guidOnly = parseFeed(`<rss><channel><item>
      <title>Graland fair</title>
      <guid isPermaLink="true">https://www.9news.com/graland</guid>
      <description>School fair.</description>
    </item></channel></rss>`);
    assert.equal(guidOnly[0].link, "https://www.9news.com/graland");
    const hiddenGuid = parseFeed(`<rss><channel><item>
      <title>Nope</title>
      <guid isPermaLink="false">https://www.9news.com/nope</guid>
    </item></channel></rss>`);
    assert.equal(hiddenGuid.length, 0);
  });

  it("keeps neighborhood stories and drops crime, traffic, and non-Denver Hilltop", () => {
    const cases = [
      ["New playground in Denver's Hilltop", "", "google", "match"],
      ["Hilltop block party", "fun for kids", "google", "drop"],
      ["Hilltop block party", "fun for kids", "denverite", "match"],
      ["Hilltop Mall opens", "Richmond, Virginia", "google", "drop"],
      ["Hilltop festival", "Columbus, Ohio", "google", "drop"],
      ["Motorcyclist killed in crash near Lowry", "", "9news", "drop"],
      ["New mural on Colorado Blvd", "", "google", "match"],
      ["Cherry Creek farmers market returns", "", "google", "match"],
      ["Glendale wine walk", "", "denver7", "match"],
      ["Glendale wine walk", "", "google", "drop"],
      ["Water limits", "Glendale, Arizona", "9news", "drop"],
      ["Princess of Monaco visits Paris", "", "google", "drop"],
      ["Monaco Street project", "Denver", "google", "match"],
      ["East High choir concert", "", "google", "match"],
      ["East High wins the title", "Columbus, Ohio", "google", "drop"],
      ["Hollywood premiere lights up the block", "", "9news", "drop"],
      ["Holly Street fair this Saturday", "", "9news", "match"],
      ["Man arrested near Hale", "", "9news", "drop"],
      ["Hale porch fest", "", "9news", "match"],
      ["Nurse talks cardiac arrest", "Cherry Creek clinic", "denverite", "match"],
      ["Denver council recap", "citywide politics", "denverite", "drop"],
      ["Denver council recap", "citywide politics", "9news", "drop"],
      ["New cafe opens for brunch", "Families welcome", "denverite", "fallback"],
      ["Nuggets win again", "The game went late", "denverite", "drop"],
      ["Neighborhood note", "<p>Meet us in Cherry Creek North</p>", "google", "match"],
      ["Lane closure", "crash on 6th Avenue", "google", "drop"],
    ];
    for (const [title, description, source, action] of cases) {
      const result = classifyItem({ title, description, link: "https://example.com/story", categories: [] }, feed(source));
      assert.equal(result.action, action, `${source}: ${title}`);
    }
    const traffic = classifyItem({
      title: "Slowdown on Colorado Blvd",
      description: "Expect delays.",
      link: "https://example.com/traffic",
      categories: ["traffic"],
    }, feed("9news"));
    assert.equal(traffic.action, "drop");
  });

  it("shows up to six matches and fills with Denverite only when there are fewer than three", () => {
    const now = Date.parse("2026-11-04T18:00:00Z");
    const day = (offset) => new Date(now - offset * 86400000).toISOString();
    const match = (title, offset) => ({
      title, link: `https://example.com/${title}`, source_name: "9NEWS", published_at: day(offset),
      title_key: titleKey(title), neighborhood_match: 1, is_denverite: 0,
    });
    const filler = (title, offset) => ({
      title, link: `https://denverite.com/${title}`, source_name: "Denverite", published_at: day(offset),
      title_key: titleKey(title), neighborhood_match: 0, is_denverite: 1,
    });
    const four = selectNews([
      match("Cranmer Park concert", 1),
      match("Lowry market", 2),
      match("Crestmoor cleanup", 3),
      match("Graland fair", 4),
      filler("Denver council recap", 0),
    ], now);
    assert.deepEqual(four.map((row) => row.title), ["Cranmer Park concert", "Lowry market", "Crestmoor cleanup", "Graland fair"]);

    const filled = selectNews([
      match("Cranmer Park concert", 2),
      filler("Denver council recap", 0),
      filler("A new park plan", 1),
      { ...match("Old Hilltop story", 40), link: "https://news.google.com/rss/articles/old" },
    ], now);
    assert.deepEqual(filled.map((row) => row.title), ["A new park plan", "Cranmer Park concert"]);
    assert.deepEqual(selectNews([
      filler("Election results are in", 0),
      filler("RTD board winners", 1),
    ], now), []);

    const preferDirect = selectNews([
      { ...match("Cranmer Park concert", 1), link: "https://news.google.com/rss/articles/same", source_name: "CBS News" },
      { ...match("Cranmer Park concert", 2), link: "https://www.9news.com/cranmer", source_name: "9NEWS" },
    ], now);
    assert.equal(preferDirect.length, 1);
    assert.equal(preferDirect[0].link, "https://www.9news.com/cranmer");
  });
});

describe("event admin and pages", () => {
  it("requires the export token, upserts on title plus Denver start, and hides past events", async () => {
    const env = envWith(createDb());
    const denied = await worker.fetch(new Request("https://hellohilltop.org/api/admin/events"), env);
    assert.equal(denied.status, 401);
    const wrong = await worker.fetch(new Request("https://hellohilltop.org/api/admin/events", {
      headers: { Authorization: "Bearer nope" },
    }), env);
    assert.equal(wrong.status, 401);

    const created = await postEvent(env, eventBody({ description: "First draft <script>alert(1)</script>" }));
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.created, true);
    assert.equal(createdBody.event.starts_local, "2027-06-15T14:00");
    assert.equal(createdBody.event.timezone, "America/Denver");
    assert.equal(createdBody.event.starts_at, "2027-06-15T20:00:00.000Z");

    const again = await postEvent(env, eventBody({ description: "Bring a pie." }));
    assert.equal(again.status, 200);
    const againBody = await again.json();
    assert.equal(againBody.created, false);
    assert.equal(againBody.event.id, createdBody.event.id);
    assert.equal(againBody.event.description, "Bring a pie.");

    const markup = await postEvent(env, eventBody({
      title: "Markup hang",
      starts_at: "2027-08-01T14:00",
      ends_at: "2027-08-01T15:00",
      description: "Bring a sign <script>alert(1)</script>",
    }));
    assert.equal(markup.status, 201);

    const otherTime = await postEvent(env, eventBody({ starts_at: "2027-06-16T14:00", ends_at: "2027-06-16T15:00", title: "Pie swap" }));
    assert.equal(otherTime.status, 201);

    const past = await postEvent(env, eventBody({
      title: "Old porch hang",
      starts_at: "2020-06-01T10:00",
      ends_at: "2020-06-01T12:00",
    }));
    assert.equal(past.status, 201);

    const noEnd = await postEvent(env, eventBody({
      title: "Morning wave",
      starts_at: "2026-11-04T10:00",
      ends_at: null,
      description: "Wave from the porch.",
    }));
    const noEndBody = await noEnd.json();
    assert.equal(noEndBody.event.visible_until, "2026-11-05T06:59:59.000Z");

    const listed = await worker.fetch(new Request("https://hellohilltop.org/api/admin/events", { headers: authHeaders() }), env);
    const listedBody = await listed.json();
    assert.equal(listedBody.events.some((event) => event.title === "Old porch hang"), false);
    const all = await worker.fetch(new Request("https://hellohilltop.org/api/admin/events?all=1", { headers: authHeaders() }), env);
    const allBody = await all.json();
    assert.equal(allBody.events.some((event) => event.title === "Old porch hang"), true);

    const patched = await postEvent(env, { location: "Cranmer Park, north lawn" }, "PATCH", `/api/admin/events/${createdBody.event.id}`);
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).event.location, "Cranmer Park, north lawn");

    const clash = await postEvent(env, { title: "Pie swap", starts_at: "2027-06-15T14:00" }, "PATCH", `/api/admin/events/${(await otherTime.json()).event.id}`);
    assert.equal(clash.status, 409);

    const bad = await postEvent(env, eventBody({ link: "javascript:alert(1)" }));
    assert.equal(bad.status, 400);
    const backwards = await postEvent(env, eventBody({ ends_at: "2027-06-15T09:00" }));
    assert.equal(backwards.status, 400);

    const home = await worker.fetch(new Request("https://hellohilltop.org/"), env);
    const homeHtml = await home.text();
    assert.equal(home.status, 200);
    assert.match(homeHtml, /Pie swap/);
    assert.match(homeHtml, /Cranmer Park, north lawn/);
    assert.doesNotMatch(homeHtml, /Old porch hang/);
    const eventsPage = await (await worker.fetch(new Request("https://hellohilltop.org/events"), env)).text();
    assert.match(eventsPage, /&lt;script&gt;/);
    assert.equal(home.headers.get("Cache-Control"), "public, max-age=120");
    assert.equal(home.headers.get("X-Content-Type-Options"), "nosniff");

    const removed = await worker.fetch(new Request(`https://hellohilltop.org/api/admin/events/${createdBody.event.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    }), env);
    assert.equal(removed.status, 200);
    const missing = await worker.fetch(new Request(`https://hellohilltop.org/api/admin/events/${createdBody.event.id}`, {
      headers: authHeaders(),
    }), env);
    assert.equal(missing.status, 404);
  });

  it("lists every upcoming event on /events and redirects the html file", async () => {
    const env = envWith(createDb());
    for (let day = 1; day <= 7; day++) {
      const res = await postEvent(env, eventBody({
        title: `Day ${day} hang`,
        starts_at: `2027-07-${String(day).padStart(2, "0")}T10:00`,
        ends_at: `2027-07-${String(day).padStart(2, "0")}T11:00`,
      }));
      assert.equal(res.status, 201);
    }
    const home = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(home, /Day 1 hang/);
    assert.match(home, /Day 2 hang/);
    assert.doesNotMatch(home, /Day 3 hang/);
    const page = await worker.fetch(new Request("https://hellohilltop.org/events"), env);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Day 7 hang/);
    assert.match(pageHtml, /Upcoming events/);
    const slash = await worker.fetch(new Request("https://hellohilltop.org/events/"), env);
    assert.match(await slash.text(), /Day 7 hang/);
    const redirect = await worker.fetch(new Request("https://hellohilltop.org/events.html"), env);
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("Location"), "https://hellohilltop.org/events");
  });

  it("leaves the friendly fallback in place when the tables are missing", async () => {
    const env = envWith({
      prepare() {
        return { bind() { return this; }, async all() { throw new Error("no such table"); }, async first() { throw new Error("no such table"); } };
      },
    });
    const res = await worker.fetch(new Request("https://hellohilltop.org/"), env);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /fallback events/);
    assert.match(html, /fallback news/);
  });
});

describe("news refresh", { concurrency: 1 }, () => {
  it("stores a filtered list, keeps it when feeds fail, and does not fetch while rendering", async () => {
    const env = envWith(createDb());
    let fetches = 0;
    let fail = false;
    globalThis.fetch = async (url) => {
      fetches += 1;
      if (fail) throw new Error("network down");
      const denverite = String(url).includes("denverite.com");
      return new Response(rss([
        { title: "Cranmer Park concert", link: "https://denverite.com/cranmer", description: "SECRET_BODY should stay off the page." },
        { title: "New playground opens for Denver families", link: "https://denverite.com/playground", description: "A park day for kids." },
        { title: "Denver council recap", link: "https://denverite.com/council", description: "A city council vote." },
        { title: "Motorcyclist killed in crash near Lowry", link: "https://denverite.com/crash", description: "A fatal crash." },
      ].map((item) => denverite ? item : { ...item, link: item.link + "-copy" })), { status: 200, headers: { "Content-Type": "application/rss+xml" } });
    };

    const jobs = [];
    const ctx = { waitUntil(promise) { jobs.push(promise); } };
    const first = await worker.fetch(new Request("https://hellohilltop.org/"), env, ctx);
    const firstHtml = await first.text();
    assert.match(firstHtml, /Nothing from the neighborhood in the news just yet/);
    assert.doesNotMatch(firstHtml, /Cranmer Park concert/);
    await Promise.all(jobs);
    assert.ok(fetches >= 5);

    const second = await worker.fetch(new Request("https://hellohilltop.org/"), env, ctx);
    const secondHtml = await second.text();
    assert.match(secondHtml, /Cranmer Park concert/);
    assert.match(secondHtml, /Denverite/);
    assert.match(secondHtml, /New playground opens for Denver families/);
    assert.doesNotMatch(secondHtml, /Denver council recap/);
    assert.doesNotMatch(secondHtml, /SECRET_BODY/);
    assert.doesNotMatch(secondHtml, /killed in crash/);
    const afterRender = fetches;

    const third = await worker.fetch(new Request("https://hellohilltop.org/"), env, ctx);
    await third.text();
    assert.equal(fetches, afterRender);

    fail = true;
    const refresh = await worker.fetch(new Request("https://hellohilltop.org/api/admin/news/refresh", {
      method: "POST",
      headers: authHeaders(),
    }), env);
    const refreshBody = await refresh.json();
    assert.equal(refresh.status, 200);
    assert.equal(refreshBody.ok, false);
    assert.equal(refreshBody.kept_previous, true);
    const still = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(still, /Cranmer Park concert/);

    const noToken = await worker.fetch(new Request("https://hellohilltop.org/api/admin/news/refresh", { method: "POST" }), env);
    assert.equal(noToken.status, 401);
  });

  it("retries a 503 and reads a 9NEWS guid link", async () => {
    const env = envWith(createDb());
    const tries = new Map();
    globalThis.fetch = async (url) => {
      const key = String(url);
      tries.set(key, (tries.get(key) || 0) + 1);
      if (key.includes("news.google.com") && tries.get(key) === 1) return new Response("busy", { status: 503 });
      if (key.includes("9news.com")) {
        return new Response(`<rss><channel><item><title>Graland school fair</title><link></link><guid isPermaLink="true">https://www.9news.com/graland</guid><pubDate>${new Date().toUTCString()}</pubDate><description>Games on the lawn.</description></item></channel></rss>`, { status: 200 });
      }
      return new Response(rss([
        { title: "Neighborhood park concert", link: "https://denverite.com/park-concert", description: "Music in the park." },
      ]), { status: 200 });
    };
    const res = await worker.fetch(new Request("https://hellohilltop.org/api/admin/news/refresh", {
      method: "POST",
      headers: authHeaders(),
    }), env);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.feeds.find((feed) => feed.id === "google").ok, true);
    assert.ok(body.feeds.find((feed) => feed.id === "9news").saved >= 1);
    const page = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(page, /Graland school fair/);
    assert.match(page, /https:\/\/www\.9news\.com\/graland/);
  });

  it("runs from the cron handler and reports a manual refresh", async () => {
    const env = envWith(createDb());
    globalThis.fetch = async (url) => {
      if (String(url).includes("9news.com")) {
        return new Response(rss([
          { title: "Steck Elementary carnival", link: "https://www.9news.com/steck", description: "Games on the lawn." },
        ]), { status: 200 });
      }
      return new Response(rss([
        { title: "Denver council recap", link: `https://denverite.com/council-${String(url).length}`, description: "Citywide politics." },
      ]), { status: 200 });
    };
    await worker.scheduled({ cron: "0 */4 * * *" }, env, { waitUntil(promise) { return promise; } });
    const manual = await worker.fetch(new Request("https://hellohilltop.org/api/admin/news/refresh", {
      method: "POST",
      headers: authHeaders(),
    }), env);
    const body = await manual.json();
    assert.equal(body.ok, true);
    assert.equal(body.kept_previous, false);
    assert.ok(body.feeds.some((feed) => feed.id === "9news" && feed.ok && feed.saved >= 1));
    const page = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(page, /Steck Elementary carnival/);
    assert.match(page, /9NEWS/);
  });
});
