import { ctxFor, isManager } from "@/lib/access";
import { Q } from "@/lib/db";
import { err } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, { params }: { params: Promise<{ project: string; role: string }> }) {
  const { project, role } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  if (!isManager(c.role)) return err("only owners/admins can delete roles", 403);
  Q.deleteRole(c.project.id, decodeURIComponent(role));
  return Response.json({ ok: true });
}

/** Clear a role's holder (unassign the person, keep the slot open). */
export async function PATCH(req: Request, { params }: { params: Promise<{ project: string; role: string }> }) {
  const { project, role } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  if (!isManager(c.role)) return err("only owners/admins can unassign", 403);
  Q.clearRoleHolder(c.project.id, decodeURIComponent(role));
  return Response.json({ ok: true });
}
