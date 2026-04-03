/**
 * PiNet — File system operations.
 *
 * All reads and writes to ~/.pinet/ go through this module.
 * Zero external dependencies — only Node built-ins.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  PINET_DIR, NAME_PATTERN,
  ADJECTIVES, NOUNS,
  PresenceEntry, TeamMeta, Binding,
} from "./types";

// =============================================================================
// Paths
// =============================================================================

/** Resolve a path under ~/.pinet/ */
export function pinetPath(...segments: string[]): string {
  return path.join(PINET_DIR, ...segments);
}

// =============================================================================
// File system helpers
// =============================================================================

/** Create directory recursively if it doesn't exist */
export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Check if a path exists */
export function exists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/** Read a file as UTF-8 string */
export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

// =============================================================================
// JSONL
// =============================================================================

/** Read all entries from a JSONL file, skipping malformed lines */
export function readJsonl<T = unknown>(filePath: string): T[] {
  if (!exists(filePath)) return [];
  const content = readFile(filePath).trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((entry): entry is T => entry !== null);
}

/** Append a JSON entry to a JSONL file (creates parent dirs) */
export function appendJsonl(filePath: string, obj: unknown) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n");
}

/** Write a JSON file (creates parent dirs) */
export function writeJson(filePath: string, obj: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

/** Read and parse a JSON file, returns null on failure */
export function readJson<T = unknown>(filePath: string): T | null {
  if (!exists(filePath)) return null;
  try { return JSON.parse(readFile(filePath)); } catch { return null; }
}

// =============================================================================
// Process
// =============================================================================

/** Check if a PID is alive */
export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// =============================================================================
// Name generation
// =============================================================================

/** Generate a random memorable name (Adjective + Noun) */
export function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}${noun}`;
}

/** Validate that a name matches the allowed pattern */
export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

// =============================================================================
// Presence
// =============================================================================

/** Write presence file for an agent */
export function writePresence(name: string, status: "online" | "offline") {
  const entry: PresenceEntry = {
    name,
    status,
    pid: process.pid,
    lastSeen: new Date().toISOString(),
  };
  writeJson(pinetPath("presence", `${name}.json`), entry);
}

/** Read all presence entries, cleaning up stale ones */
export function readAllPresence(): PresenceEntry[] {
  const dir = pinetPath("presence");
  if (!exists(dir)) return [];

  const entries: PresenceEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const entry = readJson<PresenceEntry>(path.join(dir, file));
    if (!entry) continue;

    // Clean up stale online entries (dead PID)
    if (entry.status === "online" && !isProcessAlive(entry.pid)) {
      try { fs.unlinkSync(path.join(dir, file)); } catch {}
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

// =============================================================================
// Identity
// =============================================================================

/** Append an identity record to the all-time log */
export function writeIdentity(name: string) {
  appendJsonl(pinetPath("identities.jsonl"), { name, created: new Date().toISOString() });
}

// =============================================================================
// Teams
// =============================================================================

/** Read team metadata */
export function readTeamMeta(teamName: string): TeamMeta | null {
  return readJson<TeamMeta>(pinetPath("teams", teamName, "meta.json"));
}

/** Write team metadata */
export function writeTeamMeta(meta: TeamMeta) {
  writeJson(pinetPath("teams", meta.name, "meta.json"), meta);
}

/** Join a team — creates it if it doesn't exist, adds agent to members */
export function joinTeam(teamName: string, agentName: string): boolean {
  let meta = readTeamMeta(teamName);
  if (!meta) {
    meta = { name: teamName, members: [agentName], created: new Date().toISOString() };
  } else if (!meta.members.includes(agentName)) {
    meta.members.push(agentName);
  } else {
    return true; // already a member
  }
  writeTeamMeta(meta);
  return true;
}

/** Read all messages from a team's timeline */
export function readTeamMessages(teamName: string) {
  return readJsonl(pinetPath("teams", teamName, "messages.jsonl"));
}

// =============================================================================
// Bindings (folder → identity)
// =============================================================================

/** Get a stable hash of the current working directory */
function cwdHash(): string {
  return crypto.createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
}

/** Read the binding for the current working directory */
export function readBinding(): Binding | null {
  return readJson<Binding>(pinetPath("bindings", `${cwdHash()}.json`));
}

/** Write a binding for the current working directory */
export function writeBinding(name: string, teams: string[]) {
  writeJson(pinetPath("bindings", `${cwdHash()}.json`), {
    name,
    teams,
    path: process.cwd(),
    bound: new Date().toISOString(),
  });
}
