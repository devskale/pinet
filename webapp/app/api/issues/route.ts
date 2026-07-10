import { boardContext, createIssue } from "@/lib/issues";
import { err } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = await boardContext(req);
  if ("res" in ctx) return ctx.res;
  const { slug, to, task, context, module } = (await req.json().catch(() => ({}))) as {
    slug?: string;
    to?: string;
    task?: string;
    context?: string;
    module?: string;
  };
  if (!slug || !task) return err("slug and task required");
  try {
    const issue = createIssue(ctx.project.name, {
      slug,
      from: ctx.user.handle,
      to: to || null,
      task,
      context: context || "",
      module: module || null,
    });
    return Response.json({ issue });
  } catch (e) {
    return err((e as Error).message);
  }
}
