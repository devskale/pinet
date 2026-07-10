import { err } from "@/lib/http";
import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = userFromRequest(req);
  if (!user) return err("not authenticated", 401);
  return Response.json({ user });
}
