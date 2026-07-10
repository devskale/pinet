import { boardContext, findIssue } from "@/lib/issues";
import { err } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const ctx = await boardContext(req);
  if ("res" in ctx) return ctx.res;
  const { slug } = await params;
  const issue = findIssue(ctx.project.name, slug);
  if (!issue) return err("not found", 404);
  return Response.json({ issue });
}
