// Same checks the Idea Box uses. Split so a public contact line can mention a
// website while a description still can't be a link or an SEO pitch.

const PITCH_RE =
  /\bseo\b|search[ -]?engines?|\brankings?\b|index(?:ing)? your (?:site|website|page|url)|\bback-?links?\b|google index/i;

const LINK_RE =
  /https?:\/\/|www\.|\b[\w-]+\.(?:com|net|org|info|biz|io|xyz|co|us|link|click|site|online)\b/i;

function normalized(text) {
  return String(text || "").normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/g, "");
}

export function looksLikeSeoPitch(text) {
  return PITCH_RE.test(normalized(text));
}

export function looksLikePitch(text) {
  const value = normalized(text);
  return PITCH_RE.test(value) || LINK_RE.test(value);
}
