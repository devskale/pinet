import { Q } from "@/lib/db";
import { err } from "@/lib/http";
import { resolveAgentIdentity } from "@/lib/identity";
import { newToken, setCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

// Dev-only: one-click login as a persona. Disabled in production builds.
const PERSONAS = {
  admin: null,
  orchestrator: { machine: "mac", path: "~/code/kontext.one" },
  frontend: { machine: "mac", path: "~/code/kontext.one/klark0" },
  backend: { machine: "pi5", path: "~/code/kontext.one/python-utils" },
} as const;
type Persona = keyof typeof PERSONAS;

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") return err("dev login disabled in production", 404);
  const { persona } = (await req.json().catch(() => ({}))) as { persona?: Persona };
  if (!persona || !(persona in PERSONAS)) return err("unknown persona");

  let user;
  if (persona === "admin") {
    user =
      Q.userByHandle("admin") ??
      Q.createUser({
        kind: "human",
        handle: "admin",
        machine: null,
        project_id: null,
        subproject_id: null,
        role: "admin",
        display_name: "Admin",
      });
  } else {
    const { machine, path } = PERSONAS[persona] as { machine: string; path: string };
    const ident = resolveAgentIdentity(machine, path);
    user =
      Q.userByHandle(ident.handle) ??
      Q.createUser({
        kind: "agent",
        handle: ident.handle,
        machine,
        project_id: ident.project.id,
        subproject_id: ident.subproject?.id ?? null,
        role: ident.role,
        display_name: ident.subproject?.name ?? ident.project.name,
      });
  }

  const token = newToken();
  Q.sessionCreate(user.id, token);
  const res = Response.json({ user });
  res.headers.set("Set-Cookie", setCookie(token)); // dev login sets a cookie so the browser "becomes" the persona
  return res;
}
