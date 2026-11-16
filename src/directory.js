import { changesOf, missingTable, readJson } from "./db.js";
import { cleanMultiline, cleanText, esc, normalizeHttpUrl } from "./escape.js";
import { looksLikePitch, looksLikeSeoPitch } from "./spam.js";

export const DIRECTORY_OK = "Got it! We'll look it over before it goes on the directory.";
export const REMOVAL_OK = "Got it. We'll take that listing down as soon as we can.";
const NOT_READY = "The directory needs the D1 migration migrations/0005_directory.sql. wrangler deploy does not apply it.";
const HOUR_MS = 60 * 60 * 1000;
const HOURLY_LIMIT = 6;

export const CATEGORIES = [
  ["babysitter", "Babysitters"],
  ["dog-walker", "Dog walkers"],
  ["tutor", "Tutors"],
  ["handyman", "Handymen"],
  ["business", "Local businesses"],
  ["recommendation", "Recommendations"],
  ["other", "Other"],
];

const CATEGORY_IDS = new Set(CATEGORIES.map(([id]) => id));
const CATEGORY_LABEL = new Map(CATEGORIES);

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

function fail(message, status = 400) {
  return { ok: false, status, message };
}

function truthy(value) {
  return value === true || value === "on" || value === "1" || value === "true" || value === "yes";
}

export function categoryLabel(id) {
  return CATEGORY_LABEL.get(id) || "Other";
}

export function validateDirectoryInput(data) {
  if (!data || typeof data !== "object") return fail("Send the listing fields.");
  const category = cleanText(data.category, 40);
  if (!CATEGORY_IDS.has(category)) return fail("Choose a category.");
  const title = cleanText(data.title, 120);
  if (title.length < 3) return fail("Add a name for the listing (at least a few characters).");
  const description = cleanMultiline(data.description, 600);
  if (description.length < 3) return fail("Tell neighbors a little more about it.");
  const contact = cleanMultiline(data.contact, 200);
  if (contact.length < 3) return fail("Add the contact info you want neighbors to see.");
  const email = cleanText(data.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return fail("Add your email so we can follow up. It is not published unless you also put it in the contact field.");
  const name = cleanText(data.name, 100) || null;
  if (!truthy(data.consent)) return fail("Check the box so we know you're okay with this being public.");
  let contactUrl = null;
  const rawUrl = cleanText(data.contact_url, 2000);
  if (rawUrl) {
    contactUrl = normalizeHttpUrl(rawUrl);
    if (!contactUrl) return fail("Website should look like https://example.com.");
  }
  if (looksLikePitch(title) || looksLikePitch(description) || looksLikeSeoPitch(contact)) {
    return fail("That looks like a link or a sales pitch. Put a single website in the website field, and keep the description neighborly.");
  }
  if (/javascript:|data:/i.test(contact)) return fail("That contact info doesn't look right.");
  if (description.toLowerCase().includes(email) || title.toLowerCase().includes(email)) {
    return fail("Your email is for the organizers only. If you want neighbors to see it, put it in the public contact field.");
  }
  return {
    ok: true,
    value: { category, title, description, contact, contactUrl, email, name },
  };
}

export function validateRemovalInput(data) {
  if (!data || typeof data !== "object") return fail("Tell us which listing to take down.");
  const listing = cleanText(data.listing, 160);
  if (listing.length < 2) return fail("Tell us which listing to take down.");
  const email = cleanText(data.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return fail("Add the email you used, or one we can reply to.");
  if (!truthy(data.confirm)) return fail("Check the box so we know you want it taken off the public page.");
  const note = cleanMultiline(data.note, 500) || null;
  return { ok: true, value: { listing, email, note } };
}

async function countRecent(env, sql, email) {
  const since = new Date(Date.now() - HOUR_MS).toISOString();
  const { results } = await env.DB.prepare(sql).bind(email, since).all();
  return Number(results?.[0]?.n || 0);
}

export async function insertDirectory(env, value) {
  const now = new Date().toISOString();
  try {
    const recent = await countRecent(
      env,
      "SELECT COUNT(*) AS n FROM directory_listings WHERE submitter_email = ?1 AND created_at >= ?2",
      value.email,
    );
    if (recent >= HOURLY_LIMIT) return fail("That's a lot at once. Please wait a bit and try again.", 429);
    await env.DB.prepare(
      `INSERT INTO directory_listings (
        created_at, updated_at, status, category, title, description, contact, contact_url,
        submitter_name, submitter_email, consent
      ) VALUES (?1, ?1, 'pending', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)`
    ).bind(now, value.category, value.title, value.description, value.contact, value.contactUrl, value.name, value.email).run();
    return { ok: true };
  } catch (err) {
    if (missingTable(err)) return fail("The directory isn't ready yet. Please try again in a little while.", 503);
    throw err;
  }
}

export async function insertRemoval(env, value) {
  const now = new Date().toISOString();
  try {
    const recent = await countRecent(
      env,
      "SELECT COUNT(*) AS n FROM directory_removals WHERE email = ?1 AND created_at >= ?2",
      value.email,
    );
    if (recent >= HOURLY_LIMIT) return fail("That's a lot at once. Please wait a bit and try again.", 429);
    let listingId = null;
    const match = value.listing.match(/^(?:listing-)?(\d+)$/i);
    if (match) {
      const id = Number(match[1]);
      const { results } = await env.DB.prepare("SELECT id FROM directory_listings WHERE id = ?1").bind(id).all();
      if (results?.[0]) listingId = id;
    }
    await env.DB.prepare(
      `INSERT INTO directory_removals (created_at, listing_id, listing_title, email, note, status)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pending')`
    ).bind(now, listingId, value.listing, value.email, value.note).run();
    return { ok: true };
  } catch (err) {
    if (missingTable(err)) return fail("The directory isn't ready yet. Please try again in a little while.", 503);
    throw err;
  }
}

function toAdmin(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
    category: row.category,
    category_label: categoryLabel(row.category),
    title: row.title,
    description: row.description,
    contact: row.contact,
    contact_url: row.contact_url || null,
    submitter_name: row.submitter_name || null,
    submitter_email: row.submitter_email,
    reviewed_at: row.reviewed_at || null,
  };
}

function toRemoval(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    listing_id: row.listing_id || null,
    listing_title: row.listing_title,
    email: row.email,
    note: row.note || null,
    status: row.status,
  };
}

export function renderDirectory(rows) {
  const approved = (rows || []).filter((row) => row.status === "approved" || row.status === undefined);
  if (!approved.length) {
    return `<p class="empty-hood news-empty">No listings yet. Send one below and we'll look it over before it appears here.</p>`;
  }
  const groups = CATEGORIES.map(([id, label]) => ({ id, label, rows: approved.filter((row) => row.category === id) }))
    .filter((group) => group.rows.length);
  const jump = `<nav class="dir-jump" aria-label="Listing categories">${groups.map((group) => `<a href="#cat-${esc(group.id)}">${esc(group.label)}</a>`).join("")}</nav>`;
  const body = groups.map((group) => {
    const cards = group.rows.map((row) => {
      const href = row.contact_url ? normalizeHttpUrl(row.contact_url) : "";
      const website = href
        ? `<p><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">Website<span class="sr-only"> (opens in a new tab)</span></a></p>`
        : "";
      return `<article class="listing" id="listing-${Number(row.id)}"><p class="tag">${esc(group.label)}</p><h3>${esc(row.title)}</h3><p class="listing-desc">${esc(row.description)}</p><p class="listing-contact">${esc(row.contact)}</p>${website}<p class="listing-id">Listing #${Number(row.id)}</p></article>`;
    }).join("");
    return `<section class="directory-group" id="cat-${esc(group.id)}" aria-labelledby="cat-label-${esc(group.id)}"><h3 class="dir-cat" id="cat-label-${esc(group.id)}">${esc(group.label)}</h3><div class="directory-list">${cards}</div></section>`;
  }).join("");
  return jump + body;
}

export async function listApproved(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, category, title, description, contact, contact_url, status
     FROM directory_listings WHERE status = 'approved' ORDER BY category, title COLLATE NOCASE, id LIMIT 300`
  ).all();
  return results || [];
}

async function oneListing(env, id) {
  const { results } = await env.DB.prepare("SELECT * FROM directory_listings WHERE id = ?1").bind(id).all();
  return results?.[0] || null;
}

function badId() {
  return { status: 404, body: { ok: false, message: "No listing with that id." } };
}

function storageError(err) {
  if (!missingTable(err)) return null;
  return { status: 503, body: { ok: false, message: NOT_READY } };
}

export async function adminDirectory(request, env, url) {
  const rest = url.pathname.split("/").filter(Boolean).slice(3);
  try {
    if (rest.length === 0 && request.method === "GET") {
      const status = url.searchParams.get("status") || "pending";
      const allowed = new Set(["pending", "approved", "rejected", "all"]);
      if (!allowed.has(status)) return { status: 400, body: { ok: false, message: "Status should be pending, approved, rejected, or all." } };
      const sql = status === "all"
        ? "SELECT * FROM directory_listings ORDER BY id DESC LIMIT 300"
        : "SELECT * FROM directory_listings WHERE status = ?1 ORDER BY id DESC LIMIT 300";
      const query = env.DB.prepare(sql);
      const { results } = status === "all" ? await query.all() : await query.bind(status).all();
      return { status: 200, body: { ok: true, listings: (results || []).map(toAdmin) } };
    }
    if (rest[0] === "removals") return adminRemovals(request, env, rest);
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id < 1) return badId();
    if (rest.length === 1 && request.method === "GET") {
      const row = await oneListing(env, id);
      if (!row) return badId();
      return { status: 200, body: { ok: true, listing: toAdmin(row) } };
    }
    if (rest.length === 1 && request.method === "PATCH") return editListing(request, env, id);
    if (rest.length === 1 && request.method === "DELETE") return deleteListing(env, id);
    if (rest.length === 2 && rest[1] === "approve" && request.method === "POST") return setStatus(env, id, "approved");
    if (rest.length === 2 && rest[1] === "reject" && request.method === "POST") return setStatus(env, id, "rejected");
    return { status: 405, body: { ok: false, message: "That method isn't supported here." } };
  } catch (err) {
    const ready = storageError(err);
    if (ready) return ready;
    throw err;
  }
}

async function adminRemovals(request, env, rest) {
  if (rest.length === 1 && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT * FROM directory_removals ORDER BY status = 'done', id DESC LIMIT 300"
    ).all();
    return { status: 200, body: { ok: true, removals: (results || []).map(toRemoval) } };
  }
  const id = Number(rest[1]);
  if (!Number.isInteger(id) || id < 1) return { status: 404, body: { ok: false, message: "No removal request with that id." } };
  if (rest.length === 3 && rest[2] === "done" && request.method === "POST") {
    const nowCheck = await env.DB.prepare("SELECT id FROM directory_removals WHERE id = ?1").bind(id).all();
    if (!nowCheck.results?.[0]) return { status: 404, body: { ok: false, message: "No removal request with that id." } };
    await env.DB.prepare("UPDATE directory_removals SET status = 'done' WHERE id = ?1").bind(id).run();
    const { results } = await env.DB.prepare("SELECT * FROM directory_removals WHERE id = ?1").bind(id).all();
    return { status: 200, body: { ok: true, removal: toRemoval(results[0]) } };
  }
  return { status: 405, body: { ok: false, message: "That method isn't supported here." } };
}

async function setStatus(env, id, status) {
  const row = await oneListing(env, id);
  if (!row) return badId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE directory_listings SET status = ?1, reviewed_at = ?2, updated_at = ?2 WHERE id = ?3"
  ).bind(status, now, id).run();
  const next = await oneListing(env, id);
  return { status: 200, body: { ok: true, listing: toAdmin(next) } };
}

async function deleteListing(env, id) {
  const result = await env.DB.prepare("DELETE FROM directory_listings WHERE id = ?1").bind(id).run();
  if (!changesOf(result)) return badId();
  return { status: 200, body: { ok: true } };
}

async function editListing(request, env, id) {
  const current = await oneListing(env, id);
  if (!current) return badId();
  const parsed = await readJson(request);
  if (!parsed.ok) return { status: 400, body: parsed };
  const data = parsed.data;
  const next = {
    category: current.category,
    title: current.title,
    description: current.description,
    contact: current.contact,
    contact_url: current.contact_url || "",
    name: current.submitter_name || "",
    email: current.submitter_email,
    consent: "1",
  };
  if (data.category !== undefined) next.category = data.category;
  if (data.title !== undefined) next.title = data.title;
  if (data.description !== undefined) next.description = data.description;
  if (data.contact !== undefined) next.contact = data.contact;
  if (data.contact_url !== undefined) next.contact_url = data.contact_url === null ? "" : data.contact_url;
  if (data.name !== undefined) next.name = data.name === null ? "" : data.name;
  if (data.email !== undefined) next.email = data.email;
  const checked = validateDirectoryInput(next);
  if (!checked.ok) return { status: checked.status, body: { ok: false, message: checked.message } };
  const now = new Date().toISOString();
  const value = checked.value;
  await env.DB.prepare(
    `UPDATE directory_listings SET
      updated_at = ?1, category = ?2, title = ?3, description = ?4, contact = ?5,
      contact_url = ?6, submitter_name = ?7, submitter_email = ?8
     WHERE id = ?9`
  ).bind(now, value.category, value.title, value.description, value.contact, value.contactUrl, value.name, value.email, id).run();
  const row = await oneListing(env, id);
  return { status: 200, body: { ok: true, listing: toAdmin(row) } };
}
