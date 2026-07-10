import { randomBytes } from "node:crypto";
import { Q, type User } from "./db";

export const COOKIE = "pinet_token";

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

export function tokenFromRequest(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const ck = req.headers.get("cookie") ?? "";
  const m = ck.match(/(?:^|;\s*)pinet_token=([^;]+)/);
  return m?.[1];
}

export function userFromRequest(req: Request): User | undefined {
  const t = tokenFromRequest(req);
  return t ? Q.sessionUser(t) : undefined;
}

export function setCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;
}
