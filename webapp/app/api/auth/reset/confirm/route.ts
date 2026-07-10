import { Q } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { err } from "@/lib/http";
import { passwordError } from "@/lib/password";

export const dynamic = "force-dynamic";

/** Confirm a password reset: single-use token + new password. Invalidates ALL sessions. */
export async function POST(req: Request) {
  const { token, next } = (await req.json().catch(() => ({}))) as { token?: string; next?: string };
  if (!token) return err("token required");
  const pwErr = passwordError(next ?? "");
  if (pwErr) return err(pwErr);

  const userId = Q.consumePasswordReset(sha256(token));
  if (!userId) return err("invalid or expired reset token", 401);

  await Q.setPassword(userId, next!);
  Q.deleteSessionsByUser(userId); // force re-login everywhere after a reset
  return Response.json({ ok: true });
}
