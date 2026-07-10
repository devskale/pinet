/** Minimal in-memory rate limiter (per-process; fine for single-instance self-hosted). */
const hits = new Map<string, { count: number; reset: number }>();

/** Returns true if the action is allowed under `max` per `windowMs`. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  h.count++;
  return h.count <= max;
}

export function ipFromReq(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return "local";
}
