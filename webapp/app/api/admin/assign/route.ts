import { Q } from "@/lib/db";
import { err } from "@/lib/http";
import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

const ROLES = new Set(["orchestrator", "frontend", "backend", "researcher", "worker"]);

/** Admin-only: assign an agent's role. */
export async function POST(req: Request) {
  const admin = userFromRequest(req);
  if (!admin || admin.role !== "admin") return err("admin only", 403);
  const { handle, role } = (await req.json().catch(() => ({}))) as { handle?: string; role?: string };
  if (!handle || !role || !ROLES.has(role)) return err("handle and a valid role required");
  if (!Q.userByHandle(handle)) return err("no such user", 404);
  return Response.json({ user: Q.setUserRole(handle, role) });
}
