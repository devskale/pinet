import { Q } from "@/lib/db";
import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Admin-only overview: registered projects/subprojects + everyone who has logged in. */
export async function GET(req: Request) {
  const user = userFromRequest(req);
  if (!user || user.role !== "admin") {
    return Response.json({ error: "admin only" }, { status: 403 });
  }
  const projects = Q.projectsAll().map((p) => ({ ...p, subprojects: Q.subprojectsOf(p.id) }));
  return Response.json({ projects, users: Q.usersAll() });
}
