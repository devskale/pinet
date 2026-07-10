import { ctxFor, isManager } from "@/lib/access";
import { Q } from "@/lib/db";
import { err } from "@/lib/http";

export const dynamic = "force-dynamic";
const ROLES = ["owner", "admin", "member", "agent"];

export async function PATCH(req: Request, { params }: { params: Promise<{ project: string; member: string }> }) {
  const { project, member } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  if (!isManager(c.role)) return err("only owners/admins can change roles", 403);
  const { role } = (await req.json().catch(() => ({}))) as { role?: string };
  if (!role || !ROLES.includes(role)) return err("invalid role");
  const target = Q.userByName(member);
  if (!target) return err("no such member", 404);
  if (Q.memberRole(c.project.id, target.id)?.role === "owner" && role !== "owner")
    return err("demote ownership via transfer, not directly", 403);
  Q.setMemberRole(c.project.id, target.id, role);
  return Response.json({ members: Q.membersOf(c.project.id) });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ project: string; member: string }> }) {
  const { project, member } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  if (!isManager(c.role)) return err("only owners/admins can remove members", 403);
  const target = Q.userByName(member);
  if (!target) return err("no such member", 404);
  if (Q.memberRole(c.project.id, target.id)?.role === "owner") return err("cannot remove the owner", 403);
  Q.removeMember(c.project.id, target.id);
  return Response.json({ members: Q.membersOf(c.project.id) });
}
