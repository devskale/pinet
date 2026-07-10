import { ctxFor, isManager } from "@/lib/access";
import { Q } from "@/lib/db";
import { err } from "@/lib/http";
import { newToken } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  const roles = Q.rolesOf(c.project.id).map((r) => ({
    name: r.name,
    holder: r.holder_user_id ? Q.userById(r.holder_user_id)?.name ?? null : null,
    claim_token: r.claim_token,
  }));
  return Response.json({ roles });
}

export async function POST(req: Request, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  if (!isManager(c.role)) return err("only owners/admins can create roles", 403);
  const { name } = (await req.json().catch(() => ({}))) as { name?: string };
  if (!name || !name.trim()) return err("name required");
  const role = Q.createRole(c.project.id, name.trim(), newToken());
  if (!role) return err("role already exists", 409);
  return Response.json({ role });
}
