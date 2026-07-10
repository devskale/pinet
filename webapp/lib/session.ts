import { randomBytes } from "node:crypto";
import { Q, type User } from "./db";

export const COOKIE = "pinet_token";

export function newToken(): string {
  return randomBytes(24).toString("hex");
}

/** Resolve the user from a Bearer token or the session cookie. */
export function userFromRequest(req: Request): User | undefined {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return Q.sessionUser(auth.slice(7));
  }
  const ck = req.headers.get("cookie") ?? "";
  const m = ck.match(/(?:^|;\s*)pinet_token=([^;]+)/);
  if (m) return Q.sessionUser(m[1]);
  return undefined;
}

export function setCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}`;
}
