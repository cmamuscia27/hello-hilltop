import { esc, safeUrl } from "./escape.js";
import { formatNewsDate } from "./time.js";

// Page views read D1 only. These feeds are fetched by the cron, the admin
// refresh endpoint, and a one-time background seed when the table is still empty.
export const FEEDS = [
  { id: "denverite", name: "Denverite", url: "https://denverite.com/feed/", denverSource: true, fallback: true },
  { id: "cherry-creek-north", name: "Cherry Creek North", url: "https://cherrycreeknorth.com/feed/", denverSource: true, fallback: false },
  { id: "9news", name: "9NEWS", url: "https://www.9news.com/feeds/syndication/rss/news/local", denverSource: true, fallback: false },
  { id: "denver7", name: "Denver7", url: "https://www.denver7.com/news/local-news.rss", denverSource: true, fallback: false },
  { id: "google", name: "Google News", url: "https://news.google.com/rss/search?q=%22Hilltop%22+Denver+OR+%22Cherry+Creek%22+Denver&hl=en-US&gl=US&ceid=US:en", denverSource: false, fallback: false },
];

const MATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const FILL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const SHOW_LIMIT = 6;
const KEEP_DAYS = 45;
const MAX_BYTES = 800_000;

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
};

// Crime and traffic, plus close cousins. "cardiac arrest" is a health story.
const CRIME_RE = /\b(shootings?|shots?|killed|killings?|homicides?|murders?|murdered|manslaughter|crash(?:es)?|crashed|collisions?|arrested|arrests|stabbings?|stabbed|robber(?:y|ies)|burglar(?:y|ies)|assault(?:s|ed)?|carjack(?:ing|ed|ings)?|fatal(?:ity|ities)?|slain|gunman|gunmen|shooters?|hit-and-run|hit and run|duis?|dwis?|wrecks?|wrecked|pedestrian struck|deadly|road rage|pile-?ups?)\b/i;

const STRONG = [
  [/\bCherry Creek Schools\b/i, "cherry creek schools"],
  [/\bCherry Creek\b/i, "cherry creek"],
  [/\bCrestmoor\b/i, "crestmoor"],
  [/\bLowry\b/i, "lowry"],
  [/\bCongress Park\b/i, "congress park"],
  [/\bCranmer Park\b/i, "cranmer park"],
  [/\bGraland\b/i, "graland"],
  [/\bEast High\b/i, "east high"],
  [/\bColorado\s+Blvd\.?\b|\bColorado\s+Boulevard\b/i, "colorado blvd"],
  [/\b6th\s+Ave(?:nue)?\b|\bSixth\s+Ave(?:nue)?\b/i, "6th ave"],
  [/\bSteck\b/i, "steck"],
];

const WEAK = [
  [/\bGlendale\b/i, "glendale"],
  [/\bHale\b/i, "hale"],
  [/\bMontclair\b/i, "montclair"],
  [/\bHolly\b/i, "holly"],
  [/\bMonaco\b/i, "monaco"],
  [/\bAlameda\b/i, "alameda"],
];

const OTHER_PLACE_RE = /\b(Tacoma|Seattle|Spokane|Columbus|Cleveland|Cincinnati|Ohio|New Jersey|California|San Francisco|Arizona|Phoenix|Tucson|Utah|Salt Lake|Montana|Pennsylvania|Pittsburgh|Philadelphia|Texas|Dallas|Houston|New York|Brooklyn|Manhattan|Illinois|Chicago|Michigan|Detroit|Florida|Miami|Orlando|Georgia|Atlanta|Oregon|Nevada|Las Vegas|Maryland|Baltimore|Massachusetts|Boston|Indiana|Indianapolis|Missouri|Minneapolis|Wisconsin|Milwaukee|Nashville|Kentucky|Alabama|Louisiana|New Orleans|Oklahoma|Iowa|Nebraska|New Mexico|Albuquerque|Idaho|Hawaii|Alaska|Connecticut|Colorado Springs|Boulder|Fort Collins|Pueblo|Grand Junction|Aspen|Arvada|Westminster|Thornton|Broomfield|Highlands Ranch|Castle Rock|Longmont|Greeley|Billings|Boise|Anchorage)\b/i;
const OTHER_STATE_RE = /,\s*(AL|AK|AZ|AR|CA|CT|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\b/;
const HILLTOP_DENY = /\bHilltop Mall\b|\bHilltop,\s*Washington\b/i;
const MONACO_COUNTRY = /\b(Grand Prix|Monte Carlo|Prince Albert|Princess of Monaco)\b/i;

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, ent) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return all;
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent) ? NAMED_ENTITIES[ent] : all;
  });
}

function plain(value) {
  let text = String(value ?? "");
  for (let i = 0; i < 2; i++) {
    const next = decodeEntities(text);
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textTag(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[^>]*>([\\s\\S]*?)</${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "i");
    const match = block.match(re);
    if (!match) continue;
    const text = plain(match[1]);
    if (text) return text;
  }
  return "";
}

function attr(attrs, name) {
  const match = String(attrs || "").match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return match ? decodeEntities(match[2] ?? match[3] ?? "") : "";
}

function linksFrom(block) {
  const cut = block.search(/<(description|content:encoded|summary|content)\b/i);
  const head = cut === -1 ? block : block.slice(0, cut);
  const found = [];
  const re = /<link\b([^>]*?)(?:\/>|>([\s\S]*?)<\/link>)/gi;
  for (const match of head.matchAll(re)) {
    const href = attr(match[1], "href") || plain(match[2] || "");
    if (href.startsWith("http://") || href.startsWith("https://")) found.push({ href, rel: attr(match[1], "rel") });
  }
  const alternate = found.find((link) => /alternate/i.test(link.rel));
  return (alternate || found[0] || {}).href || "";
}

function categoriesOf(block) {
  return [...block.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map((match) => plain(match[1])).filter(Boolean);
}

export function titleKey(title) {
  let text = String(title || "").normalize("NFKC").toLowerCase().replace(/[’‘]/g, "'");
  text = text.replace(/\s+[-|–—]\s+[^-|–—]{2,60}$/u, "");
  text = text.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return text.slice(0, 180);
}

export function parseFeed(xml) {
  if (typeof xml !== "string" || !/<(rss|feed|item|entry)\b/i.test(xml)) return [];
  const items = [];
  for (const match of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const block = match[2];
    const title = textTag(block, ["title"]).slice(0, 300);
    const link = linksFrom(block).slice(0, 2000);
    if (!title || !link) continue;
    const publishedRaw = textTag(block, ["pubDate", "published", "updated", "dc:date"]);
    const published = Date.parse(publishedRaw);
    items.push({
      title,
      link,
      description: textTag(block, ["description", "summary", "content"]).slice(0, 1500),
      source_name: textTag(block, ["source"]).slice(0, 80),
      published_at: Number.isNaN(published) ? null : new Date(published).toISOString(),
      categories: categoriesOf(block).slice(0, 12),
    });
  }
  return items;
}

function mentionsDenver(text) {
  return /\bDenver\b/i.test(text);
}

function mentionsOtherPlace(text) {
  return OTHER_PLACE_RE.test(text) || OTHER_STATE_RE.test(text);
}

function hasStrong(text) {
  return STRONG.some(([re]) => re.test(text));
}

export function isCrime(text, categories = []) {
  if (categories.some((category) => /^(traffic|crime|crimes)$/i.test(String(category).trim()))) return true;
  const stripped = String(text || "").replace(/\bcardiac arrest\b/gi, "");
  if (/\barrest\b/i.test(stripped)) return true;
  return CRIME_RE.test(stripped);
}

// "match" stays on the strip. "fallback" is a Denverite item used only when
// fewer than three neighborhood matches exist. "drop" is discarded.
export function classifyItem(item, feed) {
  const link = safeUrl(item.link || "");
  if (!item.title || !link) return { action: "drop", reason: "link" };
  const text = `${item.title}\n${item.description || ""}`;
  if (isCrime(text, item.categories)) return { action: "drop", reason: "crime" };
  const denverWord = mentionsDenver(text);
  const localSource = Boolean(feed.denverSource);
  const other = mentionsOtherPlace(text);
  const veto = other && !denverWord && !localSource;

  if (/\bHilltops?\b/i.test(text)) {
    const denied = HILLTOP_DENY.test(text) && !denverWord && !localSource;
    const blocked = other && !denverWord && !localSource;
    if (!denied && !blocked && (denverWord || localSource || hasStrong(text))) return { action: "match", reason: "hilltop" };
  }
  if (!veto) {
    for (const [re, reason] of STRONG) {
      if (re.test(text)) return { action: "match", reason };
    }
  }
  for (const [re, reason] of WEAK) {
    if (!re.test(text)) continue;
    if (reason === "monaco" && MONACO_COUNTRY.test(text)) continue;
    if ((denverWord || localSource) && !(other && !denverWord)) return { action: "match", reason };
  }
  if (feed.fallback) return { action: "fallback", reason: "denverite" };
  return { action: "drop", reason: "keyword" };
}

function creditName(item, feed) {
  if (feed.id === "google" && item.source_name) return item.source_name.slice(0, 80);
  return feed.name;
}

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = maxBytes - size;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      text += decoder.decode(chunk, { stream: true });
      size += chunk.byteLength;
      if (chunk.byteLength < value.byteLength) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* the body is already done */ }
    text += decoder.decode();
  }
  return text;
}

async function loadFeed(feed, fetchImpl) {
  try {
    const response = await fetchImpl(feed.url, {
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "User-Agent": "HelloHilltopBot/1.0 (+https://hellohilltop.org)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { feed, ok: false, error: `status ${response.status}`, kept: [] };
    const xml = await readLimited(response, MAX_BYTES);
    const parsed = parseFeed(xml);
    if (!parsed.length) return { feed, ok: false, error: "no items", kept: [] };
    const kept = [];
    for (const item of parsed) {
      const classified = classifyItem(item, feed);
      if (classified.action === "drop") continue;
      const link = safeUrl(item.link);
      const key = titleKey(item.title);
      if (!link || !key) continue;
      kept.push({
        title: item.title,
        link,
        source_name: creditName(item, feed),
        published_at: item.published_at,
        title_key: key,
        neighborhood_match: classified.action === "match" ? 1 : 0,
        is_denverite: feed.fallback ? 1 : 0,
      });
    }
    kept.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    const recent = kept.filter((item) => {
      if (!item.published_at) return true;
      const published = Date.parse(item.published_at);
      return !Number.isNaN(published) && published >= cutoff;
    });
    return { feed, ok: true, kept: recent.slice(0, 25) };
  } catch (err) {
    const name = err && err.name;
    const error = name === "TimeoutError" || name === "AbortError" ? "timeout" : "fetch failed";
    console.log(JSON.stringify({ msg: "feed_failed", feed: feed.id, error }));
    return { feed, ok: false, error, kept: [] };
  }
}

function planWrites(results) {
  const byFeed = new Map(results.filter((result) => result.ok).map((result) => [result.feed.id, []]));
  const seenLinks = new Set();
  const seenTitles = new Set();
  const consider = (item) => {
    if (seenLinks.has(item.link) || seenTitles.has(item.title_key)) return false;
    seenLinks.add(item.link);
    seenTitles.add(item.title_key);
    return true;
  };
  const ordered = results.filter((result) => result.ok).sort((a, b) => (a.feed.id === "google") - (b.feed.id === "google"));
  for (const pass of ["match", "fill"]) {
    for (const result of ordered) {
      for (const item of result.kept) {
        const isMatch = item.neighborhood_match === 1;
        if (pass === "match" ? !isMatch : isMatch) continue;
        if (consider(item)) byFeed.get(result.feed.id).push(item);
      }
    }
  }
  for (const [id, items] of byFeed) byFeed.set(id, items.slice(0, 20));
  return byFeed;
}

function publicFeeds(results, savedByFeed) {
  return results.map((result) => ({
    id: result.feed.id,
    name: result.feed.name,
    ok: result.ok,
    saved: savedByFeed?.get(result.feed.id)?.length || 0,
    error: result.ok ? null : result.error,
  }));
}

async function markAttempt(env, attemptAt) {
  await env.DB.prepare(
    `INSERT INTO news_meta (id, last_attempt_at) VALUES (1, ?1)
     ON CONFLICT(id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at`
  ).bind(attemptAt).run();
}

async function markFailure(env, attemptAt, error) {
  try {
    await env.DB.prepare(
      `UPDATE news_meta SET last_attempt_at = ?1, last_error = ?2 WHERE id = 1`
    ).bind(attemptAt, error).run();
  } catch (err) {
    console.error(JSON.stringify({ msg: "news_meta_failed", error: err instanceof Error ? err.message : "error" }));
  }
}

export async function refreshNews(env, fetchImpl = globalThis.fetch) {
  const attemptAt = new Date().toISOString();
  try {
    await markAttempt(env, attemptAt);
  } catch (err) {
    console.error(JSON.stringify({ msg: "news_meta_failed", error: err instanceof Error ? err.message : "error" }));
    return {
      ok: false,
      kept_previous: true,
      storage_ready: false,
      message: "News storage isn't ready yet. Apply the D1 migration.",
      feeds: [],
    };
  }

  const loaded = await Promise.all(FEEDS.map((feed) => loadFeed(feed, fetchImpl)));
  const okFeeds = loaded.filter((result) => result.ok);
  if (!okFeeds.length) {
    await markFailure(env, attemptAt, "all feeds failed");
    return {
      ok: false,
      kept_previous: true,
      message: "Feeds didn't load. The last good list is still in place.",
      feeds: publicFeeds(loaded),
    };
  }

  const planned = planWrites(loaded);
  const fetchedAt = attemptAt;
  const statements = [];
  for (const [feedId, items] of planned) {
    statements.push(env.DB.prepare("DELETE FROM news_items WHERE feed_id = ?1").bind(feedId));
    for (const item of items) {
      statements.push(env.DB.prepare(
        `INSERT INTO news_items (
          title, link, source_name, published_at, feed_id, title_key,
          neighborhood_match, is_denverite, fetched_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      ).bind(
        item.title,
        item.link,
        item.source_name,
        item.published_at,
        feedId,
        item.title_key,
        item.neighborhood_match,
        item.is_denverite,
        fetchedAt,
      ));
    }
  }
  const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  statements.push(env.DB.prepare(
    "DELETE FROM news_items WHERE COALESCE(published_at, fetched_at) < ?1"
  ).bind(cutoff));

  try {
    await env.DB.batch(statements);
  } catch (err) {
    console.error(JSON.stringify({ msg: "news_save_failed", error: err instanceof Error ? err.message : "error" }));
    await markFailure(env, attemptAt, "save failed");
    return {
      ok: false,
      kept_previous: true,
      message: "Feeds were read but the list couldn't be saved. The last good list is still in place.",
      feeds: publicFeeds(loaded, planned),
    };
  }

  let stored = 0;
  let matched = 0;
  try {
    const counts = await env.DB.prepare(
      "SELECT COUNT(*) AS stored, COALESCE(SUM(neighborhood_match), 0) AS matched FROM news_items"
    ).first();
    stored = Number(counts?.stored || 0);
    matched = Number(counts?.matched || 0);
    await env.DB.prepare(
      `UPDATE news_meta SET last_ok_at = ?1, last_attempt_at = ?1, last_error = NULL, item_count = ?2 WHERE id = 1`
    ).bind(attemptAt, stored).run();
  } catch (err) {
    console.error(JSON.stringify({ msg: "news_meta_failed", error: err instanceof Error ? err.message : "error" }));
  }

  return {
    ok: true,
    kept_previous: false,
    stored,
    matched,
    message: "News list updated.",
    feeds: publicFeeds(loaded, planned),
  };
}

export async function listRecentNews(env) {
  const { results } = await env.DB.prepare(
    `SELECT title, link, source_name, published_at, feed_id, title_key, neighborhood_match, is_denverite
     FROM news_items ORDER BY published_at DESC LIMIT 80`
  ).all();
  return results || [];
}

export async function newsNeedsSeed(env, now = Date.now()) {
  const row = await env.DB.prepare("SELECT last_ok_at, last_attempt_at FROM news_meta WHERE id = 1").first();
  if (row?.last_ok_at) return false;
  if (!row?.last_attempt_at) return true;
  const attempted = Date.parse(row.last_attempt_at);
  if (Number.isNaN(attempted)) return true;
  return now - attempted > 15 * 60 * 1000;
}

function fresh(row, now, windowMs) {
  const published = Date.parse(row.published_at || "");
  if (Number.isNaN(published)) return false;
  if (published > now + 24 * 60 * 60 * 1000) return false;
  return now - published <= windowMs;
}

function byDate(a, b) {
  return String(b.published_at || "").localeCompare(String(a.published_at || ""));
}

function better(candidate, current) {
  const candidateGoogle = String(candidate.link || "").includes("news.google.com");
  const currentGoogle = String(current.link || "").includes("news.google.com");
  if (currentGoogle && !candidateGoogle) return true;
  if (candidateGoogle && !currentGoogle) return false;
  return String(candidate.published_at || "") > String(current.published_at || "");
}

export function selectNews(rows, now = Date.now()) {
  const matches = new Map();
  const fillers = new Map();
  for (const row of rows || []) {
    const key = row.title_key || titleKey(row.title || "");
    if (!key) continue;
    const copy = { ...row, title_key: key };
    if (Number(row.neighborhood_match) === 1 && fresh(copy, now, MATCH_WINDOW_MS)) {
      const prev = matches.get(key);
      if (!prev || better(copy, prev)) matches.set(key, copy);
      continue;
    }
    if (Number(row.is_denverite) === 1 && fresh(copy, now, FILL_WINDOW_MS)) {
      const prev = fillers.get(key);
      if (!prev || better(copy, prev)) fillers.set(key, copy);
    }
  }
  const picked = [...matches.values()].sort(byDate).slice(0, SHOW_LIMIT);
  if (picked.length < 3) {
    const keys = new Set(picked.map((row) => row.title_key));
    for (const row of [...fillers.values()].sort(byDate)) {
      if (picked.length >= SHOW_LIMIT) break;
      if (keys.has(row.title_key)) continue;
      keys.add(row.title_key);
      picked.push(row);
    }
  }
  return picked.sort(byDate);
}

export function renderNewsList(items) {
  if (!items?.length) {
    return `<p class="empty-hood news-empty">The neighborhood news is taking a little nap. Check back soon and the latest from around Denver will show up here.</p>`;
  }
  const lis = items.map((item) => {
    const href = safeUrl(item.link || "");
    const title = esc(item.title);
    const when = formatNewsDate(item.published_at);
    const credit = `${esc(item.source_name || "Local news")}${when ? ` · ${esc(when)}` : ""}`;
    const headline = href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${title}<span class="sr-only"> (opens in a new tab)</span></a>`
      : `<span>${title}</span>`;
    return `<li class="news-item">${headline}<p class="news-credit">${credit}</p></li>`;
  }).join("");
  return `<ul class="news-list">${lis}</ul>`;
}
