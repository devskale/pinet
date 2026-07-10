import { Q, hashPassword, type Kind } from "@/lib/db";
import { err } from "@/lib/http";
import { newToken, setCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { name, password, kind } = (await req.json().catch(() => ({}))) as {
    name?: string;
    password?: string;
    kind?: Kind;
  };
  if (!name || !password) return err("name and password required");
  if (kind !== "user" && kind !== "agent") return err("kind must be 'user' or 'agent'");
  if (Q.userByName(name)) return err("name already taken", 409);

  const user = Q.createUser(name, kind, hashPassword(password));
  const token = newToken();
  Q.sessionCreate(user.id, token);
  const res = Response.json({ user, token });
  res.headers.set("Set-Cookie", setCookie(token));
  return res;
}
