import { addComment, boardContext } from "@/lib/issues";
import { err } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ctx = await boardContext(req);
  if ("res" in ctx) return ctx.res;
  const { slug } = await params;
  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  if (!text) return err("text required");
  try {
    return Response.json({ issue: addComment(ctx.project.name, slug, ctx.user.handle, text) });
  } catch (e) {
    return err((e as Error).message);
  }
}
