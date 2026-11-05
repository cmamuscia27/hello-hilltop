import { cleanMultiline, esc } from "./escape.js";
import { formatNewsDate } from "./time.js";

// Official Instagram API with Instagram Login, plus tokenless oEmbed for a
// few public post URLs chosen by an admin. No scraping and no unofficial API.
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
// https://developers.facebook.com/docs/graph-api/reference/instagram-oembed/

export const GRAPH_VERSION = "v23.0";
export const INSTAGRAM_PROFILE = "https://www.instagram.com/hilltopneighborhooddenver/";
export const INSTAGRAM_HANDLE = "hilltopneighborhooddenver";

const SHOW_LIMIT = 6;
const MEDIA_FIELDS = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,username";
const MEDIA_FIELDS_MIN = "id,media_type,media_url,thumbnail_url,permalink,timestamp";
const ASSUMED_TTL_MS = 50 * 24 * 60 * 60 * 1000;
const REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;
const MIN_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;
const SEED_BACKOFF_MS = 15 * 60 * 1000;
const MAX_BYTES = 250_000;
const USER_AGENT = "HelloHilltop/1.0 (+https://hellohilltop.org)";

const POST_HOSTS = new Set(["www.instagram.com", "instagram.com", "www.instagr.am", "instagr.am"]);
const POST_PATH = /^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{2,64})\/?$/;
const CDN_HOST = /(?:^|\.)cdninstagram\.com$|(?:^|\.)fbcdn\.net$/i;
const VIDEO_EXT = /\.(?:mp4|mov|m4v|webm)$/i;

export function instagramPostUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) return "";
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || !POST_HOSTS.has(url.hostname.toLowerCase())) return "";
  const match = url.pathname.match(POST_PATH);
  if (!match) return "";
  const kind = match[1] === "reels" ? "reel" : match[1];
  return `https://www.instagram.com/${kind}/${match[2]}/`;
}

export function cdnImageUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return "";
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  if (!CDN_HOST.test(url.hostname)) return "";
  if (VIDEO_EXT.test(url.pathname)) return "";
  return url.href;
}

function parseIgTime(value) {
  if (typeof value !== "string" || value.length > 40) return null;
  const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

function plainCaption(value) {
  if (typeof value !== "string") return "";
  return cleanMultiline(value, 500).replace(/\s*\n\s*/g, " ").trim();
}

function clip(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function normalizeMedia(item) {
  if (!item || typeof item !== "object") return null;
  const id = typeof item.id === "string" ? item.id : "";
  if (!/^\d{5,32}$/.test(id)) return null;
  const username = typeof item.username === "string" ? item.username.toLowerCase() : "";
  if (username && username !== INSTAGRAM_HANDLE) return null;
  const permalink = instagramPostUrl(item.permalink);
  if (!permalink) return null;
  const mediaType = item.media_type === "VIDEO" || item.media_type === "CAROUSEL_ALBUM" ? item.media_type : "IMAGE";
  const image = mediaType === "VIDEO" ? cdnImageUrl(item.thumbnail_url) : (cdnImageUrl(item.media_url) || cdnImageUrl(item.thumbnail_url));
  return {
    id,
    permalink,
    media_type: mediaType,
    image_url: image,
    caption: plainCaption(item.caption),
    posted_at: parseIgTime(item.timestamp),
    source: "graph",
  };
}

export function postsFromMedia(body) {
  const data = Array.isArray(body?.data) ? body.data : null;
  if (!data) return { ok: false, error: "bad_media" };
  const posts = [];
  const seen = new Set();
  let skippedAccount = 0;
  for (const item of data) {
    const username = typeof item?.username === "string" ? item.username.toLowerCase() : "";
    if (username && username !== INSTAGRAM_HANDLE) {
      skippedAccount += 1;
      continue;
    }
    const post = normalizeMedia(item);
    if (!post || seen.has(post.id)) continue;
    seen.add(post.id);
    posts.push(post);
    if (posts.length >= SHOW_LIMIT) break;
  }
  if (!posts.length && data.length) return { ok: false, error: skippedAccount ? "unexpected_account" : "bad_media" };
  return { ok: true, posts };
}

export function parsePinUrls(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.urls)) {
    return { ok: false, message: "Send a urls list of Instagram post links." };
  }
  if (data.urls.length > SHOW_LIMIT) return { ok: false, message: "Send at most 6 Instagram post links." };
  const urls = [];
  const seen = new Set();
  for (const raw of data.urls) {
    const url = instagramPostUrl(typeof raw === "string" ? raw : "");
    if (!url) return { ok: false, message: "Each link has to be a public Instagram post, Reel, or IGTV URL." };
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return { ok: true, urls };
}

function presentPost(row) {
  const permalink = instagramPostUrl(row?.permalink || "");
  if (!permalink) return null;
  const source = row?.source === "oembed" ? "oembed" : "graph";
  const mediaType = row?.media_type === "VIDEO" || row?.media_type === "CAROUSEL_ALBUM" ? row.media_type : "IMAGE";
  const posted = typeof row?.posted_at === "string" && !Number.isNaN(Date.parse(row.posted_at)) ? new Date(row.posted_at).toISOString() : "";
  return {
    permalink,
    source,
    media_type: mediaType,
    image_url: source === "graph" ? cdnImageUrl(row?.image_url || "") : "",
    caption: plainCaption(typeof row?.caption === "string" ? row.caption : ""),
    posted_at: posted,
  };
}

function followLink() {
  return `<p class="ig-follow"><a class="btn btn-orange" href="${esc(INSTAGRAM_PROFILE)}" target="_blank" rel="noopener noreferrer">Follow us on Instagram<span class="sr-only"> (opens in a new tab)</span></a></p>`;
}

function renderCard(post) {
  const href = esc(post.permalink);
  const caption = clip(post.caption, 140);
  const alt = caption ? "" : "Instagram post from @hilltopneighborhooddenver";
  const photo = post.image_url
    ? `<span class="ig-photo"><img src="${esc(post.image_url)}" alt="${esc(alt)}" width="640" height="640" loading="lazy" decoding="async" referrerpolicy="no-referrer">${post.media_type === "VIDEO" ? `<span class="ig-play" aria-hidden="true">▶</span>` : ""}</span>`
    : `<span class="ig-photo ig-photo-missing"></span>`;
  const text = caption
    ? `<span class="ig-caption">${esc(caption)}</span>`
    : `<span class="sr-only">View this post on Instagram</span>`;
  const when = formatNewsDate(post.posted_at);
  const time = when ? `<time class="ig-when" datetime="${esc(post.posted_at)}">${esc(when)}</time>` : "";
  const video = post.media_type === "VIDEO" ? `<span class="sr-only">Video. </span>` : "";
  return `<li><a class="ig-post" href="${href}" target="_blank" rel="noopener noreferrer">${photo}${video}${text}${time}</a></li>`;
}

function renderEmbed(post) {
  const href = esc(post.permalink);
  return `<div class="ig-embed"><blockquote class="instagram-media" data-instgrm-permalink="${href}" data-instgrm-version="14"><a href="${href}" target="_blank" rel="noopener noreferrer">View this post on Instagram</a></blockquote></div>`;
}

export function renderInstagram(posts) {
  const safe = (posts || []).map(presentPost).filter(Boolean).slice(0, SHOW_LIMIT);
  if (!safe.length) return "";
  const cards = safe.filter((post) => post.source !== "oembed");
  const embeds = safe.filter((post) => post.source === "oembed");
  let html = "";
  if (cards.length) html += `<ul class="ig-posts">${cards.map(renderCard).join("")}</ul>`;
  if (embeds.length) {
    html += `<div class="ig-embeds">${embeds.map(renderEmbed).join("")}</div>`;
    html += `<script async src="https://www.instagram.com/embed.js"></script>`;
  }
  return html + followLink();
}

export function tokenSecret(env) {
  const value = env?.INSTAGRAM_ACCESS_TOKEN;
  if (typeof value !== "string") return "";
  const token = value.trim();
  if (token.length < 20 || token.length > 500 || /\s/.test(token)) return "";
  return token;
}

function appSecret(env) {
  const value = env?.INSTAGRAM_APP_SECRET;
  if (typeof value !== "string") return "";
  const secret = value.trim();
  if (secret.length < 8 || secret.length > 200 || /\s/.test(secret)) return "";
  return secret;
}

function bytesToB64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function aesKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(token, secret) {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token)));
  return `v1.${bytesToB64(iv)}.${bytesToB64(cipher)}`;
}

export async function decryptToken(payload, secret) {
  if (typeof payload !== "string" || typeof secret !== "string" || !secret) return "";
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return "";
  try {
    const key = await aesKey(secret);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(parts[1]) }, key, b64ToBytes(parts[2]));
    const token = new TextDecoder().decode(plain);
    return token.length >= 20 && !/\s/.test(token) ? token : "";
  } catch {
    return "";
  }
}

export function shouldRefreshToken(meta, now = Date.now()) {
  const expires = Date.parse(meta?.token_expires_at || "");
  if (Number.isNaN(expires) || expires - now > REFRESH_WINDOW_MS) return false;
  const stored = Date.parse(meta?.token_stored_at || "");
  if (!Number.isNaN(stored) && now - stored < MIN_TOKEN_AGE_MS) return false;
  return true;
}

function graphError(body, status) {
  const code = Number(body?.error?.code);
  const sub = Number(body?.error?.error_subcode);
  if (Number.isFinite(code) && code > 0) return `instagram_${code}${Number.isFinite(sub) && sub > 0 ? `_${sub}` : ""}`;
  return `http_${status}`;
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error("empty");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("too_large");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(buf));
}

async function fetchJson(url, headers, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT, ...headers },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const name = err && err.name;
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "fetch_failed" };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { ok: false, error: `http_${response.status}` };
  }
  let body = null;
  try {
    body = await readBoundedJson(response);
  } catch {
    return { ok: false, error: response.ok ? "bad_json" : `http_${response.status}` };
  }
  if (!response.ok || (body && typeof body === "object" && body.error)) {
    return { ok: false, error: graphError(body, response.status) };
  }
  return { ok: true, body };
}

async function fetchMedia(token, fetchImpl) {
  const request = (fields) => {
    const url = new URL(`https://graph.instagram.com/${GRAPH_VERSION}/me/media`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", String(SHOW_LIMIT));
    return fetchJson(url, { Authorization: `Bearer ${token}` }, fetchImpl);
  };
  const first = await request(MEDIA_FIELDS);
  if (first.ok || !String(first.error || "").startsWith("instagram_100")) return first;
  return request(MEDIA_FIELDS_MIN);
}

function tokenResponse(body) {
  const token = body?.access_token;
  const expiresIn = Number(body?.expires_in);
  if (typeof token !== "string" || token.length < 20 || token.length > 500 || /\s/.test(token)) return null;
  return { token, expiresIn: Number.isFinite(expiresIn) && expiresIn >= 3600 ? expiresIn : ASSUMED_TTL_MS / 1000 };
}

async function exchangeLongLived(token, secret, fetchImpl) {
  const url = new URL("https://graph.instagram.com/access_token");
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", secret);
  url.searchParams.set("access_token", token);
  const result = await fetchJson(url, {}, fetchImpl);
  if (!result.ok) return result;
  const parsed = tokenResponse(result.body);
  return parsed ? { ok: true, ...parsed } : { ok: false, error: "bad_token" };
}

async function refreshLongLived(token, fetchImpl) {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  const result = await fetchJson(url, {}, fetchImpl);
  if (!result.ok) return result;
  const parsed = tokenResponse(result.body);
  return parsed ? { ok: true, ...parsed } : { ok: false, error: "bad_token" };
}

async function fetchOembed(postUrl, fetchImpl) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/instagram_oembed`);
  url.searchParams.set("url", postUrl);
  url.searchParams.set("omitscript", "true");
  const result = await fetchJson(url, {}, fetchImpl);
  if (!result.ok) return result;
  if (result.body?.provider_name !== "Instagram" || result.body?.type !== "rich") {
    return { ok: false, error: "unexpected_oembed" };
  }
  const kind = postUrl.includes("/reel/") ? "reel" : postUrl.includes("/tv/") ? "tv" : "p";
  const shortcode = postUrl.split("/").filter(Boolean).pop();
  return {
    ok: true,
    post: {
      id: `oembed:${kind}:${shortcode}`,
      permalink: postUrl,
      media_type: null,
      image_url: "",
      caption: "",
      posted_at: null,
      source: "oembed",
    },
  };
}

async function readMeta(env) {
  return env.DB.prepare(
    `SELECT token_cipher, token_stored_at, token_expires_at, last_ok_at, last_attempt_at, last_error, item_count, mode
     FROM instagram_meta WHERE id = 1`
  ).first();
}

async function listPins(env) {
  const { results } = await env.DB.prepare("SELECT url FROM instagram_pins ORDER BY position ASC LIMIT 6").all();
  return (results || []).map((row) => instagramPostUrl(row.url)).filter(Boolean);
}

export async function listInstagramPosts(env) {
  const { results } = await env.DB.prepare(
    `SELECT permalink, media_type, image_url, caption, posted_at, source
     FROM instagram_posts ORDER BY position ASC LIMIT ?1`
  ).bind(SHOW_LIMIT).all();
  return results || [];
}

async function countPosts(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM instagram_posts").first();
  return Number(row?.n || 0);
}

function storageResult() {
  return {
    ok: false,
    storage_ready: false,
    kept_previous: true,
    configured: false,
    mode: "unconfigured",
    posts: 0,
    pins: [],
    token_expires_at: null,
    last_ok_at: null,
    last_error: null,
    message: "Instagram storage isn't ready yet. Apply the D1 migration.",
  };
}

async function saveToken(env, token, storedAt, expiresAt) {
  const secret = tokenSecret(env);
  if (!secret) return;
  const cipher = await encryptToken(token, secret);
  await env.DB.prepare(
    `INSERT INTO instagram_meta (id, token_cipher, token_stored_at, token_expires_at)
     VALUES (1, ?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET
       token_cipher = excluded.token_cipher,
       token_stored_at = excluded.token_stored_at,
       token_expires_at = excluded.token_expires_at`
  ).bind(cipher, storedAt, expiresAt).run();
}

async function markMeta(env, fields) {
  await env.DB.prepare(
    `INSERT INTO instagram_meta (id, last_ok_at, last_attempt_at, last_error, item_count, mode)
     VALUES (1, ?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET
       last_ok_at = excluded.last_ok_at,
       last_attempt_at = excluded.last_attempt_at,
       last_error = excluded.last_error,
       item_count = excluded.item_count,
       mode = excluded.mode`
  ).bind(fields.last_ok_at, fields.last_attempt_at, fields.last_error, fields.item_count, fields.mode).run();
}

async function replacePosts(env, posts, fetchedAt) {
  const statements = [env.DB.prepare("DELETE FROM instagram_posts")];
  posts.forEach((post, position) => {
    statements.push(env.DB.prepare(
      `INSERT INTO instagram_posts (
        id, permalink, media_type, image_url, caption, posted_at, source, position, fetched_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    ).bind(
      post.id,
      post.permalink,
      post.media_type,
      post.image_url || null,
      post.caption || null,
      post.posted_at,
      post.source,
      position,
      fetchedAt,
    ));
  });
  await env.DB.batch(statements);
}

async function resolveToken(env, meta) {
  const secret = tokenSecret(env);
  if (meta?.token_cipher && secret) {
    const stored = await decryptToken(meta.token_cipher, secret);
    if (stored) return { token: stored, stored: true };
  }
  return { token: secret, stored: false };
}

async function loadGraph(env, meta, fetchImpl, now) {
  const resolved = await resolveToken(env, meta);
  let token = resolved.token;
  if (!token) return { ok: false, error: "not_configured" };
  let currentMeta = meta || {};
  let persisted = resolved.stored;
  const secret = appSecret(env);
  // A failed exchange is retried next run. Saving the short-lived token would
  // hide it behind a 50-day expiry and stop the retry.
  let exchangeFailed = false;
  if (!persisted && secret) {
    const exchanged = await exchangeLongLived(token, secret, fetchImpl);
    if (exchanged.ok) {
      token = exchanged.token;
      const storedAt = new Date(now).toISOString();
      const expiresAt = new Date(now + exchanged.expiresIn * 1000).toISOString();
      await saveToken(env, token, storedAt, expiresAt);
      currentMeta = { ...currentMeta, token_stored_at: storedAt, token_expires_at: expiresAt, token_cipher: "saved" };
      persisted = true;
    } else {
      exchangeFailed = true;
    }
  }
  if (persisted && shouldRefreshToken(currentMeta, now)) {
    const refreshed = await refreshLongLived(token, fetchImpl);
    if (refreshed.ok) {
      token = refreshed.token;
      const storedAt = new Date(now).toISOString();
      const expiresAt = new Date(now + refreshed.expiresIn * 1000).toISOString();
      await saveToken(env, token, storedAt, expiresAt);
      currentMeta = { ...currentMeta, token_stored_at: storedAt, token_expires_at: expiresAt, token_cipher: "saved" };
    }
  }
  const media = await fetchMedia(token, fetchImpl);
  if (!media.ok) return { ok: false, error: media.error };
  const parsed = postsFromMedia(media.body);
  if (!parsed.ok) return parsed;
  if (!persisted && !exchangeFailed) {
    const storedAt = new Date(now).toISOString();
    await saveToken(env, token, storedAt, new Date(now + ASSUMED_TTL_MS).toISOString());
  }
  return { ok: true, posts: parsed.posts };
}

async function loadPins(pins, fetchImpl) {
  const settled = await Promise.all(pins.map(async (url) => {
    const result = await fetchOembed(url, fetchImpl);
    return result.ok ? { ok: true, post: result.post } : { ok: false };
  }));
  return {
    posts: settled.filter((item) => item.ok).map((item) => item.post),
    failed: settled.filter((item) => !item.ok).length,
  };
}

function resultOf(fields) {
  return {
    ok: fields.ok,
    storage_ready: true,
    kept_previous: Boolean(fields.kept_previous),
    configured: Boolean(fields.configured),
    mode: fields.mode,
    posts: fields.posts,
    pins: fields.pins || [],
    token_expires_at: fields.token_expires_at || null,
    last_ok_at: fields.last_ok_at || null,
    last_error: fields.last_error || null,
    message: fields.message,
  };
}

export async function refreshInstagram(env, fetchImpl = globalThis.fetch, now = Date.now()) {
  const attemptAt = new Date(now).toISOString();
  let meta;
  try {
    meta = await readMeta(env);
    await env.DB.prepare(
      `INSERT INTO instagram_meta (id, last_attempt_at) VALUES (1, ?1)
       ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`
    ).bind(attemptAt).run();
  } catch (err) {
    console.error(JSON.stringify({ msg: "instagram_meta_failed", error: err instanceof Error ? err.message : "error" }));
    return storageResult();
  }

  let pins = [];
  try {
    pins = await listPins(env);
  } catch (err) {
    console.error(JSON.stringify({ msg: "instagram_pins_failed", error: err instanceof Error ? err.message : "error" }));
    return storageResult();
  }

  const configured = Boolean(tokenSecret(env));
  if (!configured && !pins.length && meta?.mode === "unconfigured" && Number(meta.item_count) === 0 && !meta.last_error) {
    return resultOf({
      ok: true,
      configured: false,
      mode: "unconfigured",
      posts: 0,
      pins: [],
      last_ok_at: meta.last_ok_at,
      message: "Instagram isn't connected yet. The homepage still links to @hilltopneighborhooddenver.",
    });
  }
  if (!configured && !pins.length) {
    try {
      await replacePosts(env, [], attemptAt);
      await markMeta(env, { last_ok_at: attemptAt, last_attempt_at: attemptAt, last_error: null, item_count: 0, mode: "unconfigured" });
    } catch (err) {
      console.error(JSON.stringify({ msg: "instagram_clear_failed", error: err instanceof Error ? err.message : "error" }));
      return storageResult();
    }
    return resultOf({
      ok: true,
      configured: false,
      mode: "unconfigured",
      posts: 0,
      pins: [],
      last_ok_at: attemptAt,
      message: "Instagram isn't connected yet. The homepage still links to @hilltopneighborhooddenver.",
    });
  }

  if (configured) {
    let graph;
    try {
      graph = await loadGraph(env, meta, fetchImpl, now);
    } catch (err) {
      console.error(JSON.stringify({ msg: "instagram_graph_failed", error: err instanceof Error ? err.message : "error" }));
      graph = { ok: false, error: "fetch_failed" };
    }
    if (graph.ok) {
      try {
        await replacePosts(env, graph.posts, attemptAt);
        await markMeta(env, {
          last_ok_at: attemptAt,
          last_attempt_at: attemptAt,
          last_error: null,
          item_count: graph.posts.length,
          mode: "graph",
        });
      } catch (err) {
        console.error(JSON.stringify({ msg: "instagram_save_failed", error: err instanceof Error ? err.message : "error" }));
        return resultOf({
          ok: false,
          kept_previous: true,
          configured: true,
          mode: "graph",
          posts: await countPosts(env).catch(() => 0),
          pins,
          last_error: "save_failed",
          message: "Instagram was read but the posts couldn't be saved. The last good posts are still in place.",
        });
      }
      const savedMeta = await readMeta(env).catch(() => null);
      return resultOf({
        ok: true,
        configured: true,
        mode: "graph",
        posts: graph.posts.length,
        pins,
        token_expires_at: savedMeta?.token_expires_at || null,
        last_ok_at: attemptAt,
        message: graph.posts.length ? "Recent Instagram posts updated." : "Instagram is connected, and the account has no posts yet.",
      });
    }
    console.log(JSON.stringify({ msg: "instagram_graph_failed", error: graph.error || "fetch_failed" }));
    const existing = await countPosts(env).catch(() => 0);
    if (existing > 0 || !pins.length) {
      await markMeta(env, {
        last_ok_at: meta?.last_ok_at || null,
        last_attempt_at: attemptAt,
        last_error: graph.error || "fetch_failed",
        item_count: existing,
        mode: existing > 0 ? (meta?.mode || "graph") : "graph",
      }).catch(() => {});
      return resultOf({
        ok: false,
        kept_previous: existing > 0,
        configured: true,
        mode: existing > 0 ? (meta?.mode || "graph") : "graph",
        posts: existing,
        pins,
        token_expires_at: meta?.token_expires_at || null,
        last_ok_at: meta?.last_ok_at || null,
        last_error: graph.error || "fetch_failed",
        message: existing > 0
          ? "Instagram didn't load. The last good posts are still in place."
          : "Instagram didn't load. The homepage still links to @hilltopneighborhooddenver.",
      });
    }
  }

  const loaded = await loadPins(pins, fetchImpl);
  if (!loaded.posts.length) {
    const existing = await countPosts(env).catch(() => 0);
    await markMeta(env, {
      last_ok_at: meta?.last_ok_at || null,
      last_attempt_at: attemptAt,
      last_error: "instagram_oembed_failed",
      item_count: existing,
      mode: existing > 0 ? (meta?.mode || "pins") : "pins",
    }).catch(() => {});
    return resultOf({
      ok: false,
      kept_previous: existing > 0,
      configured,
      mode: existing > 0 ? (meta?.mode || "pins") : "pins",
      posts: existing,
      pins,
      last_ok_at: meta?.last_ok_at || null,
      last_error: "instagram_oembed_failed",
      message: "Those Instagram links couldn't be embedded. The homepage still links to @hilltopneighborhooddenver.",
    });
  }

  const pinError = loaded.failed > 0 ? "instagram_pin_incomplete" : null;
  try {
    await replacePosts(env, loaded.posts, attemptAt);
    await markMeta(env, {
      last_ok_at: attemptAt,
      last_attempt_at: attemptAt,
      last_error: pinError,
      item_count: loaded.posts.length,
      mode: "pins",
    });
  } catch (err) {
    console.error(JSON.stringify({ msg: "instagram_save_failed", error: err instanceof Error ? err.message : "error" }));
    return resultOf({
      ok: false,
      kept_previous: true,
      configured,
      mode: "pins",
      posts: await countPosts(env).catch(() => 0),
      pins,
      last_error: "save_failed",
      message: "Pinned posts were read but couldn't be saved.",
    });
  }
  return resultOf({
    ok: true,
    configured,
    mode: "pins",
    posts: loaded.posts.length,
    pins,
    last_ok_at: attemptAt,
    last_error: pinError,
    message: pinError
      ? "Some pinned posts couldn't be embedded. The ones that worked are saved."
      : "Pinned Instagram posts updated.",
  });
}

export async function instagramNeedsSeed(env, now = Date.now()) {
  if (!tokenSecret(env) && !(await listPins(env)).length) return false;
  const row = await readMeta(env);
  if (row?.last_ok_at) return false;
  if (!row?.last_attempt_at) return true;
  const attempted = Date.parse(row.last_attempt_at);
  if (Number.isNaN(attempted)) return true;
  return now - attempted > SEED_BACKOFF_MS;
}

async function readJson(request) {
  try {
    const data = await request.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, message: "Send a JSON object with a urls list." };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, message: "That body wasn't JSON." };
  }
}

async function statusBody(env) {
  const meta = await readMeta(env);
  const pins = await listPins(env);
  const posts = await countPosts(env);
  const configured = Boolean(tokenSecret(env));
  let message = "Instagram isn't connected yet.";
  if (configured) message = "Instagram is connected.";
  else if (pins.length) message = "Showing pinned posts until an access token is set.";
  return {
    ok: true,
    storage_ready: true,
    configured,
    mode: meta?.mode || "unconfigured",
    posts,
    pins,
    token_saved: Boolean(meta?.token_cipher),
    token_expires_at: meta?.token_expires_at || null,
    last_ok_at: meta?.last_ok_at || null,
    last_error: meta?.last_error || null,
    message,
  };
}

export async function adminInstagram(request, env, url) {
  const path = url.pathname;
  if (path !== "/api/admin/instagram" && path !== "/api/admin/instagram/refresh" && path !== "/api/admin/instagram/pins") {
    return { status: 404, body: { ok: false, message: "Not found" } };
  }
  if (path === "/api/admin/instagram" && request.method === "GET") {
    try {
      return { status: 200, body: await statusBody(env) };
    } catch (err) {
      console.error(JSON.stringify({ msg: "instagram_status_failed", error: err instanceof Error ? err.message : "error" }));
      return { status: 503, body: storageResult() };
    }
  }
  if (path === "/api/admin/instagram/refresh" && request.method === "POST") {
    const result = await refreshInstagram(env);
    return { status: result.storage_ready === false ? 503 : 200, body: result };
  }
  if (path === "/api/admin/instagram/pins" && (request.method === "PUT" || request.method === "POST")) {
    const parsed = await readJson(request);
    if (!parsed.ok) return { status: 400, body: { ok: false, message: parsed.message } };
    const pins = parsePinUrls(parsed.data);
    if (!pins.ok) return { status: 400, body: { ok: false, message: pins.message } };
    try {
      const statements = [env.DB.prepare("DELETE FROM instagram_pins")];
      pins.urls.forEach((pin, position) => {
        statements.push(env.DB.prepare("INSERT INTO instagram_pins (position, url) VALUES (?1, ?2)").bind(position, pin));
      });
      await env.DB.batch(statements);
    } catch (err) {
      console.error(JSON.stringify({ msg: "instagram_pins_failed", error: err instanceof Error ? err.message : "error" }));
      return { status: 503, body: storageResult() };
    }
    const result = await refreshInstagram(env);
    return { status: result.storage_ready === false ? 503 : 200, body: result };
  }
  return { status: 405, body: { ok: false, message: "That method isn't supported here." } };
}
