import { ctxFor } from "@/lib/access";
import { err } from "@/lib/http";
import { create, list } from "@/lib/issues";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  return Response.json({ project: c.project.name, issues: list(c.project.name) });
}

export async function POST(req: Request, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  if (!text || !text.trim()) return err("text required");
  return Response.json({ issue: create(c.project.name, c.user.name, text) });
}
