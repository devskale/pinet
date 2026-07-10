import path from "node:path";
import os from "node:os";
import { Q } from "@/lib/db";
import { err } from "@/lib/http";
import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Admin-only: register a project + its subprojects (repos). */
export async function POST(req: Request) {
  const user = userFromRequest(req);
  if (!user || user.role !== "admin") return err("admin only", 403);
  const { name, rootPath, subprojects } = (await req.json().catch(() => ({}))) as {
    name?: string;
    rootPath?: string;
    subprojects?: string[];
  };
  if (!name) return err("name required");
  const root = rootPath ? rootPath.replace(/^~(?=$|\/|\\)/, os.homedir()) : path.join(os.homedir(), "code", name);
  const project = Q.createProject(name, root);
  if (!project) return err("could not create project");
  const subs = (subprojects || []).map((s) => Q.addSubproject(project.id, s, path.join(root, s)));
  return Response.json({ project, subprojects: subs });
}
