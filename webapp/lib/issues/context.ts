import { Q, type Project, type User } from "@/lib/db";
import { err } from "@/lib/http";
import { userFromRequest } from "@/lib/session";

/**
 * Resolve the acting user + the project they operate on.
 * Agents act on their own project; admins pick via ?project= (default: first).
 */
export async function boardContext(
  req: Request,
): Promise<{ user: User; project: Project } | { res: Response }> {
  const user = userFromRequest(req);
  if (!user) return { res: err("not authenticated", 401) };

  let project: Project | undefined;
  if (user.project_id) project = Q.projectById(user.project_id);
  else {
    const name = new URL(req.url).searchParams.get("project");
    project = name ? Q.projectByName(name) : Q.projectsAll()[0];
  }
  if (!project) return { res: err("no project for user", 400) };
  return { user, project };
}
