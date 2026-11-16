import { missingTable, readJson } from "./db.js";
import { esc, normalizeHttpUrl, safeUrl } from "./escape.js";

// Public checkout links. Admin rows in site_settings win. Env vars are the
// fallback so a local .dev.vars file works. Neither is required: the page
// shows a coming-soon state instead of a button with nowhere to go.
export const SUPPORT_FIELDS = [
  ["checkout_url", "SUPPORT_CHECKOUT_URL"],
  ["checkout_go_getter_url", "SUPPORT_GO_GETTER_URL"],
  ["checkout_family_url", "SUPPORT_FAMILY_URL"],
  ["checkout_business_url", "SUPPORT_BUSINESS_URL"],
  ["venmo_url", "SUPPORT_VENMO_URL"],
  ["zeffy_url", "SUPPORT_ZEFFY_URL"],
  ["paypal_url", "SUPPORT_PAYPAL_URL"],
];

const FIELD_KEYS = new Set(SUPPORT_FIELDS.map(([key]) => key));
const NOT_READY = "Payment links need the D1 migration migrations/0004_support_settings.sql. wrangler deploy does not apply it.";

function blankLinks() {
  return {
    checkout: "",
    goGetter: "",
    family: "",
    business: "",
    venmo: "",
    zeffy: "",
    paypal: "",
    any: false,
  };
}

function envUrl(env, name) {
  const raw = env?.[name];
  return typeof raw === "string" ? normalizeHttpUrl(raw) : "";
}

export async function loadSupportLinks(env) {
  const stored = new Map();
  let storageReady = true;
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
    for (const row of results || []) stored.set(row.key, String(row.value ?? ""));
  } catch (err) {
    if (!missingTable(err)) throw err;
    storageReady = false;
  }

  const resolved = {};
  for (const [key, envName] of SUPPORT_FIELDS) {
    if (stored.has(key)) {
      const url = normalizeHttpUrl(stored.get(key));
      resolved[key] = { url, source: url ? "admin" : "unset" };
      continue;
    }
    const url = envUrl(env, envName);
    resolved[key] = { url, source: url ? "env" : "unset" };
  }

  const links = {
    checkout: resolved.checkout_url.url,
    goGetter: resolved.checkout_go_getter_url.url,
    family: resolved.checkout_family_url.url,
    business: resolved.checkout_business_url.url,
    venmo: resolved.venmo_url.url,
    zeffy: resolved.zeffy_url.url,
    paypal: resolved.paypal_url.url,
    storageReady,
    resolved,
  };
  links.any = Boolean(
    links.checkout || links.goGetter || links.family || links.business || links.venmo || links.zeffy || links.paypal,
  );
  return links;
}

function payLink(url, label, className) {
  const href = safeUrl(url);
  if (!href) return "";
  return `<a class="btn ${className} pay-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}<span class="sr-only"> (opens in a new tab)</span></a>`;
}

function tierButton(specific, shared, amount, what) {
  const own = safeUrl(specific || "");
  if (own) return payLink(own, `Give ${amount}`, "btn-orange btn-sm");
  const common = safeUrl(shared || "");
  if (common) return payLink(common, `Give ${amount} at checkout`, "btn-orange btn-sm");
  return `<p class="tier-wait">Checkout isn't open yet for ${esc(what)}.</p>`;
}

function renderStatus(links) {
  const email = `<p class="support-email"><a href="/#signup">Join the email list</a> and you'll hear when there's news.</p>`;
  if (!links.any) {
    return `<div class="support-soon"><span class="pill-label">Coming soon</span><p>Payments aren't open yet. We're still setting up a checkout that lives somewhere else, not on this site. Join the email list and you'll be first to know.</p><a class="btn btn-teal" href="/#signup">Join the email list</a></div>`;
  }
  return `<div class="support-live"><p>Use a button below. You'll finish on a hosted checkout, and Hello! Hilltop never sees or stores your card number. Nothing on this page asks for one.</p>${email}</div>`;
}

function renderGift(links) {
  const button = payLink(links.checkout, "Give any amount", "btn-orange btn-sm");
  if (button) return button;
  return `<p class="tier-wait">A one-time gift of any amount will open here once a hosted checkout is set.</p>`;
}

function renderAlt(links) {
  const buttons = [
    payLink(links.venmo, "Venmo", "btn-white"),
    payLink(links.zeffy, "Zeffy", "btn-white"),
    payLink(links.paypal, "PayPal", "btn-white"),
  ].filter(Boolean);
  if (!buttons.length) {
    return `<p class="tier-wait">Venmo, Zeffy, and PayPal will show up here if we use them. Until then, there's no extra button.</p>`;
  }
  return `<h3 class="hood-kicker">Other ways to give</h3><div class="alt-ways">${buttons.join("")}</div>`;
}

export function supportPieces(links = blankLinks()) {
  return {
    SUPPORT_STATUS: renderStatus(links),
    SUPPORT_GO_GETTER: tierButton(links.goGetter, links.checkout, "$50", "Community Go-Getter"),
    SUPPORT_FAMILY: tierButton(links.family, links.checkout, "$100", "Family \"Fun\"ding"),
    SUPPORT_BUSINESS: tierButton(links.business, links.checkout, "$250", "a business sponsorship"),
    SUPPORT_GIFT: renderGift(links),
    SUPPORT_ALT: renderAlt(links),
  };
}

function adminView(links) {
  const fields = {};
  for (const [key] of SUPPORT_FIELDS) {
    const item = links.resolved[key];
    fields[key] = { url: item.url || null, source: item.source };
  }
  return {
    ok: true,
    storage_ready: links.storageReady,
    links: fields,
    message: links.storageReady ? "These are the links the support page will show." : NOT_READY,
  };
}

export async function adminSupport(request, env) {
  if (request.method === "GET") {
    try {
      const links = await loadSupportLinks(env);
      return { status: 200, body: adminView(links) };
    } catch (err) {
      console.error(JSON.stringify({ msg: "support_read_failed", error: err instanceof Error ? err.message : "error" }));
      throw err;
    }
  }
  if (request.method !== "PUT" && request.method !== "PATCH") {
    return { status: 405, body: { ok: false, message: "That method isn't supported here." } };
  }
  const parsed = await readJson(request);
  if (!parsed.ok) return { status: 400, body: { ok: false, message: parsed.message } };
  const present = SUPPORT_FIELDS.filter(([key]) => Object.prototype.hasOwnProperty.call(parsed.data, key));
  if (!present.length) {
    return { status: 400, body: { ok: false, message: "Tell us which payment link to set. Unknown fields are ignored." } };
  }
  const ops = [];
  for (const [key] of present) {
    const raw = parsed.data[key];
    if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
      ops.push({ key, value: null });
      continue;
    }
    if (typeof raw !== "string") return { status: 400, body: { ok: false, message: `${key} should be an http(s) URL.` } };
    if (!FIELD_KEYS.has(key)) continue;
    const url = normalizeHttpUrl(raw);
    if (!url) return { status: 400, body: { ok: false, message: `${key} should be an http(s) URL.` } };
    ops.push({ key, value: url });
  }
  const now = new Date().toISOString();
  try {
    const statements = ops.map((op) => op.value === null
      ? env.DB.prepare("DELETE FROM site_settings WHERE key = ?1").bind(op.key)
      : env.DB.prepare(
        `INSERT INTO site_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(op.key, op.value, now));
    if (typeof env.DB.batch === "function") await env.DB.batch(statements);
    else for (const stmt of statements) await stmt.run();
  } catch (err) {
    if (missingTable(err)) return { status: 503, body: { ok: false, message: NOT_READY } };
    throw err;
  }
  const links = await loadSupportLinks(env);
  return { status: 200, body: adminView(links) };
}
