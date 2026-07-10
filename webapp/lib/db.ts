import { DatabaseSync } from "node:sqlite";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";
import path from "node:path";
import fs from "node:fs";

export type Kind = "user" | "agent";

export interface User {
  id: number;
  name: string;
  kind: Kind;
  created_at: string;
}
export interface Project {
  id: number;
  name: string;
  created_at: string;
}

const asT = <T>(v: unknown): T => v as T;

const DB_PATH = process.env.PINET_DB ?? path.join(process.cwd(), "data", "pinet.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const g = globalThis as unknown as { __pinetDb?: DatabaseSync };
const db = g.__pinetDb ?? new DatabaseSync(DB_PATH);
if (!g.__pinetDb) g.__pinetDb = db;

db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  holder_user_id INTEGER REFERENCES users(id),
  claim_token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)
);
`);

// --- password hashing: argon2id (default; OWASP-recommended) ---
export async function hashPassword(password: string): Promise<string> {
  return argonHash(password);
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    return await argonVerify(stored, password);
  } catch {
    return false;
  }
}

export const Q = {
  createUser: async (name: string, kind: Kind, password: string) => {
    const password_hash = await hashPassword(password);
    db.prepare("INSERT INTO users(name, kind, password_hash) VALUES(?,?,?)").run(name, kind, password_hash);
    return asT<User>(db.prepare("SELECT id, name, kind, created_at FROM users WHERE name=?").get(name));
  },
  userByName: (name: string) =>
    asT<{ id: number; name: string; kind: Kind; password_hash: string; created_at: string } | undefined>(
      db.prepare("SELECT * FROM users WHERE name=?").get(name),
    ),
  userById: (id: number) => asT<User | undefined>(db.prepare("SELECT id, name, kind, created_at FROM users WHERE id=?").get(id)),

  setPassword: async (userId: number, password: string) => {
    const password_hash = await hashPassword(password);
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(password_hash, userId);
  },

  sessionCreate: (userId: number, token: string) =>
    db.prepare("INSERT INTO sessions(token, user_id) VALUES(?,?)").run(token, userId),
  sessionUser: (token: string) => {
    const s = asT<{ user_id: number } | undefined>(db.prepare("SELECT user_id FROM sessions WHERE token=?").get(token));
    return s ? Q.userById(s.user_id) : undefined;
  },
  sessionDelete: (token: string) => db.prepare("DELETE FROM sessions WHERE token=?").run(token),
  deleteSessionsByUser: (userId: number, exceptToken?: string) =>
    exceptToken
      ? db.prepare("DELETE FROM sessions WHERE user_id=? AND token<>?").run(userId, exceptToken)
      : db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId),

  addPasswordReset: (userId: number, tokenHash: string, expiresAt: string) =>
    db.prepare("INSERT OR REPLACE INTO password_resets(token_hash, user_id, expires_at) VALUES(?,?,?)").run(
      tokenHash,
      userId,
      expiresAt,
    ),
  consumePasswordReset: (tokenHash: string) => {
    const row = asT<{ user_id: number; expires_at: string } | undefined>(
      db.prepare("SELECT user_id, expires_at FROM password_resets WHERE token_hash=?").get(tokenHash),
    );
    if (!row) return undefined;
    db.prepare("DELETE FROM password_resets WHERE token_hash=?").run(tokenHash); // single-use
    if (new Date(row.expires_at).getTime() < Date.now()) return undefined; // expired
    return row.user_id;
  },

  projectsAll: () => asT<Project[]>(db.prepare("SELECT id, name, created_at FROM projects ORDER BY name").all()),
  createProject: (name: string) => {
    db.prepare("INSERT OR IGNORE INTO projects(name) VALUES(?)").run(name);
    return asT<Project | undefined>(db.prepare("SELECT id, name, created_at FROM projects WHERE name=?").get(name));
  },
  projectByName: (name: string) =>
    asT<Project | undefined>(db.prepare("SELECT id, name, created_at FROM projects WHERE name=?").get(name)),
  projectById: (id: number) =>
    asT<Project | undefined>(db.prepare("SELECT id, name, created_at FROM projects WHERE id=?").get(id)),

  // --- membership is derived from role holdings (a user is a member iff they hold a role slot) ---
  memberRole: (projectId: number, userId: number) =>
    asT<{ role: string } | undefined>(
      db.prepare("SELECT name AS role FROM project_roles WHERE project_id=? AND holder_user_id=? LIMIT 1").get(projectId, userId),
    ),
  membersOf: (projectId: number) =>
    asT<{ name: string; kind: Kind; role: string }[]>(
      db.prepare("SELECT u.name, u.kind, r.name AS role FROM project_roles r JOIN users u ON u.id=r.holder_user_id WHERE r.project_id=? AND r.holder_user_id IS NOT NULL ORDER BY r.id").all(projectId),
    ),
  projectsForUser: (userId: number) =>
    asT<Project[]>(
      db.prepare("SELECT DISTINCT p.id, p.name, p.created_at FROM project_roles r JOIN projects p ON p.id=r.project_id WHERE r.holder_user_id=? ORDER BY p.name").all(userId),
    ),
  fillRole: (projectId: number, slotName: string, userId: number) => {
    db.prepare("INSERT OR IGNORE INTO project_roles(project_id, name, claim_token) VALUES(?,?,?)").run(projectId, slotName, randomBytes(24).toString("hex"));
    const slot = asT<{ id: number } | undefined>(db.prepare("SELECT id FROM project_roles WHERE project_id=? AND name=?").get(projectId, slotName));
    if (slot) db.prepare("UPDATE project_roles SET holder_user_id=? WHERE id=?").run(userId, slot.id);
    return slot;
  },
  addMember: (projectId: number, userId: number, role: string = "member") =>
    db.prepare("INSERT OR IGNORE INTO project_members(project_id, user_id, role) VALUES(?,?,?)").run(projectId, userId, role),
  createInvite: (projectId: number, role: string, tokenHash: string, expiresAt: string) =>
    db.prepare("INSERT INTO invites(token_hash, project_id, role, expires_at) VALUES(?,?,?,?)").run(tokenHash, projectId, role, expiresAt),
  consumeInvite: (tokenHash: string) => {
    const row = asT<{ project_id: number; role: string; expires_at: string } | undefined>(
      db.prepare("SELECT project_id, role, expires_at FROM invites WHERE token_hash=?").get(tokenHash),
    );
    if (!row) return undefined;
    db.prepare("DELETE FROM invites WHERE token_hash=?").run(tokenHash); // single-use
    if (new Date(row.expires_at).getTime() < Date.now()) return undefined; // expired
    return { project_id: row.project_id, role: row.role };
  },

  // --- role slots: named, claimable via a stable link ---
  rolesOf: (projectId: number) =>
    asT<{ id: number; name: string; holder_user_id: number | null; claim_token: string }[]>(
      db.prepare("SELECT id, name, holder_user_id, claim_token FROM project_roles WHERE project_id=? ORDER BY id").all(projectId),
    ),
  createRole: (projectId: number, name: string, claimToken: string) => {
    db.prepare("INSERT OR IGNORE INTO project_roles(project_id, name, claim_token) VALUES(?,?,?)").run(projectId, name, claimToken);
    return asT<{ id: number; name: string; holder_user_id: number | null; claim_token: string } | undefined>(
      db.prepare("SELECT id, name, holder_user_id, claim_token FROM project_roles WHERE project_id=? AND name=?").get(projectId, name),
    );
  },
  roleByClaim: (token: string) =>
    asT<{ id: number; project_id: number; name: string; holder_user_id: number | null } | undefined>(
      db.prepare("SELECT id, project_id, name, holder_user_id FROM project_roles WHERE claim_token=?").get(token),
    ),
  takeRole: (roleId: number, userId: number) =>
    db.prepare("UPDATE project_roles SET holder_user_id=? WHERE id=? AND holder_user_id IS NULL").run(userId, roleId).changes > 0,
  clearRoleHolder: (projectId: number, name: string) =>
    db.prepare("UPDATE project_roles SET holder_user_id=NULL WHERE project_id=? AND name=?").run(projectId, name),
  deleteRole: (projectId: number, name: string) =>
    db.prepare("DELETE FROM project_roles WHERE project_id=? AND name=?").run(projectId, name),
};
