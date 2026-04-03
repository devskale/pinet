/**
 * PiNet — File system helpers (zero dependencies)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { PINET_DIR, ADJECTIVES, NOUNS, PresenceEntry, TeamMeta, Binding } from "./types";

// =============================================================================
// Path helpers
// =============================================================================

export function pinetPath(...segments: string[]): string {
  return path.join(PINET_DIR, ...segments);
}

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// =============================================================================
// JSONL
// =============================================================================

export function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((m) => m !== null);
}

export function appendJsonl(filePath: string, obj: unknown) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n");
}

// =============================================================================
// Process
// =============================================================================

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// =============================================================================
// Name generation
// =============================================================================

export function generateName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}${noun}`;
}

// =============================================================================
// Presence
// =============================================================================

export function writePresence(name: string, status: "online" | "offline") {
  ensureDir(pinetPath("presence"));
  const entry: PresenceEntry = {
    name,
    status,
    pid: process.pid,
    lastSeen: new Date().toISOString(),
  };
  fs.writeFileSync(pinetPath("presence", `${name}.json`), JSON.stringify(entry, null, 2));
}

export function readAllPresence(): PresenceEntry[] {
  const dir = pinetPath("presence");
  if (!fs.existsSync(dir)) return [];
  const entries: PresenceEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry: PresenceEntry = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf-8")
      );
      if (entry.status === "online" && !isProcessAlive(entry.pid)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch {}
        continue;
      }
      entries.push(entry);
    } catch {}
  }
  return entries;
}

// =============================================================================
// Identity
// =============================================================================

export function writeIdentity(name: string) {
  ensureDir(pinetPath());
  appendJsonl(pinetPath("identities.jsonl"), { name, created: new Date().toISOString() });
}

// =============================================================================
// Team
// =============================================================================

export function readTeamMeta(teamName: string): TeamMeta | null {
  const filePath = pinetPath("teams", teamName, "meta.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function writeTeamMeta(meta: TeamMeta) {
  ensureDir(pinetPath("teams", meta.name));
  fs.writeFileSync(
    pinetPath("teams", meta.name, "meta.json"),
    JSON.stringify(meta, null, 2)
  );
}

export function joinTeam(teamName: string, agentName: string): boolean {
  let meta = readTeamMeta(teamName);
  if (!meta) {
    meta = { name: teamName, members: [agentName], created: new Date().toISOString() };
    writeTeamMeta(meta);
    return true;
  }
  if (meta.members.includes(agentName)) return true;
  meta.members.push(agentName);
  writeTeamMeta(meta);
  return true;
}

export function readTeamMessages(teamName: string) {
  return readJsonl(pinetPath("teams", teamName, "messages.jsonl"));
}

// =============================================================================
// Bindings (folder → identity)
// =============================================================================

function cwdHash(): string {
  return crypto.createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
}

export function readBinding(): Binding | null {
  const filePath = pinetPath("bindings", `${cwdHash()}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function writeBinding(name: string, teams: string[]) {
  ensureDir(pinetPath("bindings"));
  const binding: Binding = {
    name,
    teams,
    path: process.cwd(),
    bound: new Date().toISOString(),
  };
  fs.writeFileSync(pinetPath("bindings", `${cwdHash()}.json`), JSON.stringify(binding, null, 2));
}
