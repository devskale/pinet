import { ctxFor, isManager } from "@/lib/access";
import { Q } from "@/lib/db";
import { err } from "@/lib/http";
import { sha256 } from "@/lib/crypto";
import { newToken } from "@/lib/session";

export const dynamic = "force-dynamic";
const ROLES = ["admin", "member"];

/** Create a shareable, single-use invite link (token hashed at rest; raw token returned once). */
export async function POST(req: Request, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  if (!isManager(c.role)) return err("only owners/admins can create invites", 403);
  const { role } = (await req.json().catch(() => ({}))) as { role?: string };
  const r = role && ROLES.includes(role) ? role : "member";
  const token = newToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  Q.createInvite(c.project.id, r, sha256(token), expiresAt);
  return Response.json({ token, role: r, expires_at: expiresAt });
}
