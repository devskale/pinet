import { userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = userFromRequest(req);
  if (!user) return Response.json({ error: "not authenticated" }, { status: 401 });
  return Response.json({ user });
}
