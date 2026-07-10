import { Q } from "@/lib/db";
import { find, move, remove, setText, VALID_STATES } from "@/lib/issues";
import { err } from "@/lib/http";
import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

async function base(req: Request, params: Promise<{ project: string; slug: string }>) {
  const user = userFromRequest(req);
  if (!user) return { err: err("not authenticated", 401) };
  const { project, slug } = await params;
  const p = decodeURIComponent(project);
  if (!Q.projectByName(p)) return { err: err("no such project", 404) };
  return { user, p, slug };
}

export async function GET(req: Request, { params }: { params: Promise<{ project: string; slug: string }> }) {
  const r = await base(req, params);
  if ("err" in r) return r.err;
  const it = find(r.p, r.slug);
  if (!it) return err("not found", 404);
  return Response.json({ issue: it });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ project: string; slug: string }> }) {
  const r = await base(req, params);
  if ("err" in r) return r.err;
  const { state, text } = (await req.json().catch(() => ({}))) as { state?: string; text?: string };
  let it = find(r.p, r.slug);
  if (!it) return err("not found", 404);
  if (typeof text === "string") it = setText(r.p, r.slug, text);
  if (state) {
    if (!VALID_STATES.has(state)) return err("invalid state");
    it = move(r.p, r.slug, state);
  }
  return Response.json({ issue: it });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ project: string; slug: string }> }) {
  const r = await base(req, params);
  if ("err" in r) return r.err;
  try {
    remove(r.p, r.slug);
    return Response.json({ ok: true });
  } catch (e) {
    return err((e as Error).message, 404);
  }
}
