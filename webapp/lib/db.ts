import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export type UserKind = "human" | "agent";
export type Role = "admin" | "orchestrator" | "frontend" | "backend" | "researcher" | "worker";

export interface User {
  id: number;
  kind: UserKind;
  handle: string;
  machine: string | null;
  project_id: number | null;
  subproject_id: number | null;
  role: Role;
  display_name: string | null;
  created_at: string;
}
export interface Project {
  id: number;
  name: string;
  root_path: string;
}
export interface Subproject {
  id: number;
  project_id: number;
  name: string;
  path: string;
}

// node:sqlite returns Record<string, SQLOutputValue>; cast through unknown.
const asT = <T>(v: unknown): T => v as T;

const DB_PATH = process.env.PINET_DB ?? path.join(process.cwd(), "data", "pinet.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Reuse one connection across Next.js dev hot-reloads.
const g = globalThis as unknown as { __pinetDb?: DatabaseSync };
const db = g.__pinetDb ?? new DatabaseSync(DB_PATH);
if (!g.__pinetDb) g.__pinetDb = db;

db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  root_path TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS subprojects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  path TEXT UNIQUE NOT NULL,
  UNIQUE(project_id, name)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  handle TEXT UNIQUE NOT NULL,
  machine TEXT,
  project_id INTEGER REFERENCES projects(id),
  subproject_id INTEGER REFERENCES subprojects(id),
  role TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Seed kontext.one so the personas work out of the box (idempotent).
const c = asT<{ c: number }>(db.prepare("SELECT COUNT(*) c FROM projects").get());
if (c.c === 0) {
  const root = path.join(os.homedir(), "code", "kontext.one");
  db.prepare("INSERT INTO projects(name, root_path) VALUES(?,?)").run("kontext.one", root);
  const p = asT<Project>(db.prepare("SELECT * FROM projects WHERE name=?").get("kontext.one"));
  for (const sub of ["klark0", "python-utils"]) {
    db.prepare("INSERT INTO subprojects(project_id,name,path) VALUES(?,?,?)").run(p.id, sub, path.join(root, sub));
  }
  console.log(`[pinet] seeded project kontext.one (${root}) + subprojects klark0, python-utils`);
}

export const Q = {
  projectsAll: () => asT<Project[]>(db.prepare("SELECT * FROM projects ORDER BY name").all()),
  projectById: (id: number) => asT<Project | undefined>(db.prepare("SELECT * FROM projects WHERE id=?").get(id)),
  projectByName: (name: string) => asT<Project | undefined>(db.prepare("SELECT * FROM projects WHERE name=?").get(name)),
  projectByRoot: (root: string) => asT<Project | undefined>(db.prepare("SELECT * FROM projects WHERE root_path=?").get(root)),
  subprojectByPath: (p: string) => asT<Subproject | undefined>(db.prepare("SELECT * FROM subprojects WHERE path=?").get(p)),
  subprojectsOf: (pid: number) => asT<Subproject[]>(db.prepare("SELECT * FROM subprojects WHERE project_id=? ORDER BY name").all(pid)),

  userByHandle: (h: string) => asT<User | undefined>(db.prepare("SELECT * FROM users WHERE handle=?").get(h)),
  userById: (id: number) => asT<User | undefined>(db.prepare("SELECT * FROM users WHERE id=?").get(id)),
  usersAll: () => asT<User[]>(db.prepare("SELECT * FROM users ORDER BY created_at").all()),
  createUser: (u: Omit<User, "id" | "created_at">) => {
    db.prepare(
      "INSERT INTO users(kind,handle,machine,project_id,subproject_id,role,display_name) VALUES(?,?,?,?,?,?,?)",
    ).run(u.kind, u.handle, u.machine, u.project_id, u.subproject_id, u.role, u.display_name);
    return asT<User>(db.prepare("SELECT * FROM users WHERE handle=?").get(u.handle));
  },

  sessionCreate: (uid: number, token: string) =>
    db.prepare("INSERT INTO sessions(token,user_id) VALUES(?,?)").run(token, uid),
  sessionUser: (token: string) => {
    const s = asT<{ user_id: number } | undefined>(db.prepare("SELECT user_id FROM sessions WHERE token=?").get(token));
    return s ? asT<User>(db.prepare("SELECT * FROM users WHERE id=?").get(s.user_id)) : undefined;
  },
  sessionDelete: (token: string) => db.prepare("DELETE FROM sessions WHERE token=?").run(token),

  createProject: (name: string, rootPath: string) => {
    db.prepare("INSERT OR IGNORE INTO projects(name, root_path) VALUES(?,?)").run(name, rootPath);
    return Q.projectByName(name);
  },
  addSubproject: (projectId: number, name: string, p: string) => {
    db.prepare("INSERT OR IGNORE INTO subprojects(project_id, name, path) VALUES(?,?,?)").run(projectId, name, p);
    return Q.subprojectByPath(p);
  },
  setUserRole: (handle: string, role: string) => {
    db.prepare("UPDATE users SET role=? WHERE handle=?").run(role, handle);
    return Q.userByHandle(handle);
  },
};
