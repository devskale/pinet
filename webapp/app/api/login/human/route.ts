import { Q } from "@/lib/db";
import { newToken, setCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Human admin login. v0: a single admin password (env ADMIN_PASSWORD, default "admin"). */
export async function POST(req: Request) {
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  const expected = process.env.ADMIN_PASSWORD ?? "admin";
  if (password !== expected) {
    return Response.json({ error: "wrong password" }, { status: 401 });
  }
  let admin = Q.userByHandle("admin");
  if (!admin) {
    admin = Q.createUser({
      kind: "human",
      handle: "admin",
      machine: null,
      project_id: null,
      subproject_id: null,
      role: "admin",
      display_name: "Admin",
    });
  }
  const token = newToken();
  Q.sessionCreate(admin.id, token);
  const res = Response.json({ user: admin });
  res.headers.set("Set-Cookie", setCookie(token));
  return res;
}
