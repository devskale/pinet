import { boardContext, moveIssue } from "@/lib/issues";
import { err } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ctx = await boardContext(req);
  if ("res" in ctx) return ctx.res;
  const { slug } = await params;
  const { state } = (await req.json().catch(() => ({}))) as { state?: string };
  if (!state) return err("state required");
  try {
    return Response.json({ issue: moveIssue(ctx.project.name, slug, state) });
  } catch (e) {
    return err((e as Error).message);
  }
}
