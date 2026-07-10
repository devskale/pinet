import { ctxFor } from "@/lib/access";
import { err } from "@/lib/http";
import { find, move, remove, setText, VALID_STATES } from "@/lib/issues";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ project: string; slug: string }> }) {
  const { project, slug } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  const it = find(c.project.name, slug);
  if (!it) return err("not found", 404);
  return Response.json({ issue: it });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ project: string; slug: string }> }) {
  const { project, slug } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  const { state, text } = (await req.json().catch(() => ({}))) as { state?: string; text?: string };
  let it = find(c.project.name, slug);
  if (!it) return err("not found", 404);
  if (typeof text === "string") it = setText(c.project.name, slug, text);
  if (state) {
    if (!VALID_STATES.has(state)) return err("invalid state");
    it = move(c.project.name, slug, state);
  }
  return Response.json({ issue: it });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ project: string; slug: string }> }) {
  const { project, slug } = await params;
  const c = ctxFor(req, decodeURIComponent(project));
  if (c instanceof Response) return c;
  try {
    remove(c.project.name, slug);
    return Response.json({ ok: true });
  } catch (e) {
    return err((e as Error).message, 404);
  }
}
