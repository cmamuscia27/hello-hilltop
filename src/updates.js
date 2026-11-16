import { changesOf, missingTable, readJson } from "./db.js";
import { cleanMultiline, cleanText, esc, normalizeHttpUrl } from "./escape.js";
import { formatNewsDate, parseDenverInput } from "./time.js";

const NOT_READY = "Neighbor notes need the D1 migration migrations/0007_neighbor_updates.sql. wrangler deploy does not apply it.";

function fail(message, status = 400) {
  return { ok: false, status, message };
}

export function parseExpiry(value) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
    return { ok: true, expires_at: null };
  }
  const text = cleanText(String(value), 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const end = parseDenverInput(`${text}T23:59:59`);
    if (!end) return fail("That end date doesn't look right.");
    return { ok: true, expires_at: end.utc.toISOString() };
  }
  const parsed = parseDenverInput(text);
  if (!parsed) return fail("End time should look like 2026-12-01 or 2026-12-01T18:00 in Denver time.");
  return { ok: true, expires_at: parsed.utc.toISOString() };
}

export function validateUpdateInput(data, { partial = false } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return fail("Send a JSON object.");
  const value = {};
  if (!partial || data.title !== undefined) {
    const title = cleanText(data.title, 140);
    if (title.length < 3) return fail("Add a title (at least a few characters).");
    value.title = title;
  }
  if (!partial || data.summary !== undefined) {
    const summary = cleanMultiline(data.summary, 400);
    if (summary.length < 3) return fail("Add a short summary.");
    value.summary = summary;
  }
  if (!partial || data.source_name !== undefined) {
    const source = cleanText(data.source_name, 80);
    if (source.length < 2) return fail("Add a source, like Hello! Hilltop.");
    value.source_name = source;
  }
  if (data.link !== undefined) {
    if (data.link === null || cleanText(String(data.link), 2000) === "") value.link = null;
    else {
      const href = normalizeHttpUrl(String(data.link));
      if (!href) return fail("Link should be an http(s) URL.");
      value.link = href;
    }
    value.linkProvided = true;
  } else if (!partial) {
    value.link = null;
    value.linkProvided = true;
  }
  if (data.expires_at !== undefined) {
    const expiry = parseExpiry(data.expires_at);
    if (!expiry.ok) return expiry;
    value.expires_at = expiry.expires_at;
    value.expiresProvided = true;
  } else if (!partial) {
    value.expires_at = null;
    value.expiresProvided = true;
  }
  if (partial && Object.keys(value).length === 0) return fail("Tell us what to change.");
  return { ok: true, value };
}

function toAdmin(row, now = new Date().toISOString()) {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    title: row.title,
    summary: row.summary,
    link: row.link || null,
    source_name: row.source_name,
    expires_at: row.expires_at || null,
    expired: Boolean(row.expires_at && row.expires_at <= now),
  };
}

export function renderUpdates(rows, { empty } = {}) {
  const list = rows || [];
  if (!list.length) {
    return empty || `<p class="empty-hood news-empty">No neighbor notes right now.</p>`;
  }
  const items = list.map((row) => {
    const href = row.link ? normalizeHttpUrl(row.link) : "";
    const title = esc(row.title);
    const headline = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}<span class="sr-only"> (opens in a new tab)</span></a>`
      : `<span class="update-title">${title}</span>`;
    const until = row.expires_at ? formatNewsDate(row.expires_at) : "";
    const credit = `${esc(row.source_name || "Hello! Hilltop")}${until ? ` · until ${esc(until)}` : ""}`;
    return `<li class="news-item update-item">${headline}<p class="update-summary">${esc(row.summary)}</p><p class="news-credit">${credit}</p></li>`;
  }).join("");
  return `<ul class="news-list updates-list">${items}</ul>`;
}

const HOME_EMPTY = `<p class="empty-hood news-empty">No neighbor notes right now. The news strip next door still updates on its own.</p>`;
const PAGE_EMPTY = `<p class="empty-hood news-empty">No neighbor notes right now. When there's something worth sharing, it'll land here and stay until it expires.</p>`;

export function renderHomeUpdates(rows) {
  return renderUpdates((rows || []).slice(0, 4), { empty: HOME_EMPTY });
}

export function renderUpdatesPage(rows) {
  return renderUpdates(rows, { empty: PAGE_EMPTY });
}

export async function listVisibleUpdates(env, now = new Date()) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, summary, link, source_name, expires_at, created_at
     FROM neighbor_updates
     WHERE expires_at IS NULL OR expires_at > ?1
     ORDER BY id DESC LIMIT 50`
  ).bind(now.toISOString()).all();
  return results || [];
}

async function oneUpdate(env, id) {
  const { results } = await env.DB.prepare("SELECT * FROM neighbor_updates WHERE id = ?1").bind(id).all();
  return results?.[0] || null;
}

function badId() {
  return { status: 404, body: { ok: false, message: "No neighbor note with that id." } };
}

export async function adminUpdates(request, env, url) {
  const rest = url.pathname.split("/").filter(Boolean).slice(3);
  try {
    if (rest.length === 0 && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM neighbor_updates ORDER BY id DESC LIMIT 200").all();
      return { status: 200, body: { ok: true, updates: (results || []).map((row) => toAdmin(row)) } };
    }
    if (rest.length === 0 && request.method === "POST") return createUpdate(request, env);
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id < 1 || rest.length !== 1) {
      return rest.length ? badId() : { status: 405, body: { ok: false, message: "That method isn't supported here." } };
    }
    if (request.method === "GET") {
      const row = await oneUpdate(env, id);
      if (!row) return badId();
      return { status: 200, body: { ok: true, update: toAdmin(row) } };
    }
    if (request.method === "PATCH" || request.method === "PUT") return editUpdate(request, env, id);
    if (request.method === "DELETE") return deleteUpdate(env, id);
    return { status: 405, body: { ok: false, message: "That method isn't supported here." } };
  } catch (err) {
    if (missingTable(err)) return { status: 503, body: { ok: false, message: NOT_READY } };
    throw err;
  }
}

async function createUpdate(request, env) {
  const parsed = await readJson(request);
  if (!parsed.ok) return { status: 400, body: { ok: false, message: parsed.message } };
  const checked = validateUpdateInput(parsed.data);
  if (!checked.ok) return { status: checked.status, body: { ok: false, message: checked.message } };
  const now = new Date().toISOString();
  const value = checked.value;
  const result = await env.DB.prepare(
    `INSERT INTO neighbor_updates (created_at, updated_at, title, summary, link, source_name, expires_at)
     VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(now, value.title, value.summary, value.link, value.source_name, value.expires_at).run();
  const id = Number(result?.meta?.last_row_id || 0);
  const row = id ? await oneUpdate(env, id) : null;
  return { status: 201, body: { ok: true, update: row ? toAdmin(row) : null } };
}

async function editUpdate(request, env, id) {
  const current = await oneUpdate(env, id);
  if (!current) return badId();
  const parsed = await readJson(request);
  if (!parsed.ok) return { status: 400, body: { ok: false, message: parsed.message } };
  const checked = validateUpdateInput(parsed.data, { partial: true });
  if (!checked.ok) return { status: checked.status, body: { ok: false, message: checked.message } };
  const value = checked.value;
  const next = {
    title: value.title ?? current.title,
    summary: value.summary ?? current.summary,
    source_name: value.source_name ?? current.source_name,
    link: value.linkProvided ? value.link : current.link,
    expires_at: value.expiresProvided ? value.expires_at : current.expires_at,
  };
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE neighbor_updates SET updated_at = ?1, title = ?2, summary = ?3, link = ?4, source_name = ?5, expires_at = ?6
     WHERE id = ?7`
  ).bind(now, next.title, next.summary, next.link, next.source_name, next.expires_at, id).run();
  return { status: 200, body: { ok: true, update: toAdmin(await oneUpdate(env, id)) } };
}

async function deleteUpdate(env, id) {
  const result = await env.DB.prepare("DELETE FROM neighbor_updates WHERE id = ?1").bind(id).run();
  if (!changesOf(result)) return badId();
  return { status: 200, body: { ok: true } };
}
