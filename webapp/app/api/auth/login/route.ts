import { Q, verifyPassword } from "@/lib/db";
import { err } from "@/lib/http";
import { ipFromReq, rateLimit } from "@/lib/ratelimit";
import { newToken, setCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { name, password } = (await req.json().catch(() => ({}))) as { name?: string; password?: string };
  if (!name || !password) return err("invalid credentials", 401);

  // throttle brute-force: per account + per IP
  if (!rateLimit(`login:${name}`, 10, 60_000) || !rateLimit(`login-ip:${ipFromReq(req)}`, 30, 60_000)) {
    return err("too many attempts, slow down", 429);
  }

  const row = Q.userByName(name);
  // generic message + constant-ish timing: always do a verify even if user missing
  const ok = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, "$argon2id$x");
  if (!row || !ok) return err("invalid credentials", 401);

  const { password_hash, ...user } = row;
  const token = newToken();
  Q.sessionCreate(user.id, token);
  const res = Response.json({ user, token });
  res.headers.set("Set-Cookie", setCookie(token));
  return res;
}
