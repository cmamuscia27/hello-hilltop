const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export function cleanMultiline(value, max) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

export function safeUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2000) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    return url.href;
  } catch {
    return "";
  }
}

// Accepts https://example.com and a bare example.com. Rejects javascript: and other schemes.
export function normalizeHttpUrl(value) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!text || text.length > 2000 || /[\s<>]/.test(text)) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^https?:/i.test(text)) return "";
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  return safeUrl(withScheme);
}
