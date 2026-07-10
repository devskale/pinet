import { Q } from "@/lib/db";
import { newToken } from "@/lib/session";
import { defaultMachine, resolveAgentIdentity } from "@/lib/identity";

export const dynamic = "force-dynamic";

/** Pi agent login: { machine, path }. Role is implicit from the path depth. */
export async function POST(req: Request) {
  const { machine, path } = (await req.json().catch(() => ({}))) as {
    machine?: string;
    path?: string;
  };
  if (!path) return Response.json({ error: "path required" }, { status: 400 });
  const m = (machine || defaultMachine()).trim();

  let ident;
  try {
    ident = resolveAgentIdentity(m, path);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  let user = Q.userByHandle(ident.handle);
  if (!user) {
    user = Q.createUser({
      kind: "agent",
      handle: ident.handle,
      machine: m,
      project_id: ident.project.id,
      subproject_id: ident.subproject?.id ?? null,
      role: "worker",
      display_name: ident.subproject?.name ?? ident.project.name,
    });
  }

  const token = newToken();
  Q.sessionCreate(user.id, token);
  return Response.json({
    token, // agents use this as Bearer; humans use the cookie
    user,
    assignment: ident.assignment,
    role: "worker",
  });
}
