import { Q } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { err } from "@/lib/http";
import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Accept an invite: authed user joins the project at the invite's role. Single-use. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const user = userFromRequest(req);
  if (!user) return err("not authenticated", 401);
  const { token } = await params;
  const invite = Q.consumeInvite(sha256(token));
  if (!invite) return err("invalid or expired invite", 404);
  Q.addMember(invite.project_id, user.id, invite.role);
  const project = Q.projectById(invite.project_id);
  return Response.json({ ok: true, project });
}
