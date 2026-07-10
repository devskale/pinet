import { Q } from "@/lib/db";
import { COOKIE, userFromRequest } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const ck = req.headers.get("cookie") ?? "";
  const m = ck.match(/(?:^|;\s*)pinet_token=([^;]+)/);
  const token = (auth?.startsWith("Bearer ") ? auth.slice(7) : null) ?? m?.[1];
  if (token) Q.sessionDelete(token);
  const res = Response.json({ ok: true });
  res.headers.set("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  return res;
}
