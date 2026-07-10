import { boardContext, listIssues, LIVE_COLUMNS } from "@/lib/issues";

export const dynamic = "force-dynamic";

/** My todo: issues addressed to me (to == my handle), in live columns. */
export async function GET(req: Request) {
  const ctx = await boardContext(req);
  if ("res" in ctx) return ctx.res;
  const me = ctx.user.handle;
  const issues = listIssues(ctx.project.name, (i) => i.to === me && LIVE_COLUMNS.includes(i.column));
  return Response.json({ project: ctx.project.name, me, issues });
}
