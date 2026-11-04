import { listUpcoming, renderEventList } from "./events.js";
import { listRecentNews, newsNeedsSeed, refreshNews, renderNewsList, selectNews } from "./news.js";

let seedInFlight = false;

function fill(html, token, replacement) {
  const start = `<!--${token}_START-->`;
  const end = `<!--${token}_END-->`;
  const startAt = html.indexOf(start);
  const endAt = html.indexOf(end);
  if (startAt === -1 || endAt === -1 || endAt < startAt) return html;
  return html.slice(0, startAt) + replacement + html.slice(endAt + end.length);
}

async function seedNews(env) {
  if (seedInFlight) return;
  seedInFlight = true;
  try {
    const result = await refreshNews(env);
    console.log(JSON.stringify({
      msg: "news_seed",
      ok: result.ok,
      kept_previous: result.kept_previous,
      stored: result.stored ?? null,
    }));
  } catch (err) {
    console.error(JSON.stringify({ msg: "news_seed_failed", error: err instanceof Error ? err.message : "error" }));
  } finally {
    seedInFlight = false;
  }
}

// Fills the hood markers from D1. The fallback copy between the markers stays
// put if a query fails, so a missing migration never takes the homepage down.
export async function hoodHtml(html, env, ctx) {
  if (!html.includes("<!--HOOD_")) return html;
  let next = html;

  if (html.includes("<!--HOOD_EVENTS_START-->") || html.includes("<!--HOOD_EVENTS_PAGE_START-->")) {
    try {
      const events = await listUpcoming(env);
      if (html.includes("<!--HOOD_EVENTS_START-->")) next = fill(next, "HOOD_EVENTS", renderEventList(events, { limit: 6, ideaHref: "#ideas" }));
      if (html.includes("<!--HOOD_EVENTS_PAGE_START-->")) next = fill(next, "HOOD_EVENTS_PAGE", renderEventList(events, { ideaHref: "/#ideas" }));
    } catch (err) {
      console.error(JSON.stringify({ msg: "events_render_failed", error: err instanceof Error ? err.message : "error" }));
    }
  }

  if (html.includes("<!--HOOD_NEWS_START-->")) {
    try {
      const rows = await listRecentNews(env);
      next = fill(next, "HOOD_NEWS", renderNewsList(selectNews(rows)));
      if (typeof ctx?.waitUntil === "function" && await newsNeedsSeed(env)) ctx.waitUntil(seedNews(env));
    } catch (err) {
      console.error(JSON.stringify({ msg: "news_render_failed", error: err instanceof Error ? err.message : "error" }));
    }
  }

  return next;
}
