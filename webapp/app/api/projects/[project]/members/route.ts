import { ctxFor, isManager } from "@/lib/access";
import { Q } from "@/lib/db";
import { err } from "@/lib/http";

export const dynamic = "force-dynamic";
const ROLES = ["owner", "admin", "member", "agent"];

export async function GET(req: Request, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  return Response.json({ members: Q.membersOf(c.project.id) });
}

export async function POST(req: Request, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  if (!isManager(c.role)) return err("only owners/admins can add members", 403);
  const { name, role } = (await req.json().catch(() => ({}))) as { name?: string; role?: string };
  const u = name ? Q.userByName(name) : undefined;
  if (!u) return err("no such user (they must register first)", 404);
  if (role && !ROLES.includes(role)) return err("invalid role");
  Q.addMember(c.project.id, u.id, role || "member");
  return Response.json({ members: Q.membersOf(c.project.id) });
}
