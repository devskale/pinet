import { boardContext, listIssues, LIVE_COLUMNS } from "@/lib/issues";

export const dynamic = "force-dynamic";

/** Orchestrator-style rollup: per-column counts, per-actor load (live), stale WIP. */
export async function GET(req: Request) {
  const ctx = await boardContext(req);
  if ("res" in ctx) return ctx.res;
  const issues = listIssues(ctx.project.name);

  const byCol: Record<string, number> = {};
  const load: Record<string, number> = {};
  const stale: { slug: string; from: string; to: string | null; ageDays: number }[] = [];
  const now = Date.now();

  for (const i of issues) {
    byCol[i.column] = (byCol[i.column] || 0) + 1;
    if (LIVE_COLUMNS.includes(i.column) && i.to) load[i.to] = (load[i.to] || 0) + 1;
    if (i.column === "active" && i.date) {
      const ageDays = (now - new Date(i.date).getTime()) / 86_400_000;
      if (ageDays > 1) stale.push({ slug: i.slug, from: i.from, to: i.to, ageDays: Math.round(ageDays) });
    }
  }
  return Response.json({ project: ctx.project.name, total: issues.length, byCol, load, stale });
}
