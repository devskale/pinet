import { Q, verifyPassword } from "@/lib/db";
import { err } from "@/lib/http";
import { passwordError } from "@/lib/password";
import { tokenFromRequest, userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Change password while logged in. Requires current password; drops other sessions. */
export async function POST(req: Request) {
  const user = userFromRequest(req);
  if (!user) return err("not authenticated", 401);
  const { current, next } = (await req.json().catch(() => ({}))) as { current?: string; next?: string };

  const row = Q.userByName(user.name);
  if (!row || !(await verifyPassword(current ?? "", row.password_hash))) return err("current password is incorrect", 403);
  const pwErr = passwordError(next ?? "");
  if (pwErr) return err(pwErr);

  await Q.setPassword(user.id, next!);
  // keep this session, kill the rest
  Q.deleteSessionsByUser(user.id, tokenFromRequest(req));
  return Response.json({ ok: true });
}
