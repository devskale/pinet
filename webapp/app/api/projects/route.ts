import { Q } from "@/lib/db";
import { err } from "@/lib/http";
import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!userFromRequest(req)) return err("not authenticated", 401);
  return Response.json({ projects: Q.projectsAll() });
}

export async function POST(req: Request) {
  if (!userFromRequest(req)) return err("not authenticated", 401);
  const { name } = (await req.json().catch(() => ({}))) as { name?: string };
  if (!name || !name.trim()) return err("name required");
  const project = Q.createProject(name.trim());
  if (!project) return err("could not create project");
  return Response.json({ project });
}
