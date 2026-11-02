import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import worker from "../src/worker.js";

const originalFetch = globalThis.fetch;
const siteverifyCalls = [];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  siteverifyCalls.length = 0;
  globalThis.fetch = async (url, init) => {
    const params = new URLSearchParams(init.body);
    siteverifyCalls.push({
      url: String(url),
      secret: params.get("secret"),
      token: params.get("response"),
      remoteip: params.get("remoteip"),
      contentType: init.headers["Content-Type"] || init.headers.get?.("Content-Type"),
    });
    if (params.get("secret") !== "test-secret") {
      return jsonResponse({ success: false, "error-codes": ["invalid-input-secret"] });
    }
    const token = params.get("response");
    if (token === "throw") throw new Error("network down");
    if (token === "http500") return new Response("nope", { status: 500 });
    if (token === "not-json") return new Response("not json", { status: 200 });
    const outcomes = {
      "good-signup": { success: true, action: "signup", hostname: "hellohilltop.org" },
      "good-ideas": { success: true, action: "ideas", hostname: "HelloHilltop.org" },
      "wrong-action": { success: true, action: "signup", hostname: "hellohilltop.org" },
      "wrong-host": { success: true, action: "ideas", hostname: "evil.example" },
      bad: { success: false, "error-codes": ["invalid-input-response"] },
    };
    return jsonResponse(outcomes[token] || { success: false, "error-codes": ["invalid-input-response"] });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
});

function mockEnv(overrides = {}) {
  const inserts = [];
  const env = {
    TURNSTILE_SECRET: "test-secret",
    EXPORT_TOKEN: "export-secret",
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async run() {
                inserts.push({ sql, args });
                return { success: true };
              },
            };
          },
          async all() {
            return { results: [{ id: 1, email: "a@b.co" }] };
          },
        };
      },
    },
    ASSETS: {
      async fetch() {
        return new Response("<html>ok</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      },
    },
    ...overrides,
  };
  return { env, inserts };
}

function postJson(path, body, ip = "203.0.113.8") {
  return new Request(`https://hellohilltop.org${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

function postForm(path, fields, ip = "203.0.113.8") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return new Request(`https://hellohilltop.org${path}`, {
    method: "POST",
    headers: { "CF-Connecting-IP": ip },
    body: fd,
  });
}

describe("signup", () => {
  it("saves a verified neighbor and sends the visitor IP to siteverify", async () => {
    const { env, inserts } = mockEnv();
    const res = await worker.fetch(postJson("/api/signup", {
      name: "Ada",
      email: "Ada@Hill.test",
      volunteer: "1",
      source: "site",
      "cf-turnstile-response": "good-signup",
    }), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.match(body.message, /Hello, neighbor/);
    assert.equal(inserts.length, 1);
    assert.deepEqual(inserts[0].args, ["Ada", "ada@hill.test", 1, "site"]);
    assert.equal(siteverifyCalls.length, 1);
    assert.equal(siteverifyCalls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(siteverifyCalls[0].secret, "test-secret");
    assert.equal(siteverifyCalls[0].token, "good-signup");
    assert.equal(siteverifyCalls[0].remoteip, "203.0.113.8");
    assert.equal(siteverifyCalls[0].contentType, "application/x-www-form-urlencoded");
  });

  it("accepts a normal form post the same way", async () => {
    const { env, inserts } = mockEnv();
    const res = await worker.fetch(postForm("/api/signup", {
      email: "neighbor@hill.test",
      "cf-turnstile-response": "good-signup",
    }), env);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/?thanks=signup#signup");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].args[1], "neighbor@hill.test");
  });

  it("drops honeypot submissions without saving or calling siteverify", async () => {
    const { env, inserts } = mockEnv();
    const res = await worker.fetch(postJson("/api/signup", {
      email: "bot@spam.test",
      website: "https://spam.example",
      "cf-turnstile-response": "good-signup",
    }), env);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(inserts.length, 0);
    assert.equal(siteverifyCalls.length, 0);
  });

  it("rejects a missing, invalid, mismatched, or unverifiable token", async () => {
    const cases = [
      [{ email: "a@b.co" }, 403],
      [{ email: "a@b.co", "cf-turnstile-response": "" }, 403],
      [{ email: "a@b.co", "cf-turnstile-response": "x".repeat(2049) }, 403],
      [{ email: "a@b.co", "cf-turnstile-response": "bad" }, 403],
      [{ email: "a@b.co", "cf-turnstile-response": "wrong-host" }, 403],
      [{ email: "a@b.co", "cf-turnstile-response": "throw" }, 403],
      [{ email: "a@b.co", "cf-turnstile-response": "http500" }, 403],
      [{ email: "a@b.co", "cf-turnstile-response": "not-json" }, 403],
    ];
    for (const [payload, status] of cases) {
      const { env, inserts } = mockEnv();
      const res = await worker.fetch(postJson("/api/signup", payload), env);
      const body = await res.json();
      assert.equal(res.status, status, JSON.stringify(payload));
      assert.equal(body.ok, false);
      assert.match(body.message, /not a robot/);
      assert.equal(inserts.length, 0);
    }
  });

  it("fails closed when the secret is missing and does not call siteverify", async () => {
    const { env, inserts } = mockEnv({ TURNSTILE_SECRET: undefined });
    const res = await worker.fetch(postJson("/api/signup", {
      email: "a@b.co",
      "cf-turnstile-response": "good-signup",
    }), env);
    assert.equal(res.status, 403);
    assert.equal(inserts.length, 0);
    assert.equal(siteverifyCalls.length, 0);
  });

  it("still checks the email before the security check", async () => {
    const { env, inserts } = mockEnv();
    const res = await worker.fetch(postJson("/api/signup", {
      email: "not-an-email",
      "cf-turnstile-response": "good-signup",
    }), env);
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.match(body.message, /valid email/);
    assert.equal(inserts.length, 0);
    assert.equal(siteverifyCalls.length, 0);
  });
});

describe("ideas", () => {
  it("saves a neighbor idea after Turnstile", async () => {
    const { env, inserts } = mockEnv();
    const res = await worker.fetch(postJson("/api/ideas", {
      name: "Sam",
      idea: "A Seoul fried chicken pop-up, then a season of porch concerts.",
      would_help: true,
      "cf-turnstile-response": "good-ideas",
    }), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.match(body.message, /Every idea gets read/);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].args[0], "Sam");
    assert.equal(inserts[0].args[1], null);
    assert.match(inserts[0].args[2], /porch concerts/);
    assert.equal(inserts[0].args[3], 1);
    assert.equal(siteverifyCalls[0].remoteip, "203.0.113.8");
  });

  it("silently drops a filled honeypot", async () => {
    const { env, inserts } = mockEnv();
    const res = await worker.fetch(postForm("/api/ideas", {
      idea: "Buy cheap SEO",
      website: "http://spam.test",
      "cf-turnstile-response": "good-ideas",
    }), env);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/?thanks=ideas#ideas");
    assert.equal(inserts.length, 0);
    assert.equal(siteverifyCalls.length, 0);
  });

  it("rejects links and SEO pitches without saving", async () => {
    const spam = [
      "We do SEO for local businesses",
      "Guaranteed search engine placement",
      "search-engine rankings for hire",
      "Improve your ranking on Google",
      "Let us index your site today",
      "We handle indexing your website",
      "Quality backlinks for sale",
      "packages of back-links",
      "Add your site to the Google index",
      "Visit https://spam.example/offer",
      "See www.best-offer.io",
      "details at best-offer.com",
      "s\u200beo services for your block",
    ];
    for (const idea of spam) {
      const { env, inserts } = mockEnv();
      const res = await worker.fetch(postJson("/api/ideas", {
        idea,
        "cf-turnstile-response": "good-ideas",
      }), env);
      const body = await res.json();
      assert.equal(res.status, 400, idea);
      assert.equal(body.ok, false);
      assert.match(body.message, /sales pitch/);
      assert.equal(inserts.length, 0);
      assert.equal(siteverifyCalls.length, 0, idea);
    }
  });

  it("keeps ordinary neighbor notes, including words that merely contain seo", async () => {
    const ok = [
      "Cookie swap at Robinson Park",
      "A book club for grandparents and kids",
      "Those options for a chili cook-off sound fun",
      "Frank's taco night on the 3rd block",
      "Seoul snacks and a season of dance parties",
    ];
    for (const idea of ok) {
      const { env, inserts } = mockEnv();
      const res = await worker.fetch(postJson("/api/ideas", {
        idea,
        "cf-turnstile-response": "good-ideas",
      }), env);
      assert.equal(res.status, 200, idea);
      assert.equal(inserts.length, 1, idea);
    }
  });

  it("rejects a token minted for the other form", async () => {
    const { env, inserts } = mockEnv();
    const res = await worker.fetch(postJson("/api/ideas", {
      idea: "A pie walk around the park",
      "cf-turnstile-response": "wrong-action",
    }), env);
    assert.equal(res.status, 403);
    assert.equal(inserts.length, 0);
  });

  it("sends a form-post failure back to the idea box", async () => {
    const { env, inserts } = mockEnv();
    const res = await worker.fetch(postForm("/api/ideas", {
      idea: "A pie walk around the park",
      "cf-turnstile-response": "bad",
    }), env);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("Location"), "/?error=ideas#ideas");
    assert.equal(inserts.length, 0);
  });
});

describe("export and the rest of the worker", () => {
  it("still requires the export token and does not run Turnstile", async () => {
    const { env } = mockEnv();
    const denied = await worker.fetch(new Request("https://hellohilltop.org/api/export?list=signups"), env);
    assert.equal(denied.status, 401);
    const csv = await worker.fetch(new Request("https://hellohilltop.org/api/export?list=ideas", {
      headers: { Authorization: "Bearer export-secret" },
    }), env);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("Content-Type"), /text\/csv/);
    assert.match(await csv.text(), /email/);
    const asJson = await worker.fetch(new Request("https://hellohilltop.org/api/export?list=signups&format=json", {
      headers: { Authorization: "Bearer export-secret" },
    }), env);
    const body = await asJson.json();
    assert.equal(body.ok, true);
    assert.equal(body.list, "signups");
    assert.equal(body.count, 1);
    const badList = await worker.fetch(new Request("https://hellohilltop.org/api/export?list=nope", {
      headers: { Authorization: "Bearer export-secret" },
    }), env);
    assert.equal(badList.status, 400);
    assert.equal(siteverifyCalls.length, 0);
  });

  it("keeps the www redirect, health check, and static assets", async () => {
    const { env } = mockEnv();
    const redirected = await worker.fetch(new Request("https://www.hellohilltop.org/ideas"), env);
    assert.equal(redirected.status, 301);
    assert.equal(redirected.headers.get("Location"), "https://hellohilltop.org/ideas");
    const health = await worker.fetch(new Request("https://hellohilltop.org/api/health"), env);
    assert.equal((await health.json()).ok, true);
    const page = await worker.fetch(new Request("https://hellohilltop.org/"), env);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(page.headers.get("Content-Security-Policy"), null);
    const missing = await worker.fetch(new Request("https://hellohilltop.org/api/nope"), env);
    assert.equal(missing.status, 404);
    assert.equal(siteverifyCalls.length, 0);
  });
});
