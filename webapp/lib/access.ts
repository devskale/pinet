import { Q, type Project, type User } from "./db";
import { err } from "./http";
import { userFromRequest } from "./session";

export interface Ctx {
  user: User;
  project: Project;
  role: string; // membership role: owner | admin | member
}

/** Resolve the acting user + project + their membership role, or an error Response. */
export function ctxFor(req: Request, projectName: string): Ctx | Response {
  const user = userFromRequest(req);
  if (!user) return err("not authenticated", 401);
  const project = Q.projectByName(projectName);
  if (!project) return err("no such project", 404);
  const m = Q.memberRole(project.id, user.id);
  if (!m) return err("not a member of this project", 403);
  return { user, project, role: m.role };
}

export const isManager = (role: string) => role === "owner" || role === "admin";
