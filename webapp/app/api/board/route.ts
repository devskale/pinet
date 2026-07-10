import { boardContext, listIssues } from "@/lib/issues";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ctx = await boardContext(req);
  if ("res" in ctx) return ctx.res;
  const sub = new URL(req.url).searchParams.get("subproject");
  const issues = listIssues(ctx.project.name, sub ? (i) => i.module === sub : undefined);
  return Response.json({ project: ctx.project.name, user: ctx.user.handle, issues });
}
