import { Q, verifyPassword } from "@/lib/db";
import { err } from "@/lib/http";
import { newToken, setCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { name, password } = (await req.json().catch(() => ({}))) as { name?: string; password?: string };
  if (!name || !password) return err("name and password required");
  const row = Q.userByName(name);
  if (!row || !verifyPassword(password, row.password_hash)) return err("invalid credentials", 401);

  const { password_hash, ...user } = row;
  const token = newToken();
  Q.sessionCreate(user.id, token);
  const res = Response.json({ user, token });
  res.headers.set("Set-Cookie", setCookie(token));
  return res;
}
