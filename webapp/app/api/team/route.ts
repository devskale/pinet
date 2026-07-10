import { Q } from "@/lib/db";
import { boardContext } from "@/lib/issues";

export const dynamic = "force-dynamic";

/** Project roster: handles + roles (so agents can address each other). */
export async function GET(req: Request) {
  const ctx = await boardContext(req);
  if ("res" in ctx) return ctx.res;
  const members = Q.usersAll()
    .filter((u) => u.project_id === ctx.project.id)
    .map((u) => ({ handle: u.handle, role: u.role, kind: u.kind, display_name: u.display_name }));
  return Response.json({ project: ctx.project.name, me: ctx.user.handle, members });
}
