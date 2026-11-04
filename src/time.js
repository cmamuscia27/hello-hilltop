// America/Denver wall times. Stored instants are UTC ISO strings so SQLite can
// compare them. starts_local / ends_local are the Denver clock times we show
// and use to tell two events apart.

const HAS_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/i;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

const pad = (n) => String(n).padStart(2, "0");

export function denverParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function localStamp(date) {
  const parts = denverParts(date);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

// Convert a Denver wall clock to a UTC Date. Rejects a time that doesn't exist
// (the missing hour when the clocks spring forward) by checking the round trip.
export function denverWallToUtc(year, month, day, hour, minute, second = 0) {
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 2; i++) {
    const shown = denverParts(new Date(utc));
    const shownAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second);
    const intended = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = shownAsUtc - intended;
    if (diff === 0) break;
    utc -= diff;
  }
  return new Date(utc);
}

export function parseDenverInput(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 40) return null;
  if (HAS_ZONE.test(text)) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return null;
    return { utc: date, local: localStamp(date) };
  }
  const match = text.match(LOCAL_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] || 0);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const utc = denverWallToUtc(year, month, day, hour, minute, second);
  const local = `${pad(year)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
  if (localStamp(utc) !== local) return null;
  return { utc, local };
}

export function visibleUntil(startUtc, endUtc) {
  if (endUtc) return endUtc.toISOString();
  const parts = denverParts(startUtc);
  return denverWallToUtc(parts.year, parts.month, parts.day, 23, 59, 59).toISOString();
}

export function formatEventWhen(startIso, endIso) {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "";
  const dateFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    hour: "numeric",
    minute: "2-digit",
  });
  const startDate = dateFmt.format(start);
  const startTime = timeFmt.format(start);
  if (!endIso) return `${startDate} · ${startTime}`;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return `${startDate} · ${startTime}`;
  const endDate = dateFmt.format(end);
  const endTime = timeFmt.format(end);
  if (startDate === endDate) return `${startDate} · ${startTime}–${endTime}`;
  return `${startDate} · ${startTime} – ${endDate} · ${endTime}`;
}

export function formatNewsDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Denver",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
