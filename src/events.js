import { cleanMultiline, cleanText, esc, safeUrl } from "./escape.js";
import { formatEventWhen, parseDenverInput, visibleUntil } from "./time.js";

const EVENT_COLS = `id, title, starts_at, starts_local, ends_at, ends_local, visible_until,
  location, description, link, source_name, created_at`;
const SELECT = `SELECT ${EVENT_COLS}, icon FROM events`;
const SELECT_LEGACY = `SELECT ${EVENT_COLS} FROM events`;

const UPSERT = `INSERT INTO events (
  title, starts_at, starts_local, ends_at, ends_local, visible_until,
  location, description, link, source_name, dedupe_key, icon
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
ON CONFLICT(dedupe_key) DO UPDATE SET
  title = excluded.title,
  starts_at = excluded.starts_at,
  starts_local = excluded.starts_local,
  ends_at = excluded.ends_at,
  ends_local = excluded.ends_local,
  visible_until = excluded.visible_until,
  location = excluded.location,
  description = excluded.description,
  link = excluded.link,
  source_name = excluded.source_name,
  icon = excluded.icon`;

const UPSERT_LEGACY = `INSERT INTO events (
  title, starts_at, starts_local, ends_at, ends_local, visible_until,
  location, description, link, source_name, dedupe_key
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT(dedupe_key) DO UPDATE SET
  title = excluded.title,
  starts_at = excluded.starts_at,
  starts_local = excluded.starts_local,
  ends_at = excluded.ends_at,
  ends_local = excluded.ends_local,
  visible_until = excluded.visible_until,
  location = excluded.location,
  description = excluded.description,
  link = excluded.link,
  source_name = excluded.source_name`;

const UPDATE = `UPDATE events SET
  title = ?1, starts_at = ?2, starts_local = ?3, ends_at = ?4, ends_local = ?5,
  visible_until = ?6, location = ?7, description = ?8, link = ?9, source_name = ?10,
  dedupe_key = ?11, icon = ?12
WHERE id = ?13`;

const UPDATE_LEGACY = `UPDATE events SET
  title = ?1, starts_at = ?2, starts_local = ?3, ends_at = ?4, ends_local = ?5,
  visible_until = ?6, location = ?7, description = ?8, link = ?9, source_name = ?10,
  dedupe_key = ?11
WHERE id = ?12`;

const BGS = ["bg-orange", "bg-sun", "bg-pink", "bg-sky"];
const ICON_RULES = [
  { re: /\bstory\s*times?\b|\bstorytime\b|\blibrar(?:y|ies)\b|\bbook club\b|\bbooks?\b/i, emoji: "📚", bg: "bg-sun" },
  { re: /\bzoo lights\b|\bholiday lights\b|\bchristmas\b|\btree lighting\b|\bholiday market\b/i, emoji: "🎄", bg: "bg-sky" },
  { re: /\blights\b|\blanterns?\b|\bglow\b|\bsparkle/i, emoji: "✨", bg: "bg-sun" },
  { re: /\bzoos?\b|\baquariums?\b|\bwildlife\b/i, emoji: "🦁", bg: "bg-orange" },
  { re: /\bbrunch\b|\bbreakfast\b|\bpancakes?\b|\bwaffles?\b|\bfood\b|\bdinners?\b|\blunch(?:es)?\b|\bcafes?\b|\bcoffee\b|\bbaker(?:y|ies)\b|\brestaurants?\b|\bpie\b|\btacos?\b/i, emoji: "🥞", bg: "bg-sun" },
  { re: /\bcheeses?\b|\bcharcuterie\b/i, emoji: "🧀", bg: "bg-sun" },
  { re: /\bmakers?\b|\bmakerspace\b|\bcrafts?\b|\bpaint(?:ing)?\b|\bpottery\b|\bart class\b/i, emoji: "🎨", bg: "bg-pink" },
  { re: /\bmarkets?\b/i, emoji: "✨", bg: "bg-orange" },
  { re: /\bmuseums?\b|\bfree day\b|\bparks?\b|\bplaygrounds?\b|\bgardens?\b/i, emoji: "🌳", bg: "bg-sky" },
  { re: /\bconcerts?\b|\bmusic\b|\bsing(?:ing|along)?\b/i, emoji: "🎶", bg: "bg-pink" },
  { re: /\bdogs?\b|\bpupp(?:y|ies)\b|\bpets?\b/i, emoji: "🐶", bg: "bg-orange" },
  { re: /\bbikes?\b|\bcycling\b|\bbicycle\b/i, emoji: "🚲", bg: "bg-sky" },
  { re: /\bbab(?:y|ies)\b|\btoddlers?\b|\bkids\b|\bchildren\b|\bfamil(?:y|ies)\b/i, emoji: "🎈", bg: "bg-pink" },
];

function changesOf(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

function missingColumn(err) {
  return /no such column/i.test(String(err && err.message || err));
}

export function normalizeIcon(value) {
  if (typeof value !== "string") return { ok: false, message: "Icon should be an emoji." };
  const icon = value.trim();
  if (!icon || icon.length > 16 || /[<>&]/.test(icon) || !/\p{Extended_Pictographic}/u.test(icon)) {
    return { ok: false, message: "Icon should be an emoji." };
  }
  return { ok: true, icon };
}

export function iconForEvent(event) {
  const custom = typeof event?.icon === "string" ? event.icon.trim() : "";
  if (custom && /\p{Extended_Pictographic}/u.test(custom)) {
    let hash = 0;
    for (const ch of custom) hash = (hash + ch.codePointAt(0)) % BGS.length;
    return { emoji: custom, bg: BGS[hash] };
  }
  const text = `${event?.title || ""}\n${event?.description || ""}`;
  for (const rule of ICON_RULES) {
    if (rule.re.test(text)) return { emoji: rule.emoji, bg: rule.bg };
  }
  return { emoji: "🎉", bg: "bg-orange" };
}

export function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    starts_at: row.starts_at,
    starts_local: row.starts_local,
    ends_at: row.ends_at,
    ends_local: row.ends_local,
    visible_until: row.visible_until,
    timezone: "America/Denver",
    location: row.location,
    description: row.description,
    link: row.link,
    source_name: row.source_name,
    icon: row.icon || null,
    created_at: row.created_at,
  };
}

export function parseEventPayload(data, { partial = false } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, message: "Send a JSON object." };
  }
  const value = {};
  if (!partial || data.title !== undefined) {
    const title = cleanText(data.title, 160);
    if (title.length < 3) return { ok: false, message: "Add an event title (at least a few characters)." };
    value.title = title;
  }
  if (!partial || data.starts_at !== undefined) {
    const start = parseDenverInput(typeof data.starts_at === "string" ? data.starts_at : "");
    if (!start) return { ok: false, message: "Start time should look like 2026-11-21T14:00 in Denver time." };
    value.start = start;
  }
  if (data.ends_at !== undefined) {
    if (data.ends_at === null || cleanText(String(data.ends_at), 40) === "") {
      value.end = null;
    } else {
      const end = parseDenverInput(String(data.ends_at));
      if (!end) return { ok: false, message: "End time should look like 2026-11-21T16:00 in Denver time." };
      value.end = end;
    }
    value.endProvided = true;
  } else if (!partial) {
    value.end = null;
    value.endProvided = true;
  }
  if (!partial || data.location !== undefined) {
    const location = cleanText(data.location, 200);
    if (location.length < 2) return { ok: false, message: "Add a location." };
    value.location = location;
  }
  if (!partial || data.description !== undefined) {
    const description = cleanMultiline(data.description, 600);
    if (description.length < 3) return { ok: false, message: "Add a short description." };
    value.description = description;
  }
  if (data.link !== undefined) {
    if (data.link === null || cleanText(String(data.link), 2000) === "") {
      value.link = null;
    } else {
      const href = safeUrl(cleanText(String(data.link), 2000));
      if (!href) return { ok: false, message: "Link should be an http(s) URL." };
      value.link = href;
    }
    value.linkProvided = true;
  } else if (!partial) {
    value.link = null;
    value.linkProvided = true;
  }
  if (!partial || data.source_name !== undefined) {
    const source = cleanText(data.source_name, 80);
    if (source.length < 2) return { ok: false, message: "Add the source name, like who shared the event." };
    value.source_name = source;
  }
  if (data.icon !== undefined) {
    if (data.icon === null || (typeof data.icon === "string" && data.icon.trim() === "")) {
      value.icon = null;
    } else {
      const icon = normalizeIcon(data.icon);
      if (!icon.ok) return icon;
      value.icon = icon.icon;
    }
    value.iconProvided = true;
  } else if (!partial) {
    value.icon = null;
    value.iconProvided = false;
  }
  if (partial && Object.keys(value).length === 0) return { ok: false, message: "Tell us what to change." };
  return { ok: true, value };
}

export function finalizeEvent(value) {
  if (!value.start?.utc || Number.isNaN(value.start.utc.getTime())) {
    return { ok: false, message: "Start time should look like 2026-11-21T14:00 in Denver time." };
  }
  if (value.end && value.end.utc.getTime() < value.start.utc.getTime()) {
    return { ok: false, message: "End time is before the start." };
  }
  const startsAt = value.start.utc.toISOString();
  const endsAt = value.end ? value.end.utc.toISOString() : null;
  const endsLocal = value.end ? value.end.local : null;
  const until = visibleUntil(value.start.utc, value.end ? value.end.utc : null);
  const dedupeKey = `${value.title.toLowerCase().replace(/\s+/g, " ").trim()}|${value.start.local}`;
  return {
    ok: true,
    dedupe_key: dedupeKey,
    args: [
      value.title,
      startsAt,
      value.start.local,
      endsAt,
      endsLocal,
      until,
      value.location,
      value.description,
      value.link,
      value.source_name,
      dedupeKey,
      value.icon || null,
    ],
  };
}

async function readJson(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) return { ok: false, message: "Send a JSON body." };
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 20000) return { ok: false, message: "That one's too big." };
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return { ok: false, message: "That JSON didn't parse." };
  }
}

async function rows(env, sql, legacySql, binds) {
  try {
    const stmt = env.DB.prepare(sql);
    const query = binds.length ? stmt.bind(...binds) : stmt;
    const { results } = await query.all();
    return results || [];
  } catch (err) {
    if (!missingColumn(err)) throw err;
    const stmt = env.DB.prepare(legacySql);
    const query = binds.length ? stmt.bind(...binds) : stmt;
    const { results } = await query.all();
    return (results || []).map((row) => ({ ...row, icon: null }));
  }
}

async function one(env, sql, legacySql, binds) {
  const list = await rows(env, sql, legacySql, binds);
  return list[0] || null;
}

async function writeEvent(env, sql, args, legacySql, legacyArgs, iconProvided) {
  try {
    await env.DB.prepare(sql).bind(...args).run();
    return null;
  } catch (err) {
    if (!missingColumn(err)) throw err;
    if (iconProvided) {
      return { status: 503, body: { ok: false, message: "Saving an icon needs the D1 migration migrations/0002_event_icon.sql." } };
    }
    await env.DB.prepare(legacySql).bind(...legacyArgs).run();
    return null;
  }
}

export async function listUpcoming(env, now = new Date()) {
  return rows(
    env,
    `${SELECT} WHERE visible_until >= ?1 ORDER BY starts_at ASC LIMIT 200`,
    `${SELECT_LEGACY} WHERE visible_until >= ?1 ORDER BY starts_at ASC LIMIT 200`,
    [now.toISOString()],
  );
}

function mergeEvent(current, patch) {
  const start = patch.start || { utc: new Date(current.starts_at), local: current.starts_local };
  let end = null;
  if (patch.endProvided) end = patch.end;
  else if (current.ends_at) end = { utc: new Date(current.ends_at), local: current.ends_local };
  return finalizeEvent({
    title: patch.title ?? current.title,
    start,
    end,
    location: patch.location ?? current.location,
    description: patch.description ?? current.description,
    link: patch.linkProvided ? patch.link : current.link,
    source_name: patch.source_name ?? current.source_name,
    icon: patch.iconProvided ? patch.icon : current.icon || null,
  });
}

export async function adminEvents(request, env, url) {
  const idPart = url.pathname.split("/").filter(Boolean)[3];
  const id = idPart === undefined ? null : Number(idPart);
  if (idPart !== undefined && (!Number.isInteger(id) || id < 1)) {
    return { status: 404, body: { ok: false, message: "No event with that id." } };
  }

  if (request.method === "GET" && id === null) {
    const all = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";
    const results = all
      ? await rows(env, `${SELECT} ORDER BY starts_at DESC LIMIT 500`, `${SELECT_LEGACY} ORDER BY starts_at DESC LIMIT 500`, [])
      : await rows(
        env,
        `${SELECT} WHERE visible_until >= ?1 ORDER BY starts_at ASC LIMIT 200`,
        `${SELECT_LEGACY} WHERE visible_until >= ?1 ORDER BY starts_at ASC LIMIT 200`,
        [new Date().toISOString()],
      );
    return { status: 200, body: { ok: true, events: results.map(toPublic) } };
  }
  if (request.method === "GET") {
    const row = await one(env, `${SELECT} WHERE id = ?1`, `${SELECT_LEGACY} WHERE id = ?1`, [id]);
    if (!row) return { status: 404, body: { ok: false, message: "No event with that id." } };
    return { status: 200, body: { ok: true, event: toPublic(row) } };
  }
  if (request.method === "POST" && id === null) return createEvent(request, env);
  if ((request.method === "PATCH" || request.method === "PUT") && id !== null) return updateEvent(request, env, id);
  if (request.method === "DELETE" && id !== null) {
    const result = await env.DB.prepare("DELETE FROM events WHERE id = ?1").bind(id).run();
    if (!changesOf(result)) return { status: 404, body: { ok: false, message: "No event with that id." } };
    return { status: 200, body: { ok: true } };
  }
  return { status: 405, body: { ok: false, message: "That method isn't supported here." } };
}

async function createEvent(request, env) {
  const parsed = await readJson(request);
  if (!parsed.ok) return { status: 400, body: { ok: false, message: parsed.message } };
  const payload = parseEventPayload(parsed.data);
  if (!payload.ok) return { status: 400, body: { ok: false, message: payload.message } };
  let fields = finalizeEvent(payload.value);
  if (!fields.ok) return { status: 400, body: { ok: false, message: fields.message } };
  const existing = await one(env, `${SELECT} WHERE dedupe_key = ?1`, `${SELECT_LEGACY} WHERE dedupe_key = ?1`, [fields.dedupe_key]);
  if (!payload.value.iconProvided && existing?.icon) {
    payload.value.icon = existing.icon;
    fields = finalizeEvent(payload.value);
  }
  const failed = await writeEvent(env, UPSERT, fields.args, UPSERT_LEGACY, fields.args.slice(0, 11), payload.value.iconProvided);
  if (failed) return failed;
  const row = await one(env, `${SELECT} WHERE dedupe_key = ?1`, `${SELECT_LEGACY} WHERE dedupe_key = ?1`, [fields.dedupe_key]);
  return { status: existing ? 200 : 201, body: { ok: true, created: !existing, event: toPublic(row) } };
}

async function updateEvent(request, env, id) {
  const current = await one(env, `${SELECT} WHERE id = ?1`, `${SELECT_LEGACY} WHERE id = ?1`, [id]);
  if (!current) return { status: 404, body: { ok: false, message: "No event with that id." } };
  const parsed = await readJson(request);
  if (!parsed.ok) return { status: 400, body: { ok: false, message: parsed.message } };
  const payload = parseEventPayload(parsed.data, { partial: true });
  if (!payload.ok) return { status: 400, body: { ok: false, message: payload.message } };
  const fields = mergeEvent(current, payload.value);
  if (!fields.ok) return { status: 400, body: { ok: false, message: fields.message } };
  const clash = await one(
    env,
    `${SELECT} WHERE dedupe_key = ?1 AND id != ?2`,
    `${SELECT_LEGACY} WHERE dedupe_key = ?1 AND id != ?2`,
    [fields.dedupe_key, id],
  );
  if (clash) return { status: 409, body: { ok: false, message: "Another event already uses that title and start time." } };
  const failed = await writeEvent(env, UPDATE, [...fields.args, id], UPDATE_LEGACY, [...fields.args.slice(0, 11), id], payload.value.iconProvided);
  if (failed) return failed;
  const row = await one(env, `${SELECT} WHERE id = ?1`, `${SELECT_LEGACY} WHERE id = ?1`, [id]);
  return { status: 200, body: { ok: true, event: toPublic(row) } };
}

function renderEventCard(event, featured) {
  const art = iconForEvent(event);
  const when = formatEventWhen(event.starts_at, event.ends_at);
  const href = safeUrl(event.link || "");
  const more = href
    ? `<a class="btn btn-teal btn-sm" href="${esc(href)}" target="_blank" rel="noopener noreferrer">More details<span class="sr-only"> (opens in a new tab)</span></a>`
    : "";
  return `<article class="event${featured ? " featured" : ""}"><div class="event-art ${art.bg}" aria-hidden="true">${art.emoji}</div><div class="event-body">${when ? `<span class="chip">${esc(when)}</span>` : ""}<h3>${esc(event.title)}</h3><p class="where">📍 ${esc(event.location)}</p><p class="event-desc">${esc(event.description)}</p><p class="event-source">Via ${esc(event.source_name)}</p>${more}</div></article>`;
}

export function renderEventList(events, { limit, ideaHref = "/#ideas" } = {}) {
  const rows = typeof limit === "number" ? events.slice(0, limit) : events;
  if (!rows.length) {
    return `<article class="event empty-hood"><div class="event-body"><span class="chip chip-sun">Nothing scheduled</span><h3>The calendar's taking a breath.</h3><p>No upcoming events yet. When a block party, market, or porch hang is on the books, it'll show up here.</p><a class="btn btn-orange btn-sm" href="${esc(ideaHref)}">Share an idea</a></div></article>`;
  }
  return rows.map((event, index) => renderEventCard(event, index === 0)).join("");
}
