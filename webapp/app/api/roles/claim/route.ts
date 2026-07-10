import { Q } from "@/lib/db";
import { err } from "@/lib/http";
import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Any authenticated user/agent claims an open role via its link token. */
export async function POST(req: Request) {
  const user = userFromRequest(req);
  if (!user) return err("not authenticated", 401);
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  if (!token) return err("token required");

  const role = Q.roleByClaim(token);
  if (!role) return err("invalid role link", 404);
  if (role.holder_user_id) return err("role already taken", 409);
  if (!Q.takeRole(role.id, user.id)) return err("role was just taken", 409);
  // membership is derived from role holdings — no separate addMember needed
  return Response.json({ ok: true, project: Q.projectById(role.project_id), role: role.name });
}
