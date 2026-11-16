import { missingTable, readJson, readOptionalJson } from "./db.js";
import { cleanMultiline, cleanText, normalizeHttpUrl } from "./escape.js";
import { parseEventPayload, saveNewEvent, toPublic } from "./events.js";
import { looksLikePitch } from "./spam.js";
import { parseDenverInput, visibleUntil } from "./time.js";

export const HOST_OK = "Thanks! We'll read this before it goes on the calendar.";
const NOT_READY = "Event proposals need the D1 migration migrations/0006_event_proposals.sql. wrangler deploy does not apply it.";
const HOUR_MS = 60 * 60 * 1000;
const HOURLY_LIMIT = 6;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

function fail(message, status = 400) {
  return { ok: false, status, message };
}

function truthy(value) {
  return value === true || value === "on" || value === "1" || value === "true" || value === "yes";
}

export function describeHostedEvent(description, kid, dog) {
  const notes = [];
  if (kid && !/\bkid[- ]?friendly\b/i.test(description)) notes.push("Kid friendly.");
  if (dog && !/\bdogs welcome\b|\bdog[- ]?friendly\b/i.test(description)) notes.push("Dogs welcome.");
  const base = String(description || "").trim();
  if (!notes.length) return base;
  const suffix = notes.join(" ");
  const room = 600 - suffix.length - 1;
  if (room < 3) return suffix.slice(0, 600);
  const trimmed = base.length > room ? base.slice(0, room).trim() : base;
  return `${trimmed}\n${suffix}`;
}

function mentionsEmail(value, email) {
  return Boolean(email) && String(value || "").toLowerCase().includes(email);
}

export function validateHostInput(data) {
  if (!data || typeof data !== "object") return fail("Send the event fields.");
  const title = cleanText(data.title, 160);
  if (title.length < 3) return fail("Add an event title (at least a few characters).");
  const start = parseDenverInput(typeof data.starts_at === "string" ? data.starts_at : "");
  if (!start) return fail("Start time should look like 2026-11-21T14:00 in Denver time.");
  let end = null;
  const endsRaw = data.ends_at;
  if (endsRaw !== undefined && endsRaw !== null && cleanText(String(endsRaw), 40) !== "") {
    end = parseDenverInput(String(endsRaw));
    if (!end) return fail("End time should look like 2026-11-21T16:00 in Denver time.");
    if (end.utc.getTime() < start.utc.getTime()) return fail("End time is before the start.");
  }
  if (Date.parse(visibleUntil(start.utc, end ? end.utc : null)) < Date.now()) {
    return fail("That time has already passed. Pick an upcoming Denver time.");
  }
  const location = cleanText(data.location, 200);
  if (location.length < 2) return fail("Add a location.");
  const cleanDescription = cleanMultiline(data.description, 600);
  if (cleanDescription.length < 3) return fail("Add a short description.");
  const name = cleanText(data.name, 80);
  if (name.length < 2) return fail("Add your name so neighbors know who's hosting.");
  if (name.includes("@")) return fail("Use your name in the name field. Your email has its own box, and it stays private.");
  const email = cleanText(data.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return fail("Add your email so we can ask a question. It is never shown on the calendar.");
  let link = null;
  const rawLink = data.link === null || data.link === undefined ? "" : cleanText(String(data.link), 2000);
  if (rawLink) {
    link = normalizeHttpUrl(rawLink);
    if (!link) return fail("Link should be an http(s) URL.");
  }
  const publicBits = [title, location, cleanDescription, name];
  if (publicBits.some((bit) => mentionsEmail(bit, email))) {
    return fail("Take your email out of the public fields. The email box stays private, and the rest can go on the calendar.");
  }
  if (looksLikePitch(title) || looksLikePitch(cleanDescription)) {
    return fail("That looks like a link or a sales pitch. Put one website in the link field, and keep the description neighborly.");
  }
  return {
    ok: true,
    value: {
      title,
      starts_local: start.local,
      ends_local: end ? end.local : null,
      location,
      description: cleanDescription,
      link,
      organizer_name: name,
      organizer_email: email,
      kid_friendly: truthy(data.kid_friendly) ? 1 : 0,
      dog_friendly: truthy(data.dog_friendly) ? 1 : 0,
    },
  };
}

export async function insertProposal(env, value) {
  const now = new Date().toISOString();
  try {
    const since = new Date(Date.now() - HOUR_MS).toISOString();
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM event_proposals WHERE organizer_email = ?1 AND created_at >= ?2"
    ).bind(value.organizer_email, since).all();
    if (Number(results?.[0]?.n || 0) >= HOURLY_LIMIT) return fail("That's a lot at once. Please wait a bit and try again.", 429);
    await env.DB.prepare(
      `INSERT INTO event_proposals (
        created_at, updated_at, status, title, starts_local, ends_local, location, description,
        link, organizer_name, organizer_email, kid_friendly, dog_friendly
      ) VALUES (?1, ?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    ).bind(
      now,
      value.title,
      value.starts_local,
      value.ends_local,
      value.location,
      value.description,
      value.link,
      value.organizer_name,
      value.organizer_email,
      value.kid_friendly,
      value.dog_friendly,
    ).run();
    return { ok: true };
  } catch (err) {
    if (missingTable(err)) return fail("Event hosting isn't ready yet. Please try again in a little while.", 503);
    throw err;
  }
}

function toAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
    title: row.title,
    starts_local: row.starts_local,
    ends_local: row.ends_local || null,
    timezone: "America/Denver",
    location: row.location,
    description: row.description,
    link: row.link || null,
    organizer_name: row.organizer_name,
    organizer_email: row.organizer_email,
    kid_friendly: Number(row.kid_friendly) === 1,
    dog_friendly: Number(row.dog_friendly) === 1,
    event_id: row.event_id || null,
    reviewed_at: row.reviewed_at || null,
  };
}

async function oneProposal(env, id) {
  const { results } = await env.DB.prepare("SELECT * FROM event_proposals WHERE id = ?1").bind(id).all();
  return results?.[0] || null;
}

function badId() {
  return { status: 404, body: { ok: false, message: "No event proposal with that id." } };
}

export async function adminProposals(request, env, url) {
  const rest = url.pathname.split("/").filter(Boolean).slice(3);
  try {
    if (rest.length === 0 && request.method === "GET") {
      const status = url.searchParams.get("status") || "pending";
      const allowed = new Set(["pending", "approved", "rejected", "all"]);
      if (!allowed.has(status)) return { status: 400, body: { ok: false, message: "Status should be pending, approved, rejected, or all." } };
      const sql = status === "all"
        ? "SELECT * FROM event_proposals ORDER BY id DESC LIMIT 300"
        : "SELECT * FROM event_proposals WHERE status = ?1 ORDER BY id DESC LIMIT 300";
      const query = env.DB.prepare(sql);
      const { results } = status === "all" ? await query.all() : await query.bind(status).all();
      return { status: 200, body: { ok: true, proposals: (results || []).map(toAdmin) } };
    }
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id < 1) return badId();
    if (rest.length === 1 && request.method === "GET") {
      const row = await oneProposal(env, id);
      if (!row) return badId();
      return { status: 200, body: { ok: true, proposal: toAdmin(row) } };
    }
    if (rest.length === 1 && request.method === "PATCH") return editProposal(request, env, id);
    if (rest.length === 1 && request.method === "DELETE") return deleteProposal(env, id);
    if (rest.length === 2 && rest[1] === "approve" && request.method === "POST") return approveProposal(request, env, id);
    if (rest.length === 2 && rest[1] === "reject" && request.method === "POST") return rejectProposal(env, id);
    return { status: 405, body: { ok: false, message: "That method isn't supported here." } };
  } catch (err) {
    if (missingTable(err)) return { status: 503, body: { ok: false, message: NOT_READY } };
    throw err;
  }
}

async function editProposal(request, env, id) {
  const current = await oneProposal(env, id);
  if (!current) return badId();
  if (current.status !== "pending") {
    return { status: 409, body: { ok: false, message: "This one has already been reviewed. Edit the calendar event if it's already public." } };
  }
  const parsed = await readJson(request);
  if (!parsed.ok) return { status: 400, body: { ok: false, message: parsed.message } };
  const data = {
    title: current.title,
    starts_at: current.starts_local,
    ends_at: current.ends_local,
    location: current.location,
    description: current.description,
    name: current.organizer_name,
    email: current.organizer_email,
    link: current.link,
    kid_friendly: Number(current.kid_friendly) === 1,
    dog_friendly: Number(current.dog_friendly) === 1,
    ...parsed.data,
  };
  if (parsed.data.starts_at === undefined) data.starts_at = current.starts_local;
  if (parsed.data.ends_at === undefined) data.ends_at = current.ends_local;
  if (parsed.data.organizer_name !== undefined && parsed.data.name === undefined) data.name = parsed.data.organizer_name;
  if (parsed.data.organizer_email !== undefined && parsed.data.email === undefined) data.email = parsed.data.organizer_email;
  const checked = validateHostInput(data);
  if (!checked.ok) return { status: checked.status, body: { ok: false, message: checked.message } };
  const now = new Date().toISOString();
  const value = checked.value;
  await env.DB.prepare(
    `UPDATE event_proposals SET
      updated_at = ?1, title = ?2, starts_local = ?3, ends_local = ?4, location = ?5,
      description = ?6, link = ?7, organizer_name = ?8, organizer_email = ?9,
      kid_friendly = ?10, dog_friendly = ?11
     WHERE id = ?12`
  ).bind(
    now,
    value.title,
    value.starts_local,
    value.ends_local,
    value.location,
    value.description,
    value.link,
    value.organizer_name,
    value.organizer_email,
    value.kid_friendly,
    value.dog_friendly,
    id,
  ).run();
  return { status: 200, body: { ok: true, proposal: toAdmin(await oneProposal(env, id)) } };
}

async function deleteProposal(env, id) {
  const result = await env.DB.prepare("DELETE FROM event_proposals WHERE id = ?1").bind(id).run();
  const changes = result?.meta?.changes ?? result?.changes ?? 0;
  if (!changes) return badId();
  return { status: 200, body: { ok: true } };
}

async function rejectProposal(env, id) {
  const current = await oneProposal(env, id);
  if (!current) return badId();
  if (current.status === "approved") {
    return { status: 409, body: { ok: false, message: "This one is already on the calendar. Delete the event if it should come down." } };
  }
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE event_proposals SET status = 'rejected', reviewed_at = ?1, updated_at = ?1 WHERE id = ?2"
  ).bind(now, id).run();
  return { status: 200, body: { ok: true, proposal: toAdmin(await oneProposal(env, id)) } };
}

async function approveProposal(request, env, id) {
  const current = await oneProposal(env, id);
  if (!current) return badId();
  if (current.status === "approved" && current.event_id) {
    const { results } = await env.DB.prepare(
      "SELECT id, title, starts_at, starts_local, ends_at, ends_local, visible_until, location, description, link, source_name, icon, created_at FROM events WHERE id = ?1"
    ).bind(current.event_id).all();
    if (results?.[0]) {
      return { status: 200, body: { ok: true, already: true, created: false, event: toPublic(results[0]), proposal: toAdmin(current) } };
    }
  }
  const parsed = await readOptionalJson(request);
  if (!parsed.ok) return { status: 400, body: { ok: false, message: parsed.message } };
  let sourceName = cleanText(current.organizer_name, 80);
  if (parsed.data.source_name !== undefined) {
    sourceName = cleanText(parsed.data.source_name, 80);
    if (sourceName.length < 2) return { status: 400, body: { ok: false, message: "The public source name needs a few characters, and it can't be an email." } };
  }
  if (sourceName.includes("@") || sourceName.toLowerCase().includes(String(current.organizer_email).toLowerCase())) {
    return { status: 400, body: { ok: false, message: "The public source name can't include the organizer's email." } };
  }
  const description = describeHostedEvent(current.description, Number(current.kid_friendly) === 1, Number(current.dog_friendly) === 1);
  const payload = parseEventPayload({
    title: current.title,
    starts_at: current.starts_local,
    ends_at: current.ends_local,
    location: current.location,
    description,
    link: current.link,
    source_name: sourceName,
  });
  if (!payload.ok) return { status: 400, body: { ok: false, message: payload.message } };
  const saved = await saveNewEvent(env, payload.value);
  if (!saved.body?.ok || !saved.body.event?.id) return saved;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE event_proposals SET status = 'approved', event_id = ?1, reviewed_at = ?2, updated_at = ?2 WHERE id = ?3"
  ).bind(saved.body.event.id, now, id).run();
  const proposal = toAdmin(await oneProposal(env, id));
  return {
    status: 200,
    body: { ok: true, created: saved.body.created, event: saved.body.event, proposal },
  };
}
