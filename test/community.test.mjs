import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CATEGORIES } from "../src/directory.js";
import worker from "../src/worker.js";

const migration = ["0001_hood.sql", "0002_event_icon.sql", "0003_instagram.sql", "0004_support_settings.sql", "0005_directory.sql", "0006_event_proposals.sql", "0007_neighbor_updates.sql"]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const originalFetch = globalThis.fetch;
const siteverifyCalls = [];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  siteverifyCalls.length = 0;
  globalThis.fetch = async (url, init) => {
    const params = new URLSearchParams(init?.body || "");
    siteverifyCalls.push({ url: String(url), token: params.get("response") });
    const outcomes = {
      "good-directory": { success: true, action: "directory", hostname: "hellohilltop.org" },
      "good-removal": { success: true, action: "removal", hostname: "hellohilltop.org" },
      "good-host": { success: true, action: "host", hostname: "hellohilltop.org" },
    };
    return jsonResponse(outcomes[params.get("response")] || { success: false, "error-codes": ["invalid-input-response"] });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createDb(sql = migration) {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  function statement(query) {
    const stmt = {
      _args: [],
      bind(...args) {
        stmt._args = args;
        return stmt;
      },
      async run() {
        const prepared = db.prepare(query);
        const info = stmt._args.length ? prepared.run(...stmt._args) : prepared.run();
        return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
      },
      async all() {
        const prepared = db.prepare(query);
        const results = stmt._args.length ? prepared.all(...stmt._args) : prepared.all();
        return { results };
      },
      async first() {
        const prepared = db.prepare(query);
        const row = stmt._args.length ? prepared.get(...stmt._args) : prepared.get();
        return row ?? null;
      },
    };
    return stmt;
  }
  return {
    db,
    DB: {
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
    },
  };
}

function envWith(db, extra = {}) {
  return {
    EXPORT_TOKEN: "export-secret",
    TURNSTILE_SECRET: "test-secret",
    DB: db,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const name = path === "/" ? "/index.html" : path;
        try {
          const body = readFileSync(new URL(`../public${name}`, import.meta.url));
          return new Response(body, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
        } catch {
          return new Response("missing", { status: 404, headers: { "Content-Type": "text/plain" } });
        }
      },
    },
    ...extra,
  };
}

function auth(extra = {}) {
  return { Authorization: "Bearer export-secret", ...extra };
}

function postJson(path, body, token = "good-directory") {
  return new Request(`https://hellohilltop.org${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.8" },
    body: JSON.stringify({ ...body, "cf-turnstile-response": body["cf-turnstile-response"] ?? token }),
  });
}

async function admin(env, path, { method = "GET", body } = {}) {
  return worker.fetch(new Request(`https://hellohilltop.org${path}`, {
    method,
    headers: auth(body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }), env);
}

const listing = (overrides = {}) => ({
  category: "babysitter",
  title: "Ada's evening sitting",
  description: "Weeknight sitting for Hilltop families. Seoul snacks on request.",
  contact: "Text 303-555-0100",
  contact_url: "https://ada.example/sitting",
  name: "Ada",
  email: "ada-private@hill.test",
  consent: "1",
  ...overrides,
});

const proposal = (overrides = {}) => ({
  title: "Porch concert",
  starts_at: "2027-06-15T14:00",
  ends_at: "2027-06-15T16:00",
  location: "Cranmer Park",
  description: "Bring a blanket. <script>alert(1)</script>",
  link: "https://hellohilltop.org/events",
  name: "Ada Lovelace",
  email: "host-secret-9f3a@hill.test",
  kid_friendly: "1",
  dog_friendly: true,
  ...overrides,
});

describe("pages and payment links", () => {
  it("puts Donate in the header, states the honest prices, and keeps the preview database", () => {
    const pages = ["index.html", "events.html", "support.html", "directory.html", "host.html", "updates.html", "404.html"];
    for (const name of pages) {
      const html = readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
      assert.match(html, /class="nav-donate" href="\/support"/, name);
      assert.match(html, /Skip to content/, name);
    }
    const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    const support = readFileSync(new URL("../public/support.html", import.meta.url), "utf8");
    const directory = readFileSync(new URL("../public/directory.html", import.meta.url), "utf8");
    const host = readFileSync(new URL("../public/host.html", import.meta.url), "utf8");
    assert.match(home, /\$50<small>\/yr/);
    assert.match(home, /\$100<small>\/yr/);
    assert.doesNotMatch(home, /\$40/);
    assert.match(home, /href="\/host"/);
    assert.match(support, /not a 501\(c\)\(3\)/i);
    assert.match(support, /not tax-deductible/i);
    assert.match(support, /Where the money goes/);
    assert.match(support, /\$50/);
    assert.match(support, /\$100/);
    assert.match(support, /\$250/);
    assert.match(support, /Any amount/);
    assert.doesNotMatch(support, /pay-link|cardnumber|name="card"|name="cvc"|js\.stripe\.com/i);
    assert.match(directory, /members-only/i);
    assert.match(directory, /name="consent"/);
    assert.match(host, /permit/i);
    assert.match(host, /never shown/i);
    for (const [id, label] of CATEGORIES) {
      assert.match(directory, new RegExp(`value="${id}"[^>]*>${label}`));
    }
    const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    assert.match(wrangler, /hello-hilltop-preview/);
    assert.match(wrangler, /71ea0d4e-8ccd-464c-9946-9545b3def471/);
    const news = readFileSync(new URL("../src/news.js", import.meta.url), "utf8");
    assert.doesNotMatch(news, /neighbor_updates/);
  });

  it("shows a coming-soon support page until a real checkout link is configured", async () => {
    const { DB } = createDb();
    const env = envWith(DB, { SUPPORT_CHECKOUT_URL: "javascript:alert(1)", SUPPORT_VENMO_URL: "not a url" });
    const html = await (await worker.fetch(new Request("https://hellohilltop.org/support"), env)).text();
    assert.match(html, /Payments aren't open yet/);
    assert.match(html, /Join the email list/);
    assert.match(html, /not tax-deductible/i);
    assert.doesNotMatch(html, /pay-link|javascript:|buy\.stripe\.com/);
    assert.doesNotMatch(html, /<input[^>]*name="(card|cc|cvc|cvv|pan)"/i);
    const donate = await worker.fetch(new Request("https://hellohilltop.org/donate"), env);
    assert.equal(donate.status, 301);
    assert.equal(donate.headers.get("Location"), "https://hellohilltop.org/support");
  });

  it("uses an admin payment link, then an env fallback, and never a broken button", async () => {
    const { DB } = createDb();
    const env = envWith(DB, { SUPPORT_CHECKOUT_URL: "https://buy.stripe.com/test_checkout" });
    const denied = await worker.fetch(new Request("https://hellohilltop.org/api/admin/support"), env);
    assert.equal(denied.status, 401);

    const fromEnv = await (await worker.fetch(new Request("https://hellohilltop.org/support"), env)).text();
    assert.match(fromEnv, /https:\/\/buy\.stripe\.com\/test_checkout/);
    assert.match(fromEnv, /pay-link/);
    assert.match(fromEnv, /never sees or stores your card number/);
    assert.doesNotMatch(fromEnv, /Payments aren't open yet/);
    const links = fromEnv.match(/class="btn[^"]*pay-link"/g) || [];
    assert.equal(links.length, 4);

    const bad = await admin(env, "/api/admin/support", { method: "PUT", body: { venmo_url: "javascript:alert(1)" } });
    assert.equal(bad.status, 400);
    const set = await admin(env, "/api/admin/support", {
      method: "PUT",
      body: {
        checkout_go_getter_url: "https://buy.stripe.com/go_getter",
        venmo_url: "venmo.com/u/hellohilltop",
        paypal_url: "",
      },
    });
    assert.equal(set.status, 200);
    const setBody = await set.json();
    assert.equal(setBody.links.checkout_go_getter_url.source, "admin");
    assert.equal(setBody.links.venmo_url.url, "https://venmo.com/u/hellohilltop");
    assert.equal(setBody.links.checkout_url.source, "env");
    const html = await (await worker.fetch(new Request("https://hellohilltop.org/support"), env)).text();
    assert.match(html, /https:\/\/buy\.stripe\.com\/go_getter/);
    assert.match(html, /https:\/\/venmo\.com\/u\/hellohilltop/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.doesNotMatch(html, /<form/);

    const cleared = await admin(env, "/api/admin/support", { method: "PUT", body: { checkout_go_getter_url: "" } });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).links.checkout_go_getter_url.source, "unset");
    const afterClear = await (await worker.fetch(new Request("https://hellohilltop.org/support"), env)).text();
    assert.match(afterClear, /https:\/\/buy\.stripe\.com\/test_checkout/);
    assert.doesNotMatch(afterClear, /go_getter/);
  });
});

describe("neighbor directory", () => {
  it("keeps submissions pending, hides the private email, and moderates them", async () => {
    const { DB } = createDb();
    const env = envWith(DB);
    const denied = await worker.fetch(new Request("https://hellohilltop.org/api/admin/directory"), env);
    assert.equal(denied.status, 401);

    const missingConsent = await worker.fetch(postJson("/api/directory", listing({ consent: "" })), env);
    assert.equal(missingConsent.status, 400);
    assert.equal(siteverifyCalls.length, 0);

    const spam = await worker.fetch(postJson("/api/directory", listing({ description: "Guaranteed SEO rankings at https://spam.example" })), env);
    assert.equal(spam.status, 400);
    assert.equal(siteverifyCalls.length, 0);

    const badSite = await worker.fetch(postJson("/api/directory", listing({ contact_url: "javascript:alert(1)" })), env);
    assert.equal(badSite.status, 400);

    const honeypot = await worker.fetch(postJson("/api/directory", listing({ website: "https://spam.example" })), env);
    assert.equal((await honeypot.json()).ok, true);
    assert.equal(siteverifyCalls.length, 0);

    const created = await worker.fetch(postJson("/api/directory", listing({
      title: 'Ada <script>alert(1)</script>',
    })), env);
    assert.equal(created.status, 200);
    assert.match((await created.json()).message, /look it over/);
    assert.equal(siteverifyCalls[0].token, "good-directory");

    const pendingPage = await (await worker.fetch(new Request("https://hellohilltop.org/directory"), env)).text();
    assert.match(pendingPage, /No listings yet/);
    assert.doesNotMatch(pendingPage, /ada-private@hill\.test|alert\(1\)/);

    const queued = await admin(env, "/api/admin/directory");
    const queuedBody = await queued.json();
    assert.equal(queuedBody.listings.length, 1);
    assert.equal(queuedBody.listings[0].status, "pending");
    assert.equal(queuedBody.listings[0].submitter_email, "ada-private@hill.test");
    const id = queuedBody.listings[0].id;

    const edited = await admin(env, `/api/admin/directory/${id}`, {
      method: "PATCH",
      body: { contact: "Text 303-555-0199" },
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).listing.contact, "Text 303-555-0199");

    const approved = await admin(env, `/api/admin/directory/${id}/approve`, { method: "POST" });
    assert.equal(approved.status, 200);
    const page = await (await worker.fetch(new Request("https://hellohilltop.org/directory"), env)).text();
    assert.match(page, /Babysitters/);
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(page, /303-555-0199/);
    assert.match(page, /https:\/\/ada\.example\/sitting/);
    assert.doesNotMatch(page, /<script>alert\(1\)<\/script>|ada-private@hill\.test/);

    const removal = await worker.fetch(postJson("/api/directory/removal", {
      listing: `listing-${id}`,
      email: "takedown-private@hill.test",
      note: "Please remove this one.",
      confirm: "1",
    }, "good-removal"), env);
    assert.equal(removal.status, 200);
    const removals = await (await admin(env, "/api/admin/directory/removals")).json();
    assert.equal(removals.removals[0].email, "takedown-private@hill.test");
    assert.equal(removals.removals[0].listing_id, id);
    const stillPublic = await (await worker.fetch(new Request("https://hellohilltop.org/directory"), env)).text();
    assert.doesNotMatch(stillPublic, /takedown-private@hill\.test/);

    const done = await admin(env, `/api/admin/directory/removals/${removals.removals[0].id}/done`, { method: "POST" });
    assert.equal(done.status, 200);
    const rejected = await admin(env, `/api/admin/directory/${id}/reject`, { method: "POST" });
    assert.equal(rejected.status, 200);
    const hidden = await (await worker.fetch(new Request("https://hellohilltop.org/directory"), env)).text();
    assert.match(hidden, /No listings yet/);

    const removed = await admin(env, `/api/admin/directory/${id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.equal((await (await admin(env, "/api/admin/directory?status=all")).json()).listings.length, 0);
  });

  it("slows a burst of listings from the same email", async () => {
    const { DB } = createDb();
    const env = envWith(DB);
    for (let i = 0; i < 6; i++) {
      const res = await worker.fetch(postJson("/api/directory", listing({ title: `Sitter ${i} extra` })), env);
      assert.equal(res.status, 200, String(i));
    }
    const blocked = await worker.fetch(postJson("/api/directory", listing({ title: "One more sitter" })), env);
    assert.equal(blocked.status, 429);
  });

  it("answers kindly when the directory migration is missing", async () => {
    const { DB } = createDb(readFileSync(new URL("../migrations/0001_hood.sql", import.meta.url), "utf8"));
    const env = envWith(DB);
    const res = await worker.fetch(postJson("/api/directory", listing()), env);
    assert.equal(res.status, 503);
    const page = await worker.fetch(new Request("https://hellohilltop.org/directory"), env);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /No listings yet/);
  });
});

describe("host an event", () => {
  it("publishes a proposal through the events table without the organizer email", async () => {
    const { DB } = createDb();
    const env = envWith(DB);
    assert.equal((await worker.fetch(new Request("https://hellohilltop.org/api/admin/event-proposals"), env)).status, 401);

    const past = await worker.fetch(postJson("/api/events/host", proposal({ starts_at: "2020-06-01T10:00", ends_at: "2020-06-01T12:00" }), "good-host"), env);
    assert.equal(past.status, 400);
    assert.match((await past.json()).message, /already passed/);

    const leaked = await worker.fetch(postJson("/api/events/host", proposal({ description: "Email me at host-secret-9f3a@hill.test" }), "good-host"), env);
    assert.equal(leaked.status, 400);

    const honeypot = await worker.fetch(postJson("/api/events/host", proposal({ website: "http://spam.test" }), "good-host"), env);
    assert.equal((await honeypot.json()).ok, true);
    assert.equal(siteverifyCalls.length, 0);

    const created = await worker.fetch(postJson("/api/events/host", proposal(), "good-host"), env);
    assert.equal(created.status, 200);
    const before = await (await worker.fetch(new Request("https://hellohilltop.org/events"), env)).text();
    assert.doesNotMatch(before, /Porch concert|host-secret-9f3a@hill\.test/);

    const queued = await (await admin(env, "/api/admin/event-proposals")).json();
    assert.equal(queued.proposals.length, 1);
    assert.equal(queued.proposals[0].organizer_email, "host-secret-9f3a@hill.test");
    const id = queued.proposals[0].id;

    const edited = await admin(env, `/api/admin/event-proposals/${id}`, {
      method: "PATCH",
      body: { location: "Cranmer Park, north lawn" },
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).proposal.location, "Cranmer Park, north lawn");

    const rejected = await admin(env, `/api/admin/event-proposals/${id}/reject`, { method: "POST" });
    assert.equal(rejected.status, 200);
    assert.doesNotMatch(await (await worker.fetch(new Request("https://hellohilltop.org/events"), env)).text(), /Porch concert/);

    await admin(env, `/api/admin/event-proposals/${id}`, { method: "DELETE" });
    const again = await worker.fetch(postJson("/api/events/host", proposal(), "good-host"), env);
    assert.equal(again.status, 200);
    const nextId = (await (await admin(env, "/api/admin/event-proposals")).json()).proposals[0].id;
    const approved = await admin(env, `/api/admin/event-proposals/${nextId}/approve`, { method: "POST" });
    assert.equal(approved.status, 200);
    const approvedBody = await approved.json();
    assert.equal(approvedBody.created, true);
    assert.equal(approvedBody.event.source_name, "Ada Lovelace");
    assert.equal(approvedBody.event.location, "Cranmer Park");
    assert.match(approvedBody.event.description, /Kid friendly/);
    assert.match(approvedBody.event.description, /Dogs welcome/);
    assert.equal(JSON.stringify(approvedBody.event).includes("host-secret-9f3a@hill.test"), false);

    const page = await (await worker.fetch(new Request("https://hellohilltop.org/events"), env)).text();
    assert.match(page, /Porch concert/);
    assert.match(page, /&lt;script&gt;/);
    assert.match(page, /Via Ada Lovelace/);
    assert.doesNotMatch(page, /host-secret-9f3a@hill\.test|<script>alert\(1\)<\/script>/);
    const home = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.doesNotMatch(home, /host-secret-9f3a@hill\.test/);

    const second = await admin(env, `/api/admin/event-proposals/${nextId}/approve`, { method: "POST" });
    assert.equal((await second.json()).already, true);
    const events = await (await admin(env, "/api/admin/events?all=1")).json();
    assert.equal(events.events.filter((event) => event.title === "Porch concert").length, 1);
    const eventJson = JSON.stringify(events.events);
    assert.equal(eventJson.includes("host-secret-9f3a@hill.test"), false);
  });
});

describe("neighbor notes", () => {
  it("shows current notes, hides expired ones, and survives a news refresh", async () => {
    const { db, DB } = createDb();
    const env = envWith(DB);
    assert.equal((await worker.fetch(new Request("https://hellohilltop.org/api/admin/updates"), env)).status, 401);

    const badLink = await admin(env, "/api/admin/updates", { method: "POST", body: { title: "Nope", summary: "A note", source_name: "Hello! Hilltop", link: "javascript:alert(1)" } });
    assert.equal(badLink.status, 400);

    const kept = await admin(env, "/api/admin/updates", {
      method: "POST",
      body: { title: "Porch light reminder <script>", summary: "Leave a light on for the block walk.", source_name: "Hello! Hilltop", link: "https://hellohilltop.org/#hood" },
    });
    assert.equal(kept.status, 201);
    const expired = await admin(env, "/api/admin/updates", {
      method: "POST",
      body: { title: "Old snow note", summary: "This one is over.", source_name: "Hello! Hilltop", expires_at: "2020-01-01" },
    });
    assert.equal(expired.status, 201);
    const future = await admin(env, "/api/admin/updates", {
      method: "POST",
      body: { title: "Spring bulb share", summary: "Extra daffodils on the corner.", source_name: "Hello! Hilltop", expires_at: "2099-05-01" },
    });
    assert.equal(future.status, 201);
    const futureBody = await future.json();

    const page = await (await worker.fetch(new Request("https://hellohilltop.org/updates"), env)).text();
    assert.match(page, /Porch light reminder/);
    assert.match(page, /&lt;script&gt;/);
    assert.match(page, /Spring bulb share/);
    assert.match(page, /https:\/\/hellohilltop\.org\/#hood/);
    assert.doesNotMatch(page, /Old snow note|<script>/);
    const home = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(home, /Porch light reminder/);
    assert.doesNotMatch(home, /Old snow note/);

    const listed = await (await admin(env, "/api/admin/updates")).json();
    assert.equal(listed.updates.find((row) => row.title === "Old snow note").expired, true);
    assert.equal(listed.updates.find((row) => row.title === "Spring bulb share").expired, false);

    const edited = await admin(env, `/api/admin/updates/${futureBody.update.id}`, {
      method: "PATCH",
      body: { summary: "Extra tulips, actually." },
    });
    assert.match((await edited.json()).update.summary, /tulips/);
    assert.match(await (await worker.fetch(new Request("https://hellohilltop.org/updates"), env)).text(), /tulips/);

    db.exec(`INSERT INTO news_items (title, link, source_name, published_at, feed_id, title_key, neighborhood_match, is_denverite, fetched_at)
      VALUES ('OLD NEWS TITLE', 'https://example.com/old-news', 'Denverite', '2026-11-01T00:00:00.000Z', 'denverite', 'old news title', 1, 1, '2026-11-01T00:00:00.000Z')`);
    globalThis.fetch = async () => new Response(`<?xml version="1.0"?><rss><channel><item>
      <title>Cranmer Park concert this weekend</title>
      <link>https://denverite.com/cranmer-concert</link>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <description>Music at Cranmer Park in Denver.</description>
    </item></channel></rss>`, { status: 200, headers: { "Content-Type": "application/rss+xml" } });
    const refreshed = await admin(env, "/api/admin/news/refresh", { method: "POST" });
    assert.equal(refreshed.status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM neighbor_updates").get().n, 3);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM news_items WHERE title = 'OLD NEWS TITLE'").get().n, 0);
    const after = await (await worker.fetch(new Request("https://hellohilltop.org/"), env)).text();
    assert.match(after, /Porch light reminder/);
    assert.match(after, /Spring bulb share/);

    const removed = await admin(env, `/api/admin/updates/${futureBody.update.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.doesNotMatch(await (await worker.fetch(new Request("https://hellohilltop.org/updates"), env)).text(), /Spring bulb share/);
  });
});
