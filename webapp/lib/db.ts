import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
`);

// --- password hashing (scrypt, no deps) ---
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const a = scryptSync(password, Buffer.from(salt, "hex"), 64);
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const Q = {
  createUser: (name: string, kind: Kind, password_hash: string) => {
    db.prepare("INSERT INTO users(name, kind, password_hash) VALUES(?,?,?)").run(name, kind, password_hash);
    return asT<User>(db.prepare("SELECT id, name, kind, created_at FROM users WHERE name=?").get(name));
  },
  userByName: (name: string) =>
    asT<{ id: number; name: string; kind: Kind; password_hash: string; created_at: string } | undefined>(
      db.prepare("SELECT * FROM users WHERE name=?").get(name),
    ),
  userById: (id: number) => asT<User | undefined>(db.prepare("SELECT id, name, kind, created_at FROM users WHERE id=?").get(id)),

  sessionCreate: (userId: number, token: string) =>
    db.prepare("INSERT INTO sessions(token, user_id) VALUES(?,?)").run(token, userId),
  sessionUser: (token: string) => {
    const s = asT<{ user_id: number } | undefined>(db.prepare("SELECT user_id FROM sessions WHERE token=?").get(token));
    return s ? Q.userById(s.user_id) : undefined;
  },
  sessionDelete: (token: string) => db.prepare("DELETE FROM sessions WHERE token=?").run(token),

  projectsAll: () => asT<Project[]>(db.prepare("SELECT id, name, created_at FROM projects ORDER BY name").all()),
  createProject: (name: string) => {
    db.prepare("INSERT OR IGNORE INTO projects(name) VALUES(?)").run(name);
    return asT<Project | undefined>(db.prepare("SELECT id, name, created_at FROM projects WHERE name=?").get(name));
  },
  projectByName: (name: string) =>
    asT<Project | undefined>(db.prepare("SELECT id, name, created_at FROM projects WHERE name=?").get(name)),
};
