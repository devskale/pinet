import { ctxFor, isManager } from "@/lib/access";
import { Q } from "@/lib/db";
import { err } from "@/lib/http";

export const dynamic = "force-dynamic";

/** Manager assigns a registered user to a role slot by name. */
export async function POST(req: Request, { params }: { params: Promise<{ project: string; role: string }> }) {
  const { project, role } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  if (!isManager(c.role)) return err("only owners/admins can assign roles", 403);
  const { name } = (await req.json().catch(() => ({}))) as { name?: string };
  const u = name ? Q.userByName(name) : undefined;
  if (!u) return err("no such user (they must register first)", 404);
  Q.fillRole(c.project.id, decodeURIComponent(role), u.id);
  return Response.json({ ok: true });
}
