import { Q, type Kind } from "@/lib/db";
import { err } from "@/lib/http";
import { passwordError } from "@/lib/password";
import { newToken, setCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { name, password, kind } = (await req.json().catch(() => ({}))) as {
    name?: string;
    password?: string;
    kind?: Kind;
  };
  if (!name) return err("name required");
  if (kind !== "user" && kind !== "agent") return err("kind must be 'user' or 'agent'");
  const pwErr = passwordError(password ?? "");
  if (pwErr) return err(pwErr);
  if (Q.userByName(name)) return err("name already taken", 409);

  const user = await Q.createUser(name, kind, password!);
  const token = newToken();
  Q.sessionCreate(user.id, token);
  const res = Response.json({ user, token });
  res.headers.set("Set-Cookie", setCookie(token));
  return res;
}
