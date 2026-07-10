import { Q } from "@/lib/db";
import { create, list } from "@/lib/issues";
import { err } from "@/lib/http";
import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ project: string }> }) {
  const user = userFromRequest(req);
  if (!user) return err("not authenticated", 401);
  const { project } = await params;
  if (!Q.projectByName(decodeURIComponent(project))) return err("no such project", 404);
  return Response.json({ project, issues: list(decodeURIComponent(project)) });
}

export async function POST(req: Request, { params }: { params: Promise<{ project: string }> }) {
  const user = userFromRequest(req);
  if (!user) return err("not authenticated", 401);
  const { project } = await params;
  const p = decodeURIComponent(project);
  if (!Q.projectByName(p)) return err("no such project", 404);
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  if (!text || !text.trim()) return err("text required");
  return Response.json({ issue: create(p, user.name, text) });
}
