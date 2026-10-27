// Hello! Hilltop — Phase 1 Worker
// Serves the static one-page site (ASSETS binding) and handles two forms
// backed by D1 (DB binding). Lists are only readable via /api/export with
// the EXPORT_TOKEN secret.

const APEX = "hellohilltop.org";
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

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

async function handleExport(request, env, url) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!env.EXPORT_TOKEN || !timingSafeEqual(token, env.EXPORT_TOKEN)) {
    return json({ ok: false, message: "Unauthorized" }, 401);
  }
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
  async fetch(request, env) {
    const url = new URL(request.url);

    // www -> apex
    if (url.hostname === `www.${APEX}`) {
      url.hostname = APEX;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/signup" && request.method === "POST") return await handleSignup(request, env);
        if (url.pathname === "/api/ideas" && request.method === "POST") return await handleIdea(request, env);
        if (url.pathname === "/api/export" && request.method === "GET") return await handleExport(request, env, url);
        if (url.pathname === "/api/health") return json({ ok: true });
        return json({ ok: false, message: "Not found" }, 404);
      } catch (err) {
        console.error(err);
        return json({ ok: false, message: "Something went wrong on our end. Please try again." }, 500);
      }
    }

    const res = await env.ASSETS.fetch(request);
    return withHeaders(res);
  },
};
