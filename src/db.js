export function missingTable(err) {
  return /no such table/i.test(String(err && err.message || err));
}

export function changesOf(result) {
  return result?.meta?.changes ?? result?.changes ?? 0;
}

export async function readJson(request, max = 20000) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) return { ok: false, message: "Send a JSON body." };
  const length = Number(request.headers.get("content-length") || 0);
  if (length > max) return { ok: false, message: "That one's too big." };
  try {
    const data = await request.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, message: "Send a JSON object." };
    return { ok: true, data };
  } catch {
    return { ok: false, message: "That JSON didn't parse." };
  }
}

// Approve and reject can be called with an empty body.
export async function readOptionalJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  const type = request.headers.get("content-type") || "";
  if (length === 0 || !type) return { ok: true, data: {} };
  return readJson(request);
}
