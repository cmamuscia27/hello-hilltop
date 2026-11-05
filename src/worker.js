// Hello! Hilltop Worker
// Serves the static site (ASSETS binding) and handles two forms backed by D1
// (DB binding). Signup and idea lists are only readable via /api/export with
// the EXPORT_TOKEN secret. The same token manages neighborhood events, a
// manual news refresh, and the Instagram cache. The homepage reads events,
// headlines, and cached Instagram posts from D1. A cron (and the refresh
// endpoints) fetches the RSS feeds and, when configured, the official
// Instagram API.

import { adminEvents } from "./events.js";
import { adminInstagram, refreshInstagram } from "./instagram.js";
import { refreshNews } from "./news.js";
import { hoodHtml } from "./page.js";

const APEX = "hellohilltop.org";
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

// No Content-Security-Policy header is set. Turnstile loads from
// https://challenges.cloudflare.com (script-src and frame-src). If a CSP is
// added later, those directives must allow that host.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
};

function withHeaders(res, extra = {}) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) r.headers.set(k, v);
  return r;
}

function json(data, status = 200) {
  return withHeaders(
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    })
  );
}

const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const truthy = (v) => v === true || v === "on" || v === "1" || v === "true" || v === "yes";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_HOSTS = new Set(["hellohilltop.org"]);
const TURNSTILE_MSG = "We couldn't confirm you're a neighbor (and not a robot). Please try again.";
const SPAM_MSG = "That looks like a link or a sales pitch. The Idea Box is for neighbor ideas, so we couldn't save it.";

// Whole words for the short spam terms so "Seoul" or "season" still get through.
// Links are rejected on purpose: the Idea Box is for neighbor ideas, not pitches.
const IDEA_SPAM_RE =
  /https?:\/\/|www\.|\b[\w-]+\.(?:com|net|org|info|biz|io|xyz|co|us|link|click|site|online)\b|\bseo\b|search[ -]?engines?|\brankings?\b|index(?:ing)? your (?:site|website|page|url)|\bback-?links?\b|google index/i;

function ideaLooksLikeSpam(idea) {
  const text = idea.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/g, "");
  return IDEA_SPAM_RE.test(text);
}

async function verifyTurnstile(request, env, token, action) {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) return false;
  if (typeof env.TURNSTILE_SECRET !== "string" || env.TURNSTILE_SECRET.length === 0) {
    console.error("TURNSTILE_SECRET is not set");
    return false;
  }
  const remoteip = request.headers.get("CF-Connecting-IP") || "";
  let result;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip,
      }),
    });
    if (!response.ok) throw new Error(`siteverify ${response.status}`);
    result = await response.json();
  } catch (err) {
    console.error("Turnstile siteverify failed", err && err.name);
    return false;
  }
  if (!result || typeof result !== "object") return false;
  const hostname = typeof result.hostname === "string" ? result.hostname.toLowerCase() : "";
  if (result.success !== true || result.action !== action || !TURNSTILE_HOSTS.has(hostname)) {
    const codes = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
    console.error("Turnstile rejected", codes);
    return false;
  }
  return true;
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try { return { data: await request.json(), isForm: false }; } catch { return { data: {}, isForm: false }; }
  }
  const fd = await request.formData();
  const data = {};
  for (const [k, v] of fd.entries()) data[k] = typeof v === "string" ? v : "";
  return { data, isForm: true };
}

// Non-JS form posts get a redirect back to the right section with a flag.
function respond(isForm, ok, anchor, message, status = 200) {
  if (isForm) {
    const url = `/?${ok ? "thanks" : "error"}=${anchor}#${anchor}`;
    return withHeaders(new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } }));
  }
  return json({ ok, message }, ok ? 200 : status);
}

async function handleSignup(request, env) {
  const { data, isForm } = await readBody(request);
  if (clean(data.website, 200)) return respond(isForm, true, "signup", "Thanks!"); // honeypot: pretend success
  const email = clean(data.email, 254).toLowerCase();
  const name = clean(data.name, 100) || null;
  const volunteer = truthy(data.volunteer) ? 1 : 0;
  const source = clean(data.source, 40) || "site";
  if (!EMAIL_RE.test(email)) return respond(isForm, false, "signup", "Please enter a valid email address.", 400);
  if (!(await verifyTurnstile(request, env, data["cf-turnstile-response"], "signup"))) {
    return respond(isForm, false, "signup", TURNSTILE_MSG, 403);
  }
  await env.DB.prepare(
    `INSERT INTO signups (name, email, volunteer, source) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO UPDATE SET
       name = COALESCE(excluded.name, signups.name),
       volunteer = MAX(signups.volunteer, excluded.volunteer)`
  ).bind(name, email, volunteer, source).run();
  return respond(isForm, true, "signup", "You're on the list! Hello, neighbor! 🧡");
}

async function handleIdea(request, env) {
  const { data, isForm } = await readBody(request);
  if (clean(data.website, 200)) return respond(isForm, true, "ideas", "Thanks!");
  const idea = clean(data.idea, 2000);
  const name = clean(data.name, 100) || null;
  const emailRaw = clean(data.email, 254).toLowerCase();
  const would_help = truthy(data.would_help) ? 1 : 0;
  if (idea.length < 3) return respond(isForm, false, "ideas", "Tell us a little more about your idea.", 400);
  if (emailRaw && !EMAIL_RE.test(emailRaw)) return respond(isForm, false, "ideas", "That email doesn't look right. Fix it or leave it blank.", 400);
  if (ideaLooksLikeSpam(idea)) return respond(isForm, false, "ideas", SPAM_MSG, 400);
  if (!(await verifyTurnstile(request, env, data["cf-turnstile-response"], "ideas"))) {
    return respond(isForm, false, "ideas", TURNSTILE_MSG, 403);
  }
  await env.DB.prepare(`INSERT INTO ideas (name, email, idea, would_help) VALUES (?1, ?2, ?3, ?4)`)
    .bind(name, emailRaw || null, idea, would_help).run();
  return respond(isForm, true, "ideas", "Got it! Every idea gets read. Thank you! 💡");
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toCSV(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n") + "\r\n";
}

function isAuthorized(request, env) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return Boolean(env.EXPORT_TOKEN) && timingSafeEqual(token, env.EXPORT_TOKEN);
}

function htmlResponse(assetResponse, html, cacheShort) {
  const headers = new Headers(assetResponse.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (cacheShort) headers.set("Cache-Control", "public, max-age=120");
  return withHeaders(new Response(html, { status: assetResponse.status, headers }));
}

async function servePage(assetResponse, env, ctx) {
  const type = assetResponse.headers.get("Content-Type") || "";
  if (!type.includes("text/html")) return withHeaders(assetResponse);
  const html = await assetResponse.text();
  if (!html.includes("<!--HOOD_") && !html.includes("<!--IG_")) return htmlResponse(assetResponse, html, false);
  const filled = await hoodHtml(html, env, ctx);
  return htmlResponse(assetResponse, filled, filled !== html);
}

async function handleExport(request, env, url) {
  if (!isAuthorized(request, env)) return json({ ok: false, message: "Unauthorized" }, 401);
  const list = url.searchParams.get("list");
  const table = list === "ideas" ? "ideas" : list === "signups" ? "signups" : null;
  if (!table) return json({ ok: false, message: "Use ?list=signups or ?list=ideas" }, 400);
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  if (url.searchParams.get("format") === "json") return json({ ok: true, list: table, count: results.length, rows: results });
  return withHeaders(new Response(toCSV(results), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="hello-hilltop-${table}.csv"`,
      "Cache-Control": "no-store",
    },
  }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // www -> apex
    if (url.hostname === `www.${APEX}`) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/events.html") {
      url.pathname = "/events";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/signup" && request.method === "POST") return await handleSignup(request, env);
        if (url.pathname === "/api/ideas" && request.method === "POST") return await handleIdea(request, env);
        if (url.pathname === "/api/export" && request.method === "GET") return await handleExport(request, env, url);
        if (url.pathname === "/api/admin/news/refresh" && request.method === "POST") {
          if (!isAuthorized(request, env)) return json({ ok: false, message: "Unauthorized" }, 401);
          const result = await refreshNews(env);
          return json(result, result.storage_ready === false ? 503 : 200);
        }
        if (url.pathname === "/api/admin/events" || url.pathname.startsWith("/api/admin/events/")) {
          if (!isAuthorized(request, env)) return json({ ok: false, message: "Unauthorized" }, 401);
          const result = await adminEvents(request, env, url);
          return json(result.body, result.status);
        }
        if (url.pathname === "/api/admin/instagram" || url.pathname.startsWith("/api/admin/instagram/")) {
          if (!isAuthorized(request, env)) return json({ ok: false, message: "Unauthorized" }, 401);
          const result = await adminInstagram(request, env, url);
          return json(result.body, result.status);
        }
        if (url.pathname === "/api/health") return json({ ok: true });
        return json({ ok: false, message: "Not found" }, 404);
      } catch (err) {
        console.error(err);
        return json({ ok: false, message: "Something went wrong on our end. Please try again." }, 500);
      }
    }

    if (url.pathname === "/events" || url.pathname === "/events/") {
      const assetUrl = new URL("/events.html", request.url);
      const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
      return servePage(asset, env, ctx);
    }

    const res = await env.ASSETS.fetch(request);
    return servePage(res, env, ctx);
  },

  async scheduled(_controller, env, _ctx) {
    try {
      const result = await refreshNews(env);
      console.log(JSON.stringify({
        msg: "news_refresh",
        ok: result.ok,
        kept_previous: result.kept_previous,
        stored: result.stored ?? null,
        matched: result.matched ?? null,
        feeds: (result.feeds || []).map((feed) => ({ id: feed.id, ok: feed.ok, saved: feed.saved, error: feed.error })),
      }));
    } catch (err) {
      console.error(JSON.stringify({ msg: "news_refresh_failed", error: err instanceof Error ? err.message : "error" }));
    }
    try {
      const result = await refreshInstagram(env);
      console.log(JSON.stringify({
        msg: "instagram_refresh",
        ok: result.ok,
        mode: result.mode,
        posts: result.posts ?? null,
        error: result.last_error || null,
      }));
    } catch (err) {
      console.error(JSON.stringify({ msg: "instagram_refresh_failed", error: err instanceof Error ? err.message : "error" }));
    }
  },
};
