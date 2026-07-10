import path from "node:path";
import os from "node:os";
import { Q } from "./db";

export interface Resolved {
  project: { id: number; name: string };
  subproject: { id: number; name: string } | null;
  handle: string;
  assignment: string;
}

/** Short machine name, overridable via PINET_MACHINE; else hostname without domain. */
export function defaultMachine(): string {
  return process.env.PINET_MACHINE ?? os.hostname().split(".")[0];
}

/**
 * Resolve an agent identity from a repo path + machine.
 *   path == a project root_path   → project-wide (no subproject)
 *   path == a subproject path     → that subproject
 *   otherwise                     → error (unknown repo)
 * Role is NOT implied here — agents log in neutral ("worker"); the admin assigns role.
 */
export function resolveAgentIdentity(machine: string, inputPath: string): Resolved {
  const abs = path.resolve(inputPath.replace(/^~(?=$|\/|\\)/, os.homedir()));

  const proj = Q.projectByRoot(abs);
  if (proj) {
    return { project: proj, subproject: null, handle: `${machine}@${proj.name}`, assignment: proj.name };
  }

  const sub = Q.subprojectByPath(abs);
  if (sub) {
    const project = Q.projectById(sub.project_id);
    if (!project) throw new Error(`orphan subproject ${sub.name}`);
    return { project, subproject: sub, handle: `${machine}@${sub.name}`, assignment: `${project.name}/${sub.name}` };
  }

  throw new Error(`Unknown repo path: ${abs}. Register it as a project/subproject first.`);
}
