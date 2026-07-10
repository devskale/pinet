import { Q } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { ipFromReq, rateLimit } from "@/lib/ratelimit";
import { newToken } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Request a password reset. No email in this self-hosted app, so the raw token
 * is returned (for local/operator use). PROD: deliver via email instead of returning it.
 * Responds 200 regardless of whether the name exists (avoid account enumeration).
 */
export async function POST(req: Request) {
  const { name } = (await req.json().catch(() => ({}))) as { name?: string };
  if (!rateLimit(`reset:${ipFromReq(req)}`, 5, 15 * 60_000)) return Response.json({ ok: true });

  const row = name ? Q.userByName(name) : undefined;
  if (row) {
    const token = newToken();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    Q.addPasswordReset(row.id, sha256(token), expiresAt);
    return Response.json({ ok: true, reset_token: token });
  }
  return Response.json({ ok: true });
}
