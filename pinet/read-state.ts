/**
 * PiNet — Read pointers (line counts) for unread detection.
 *
 * No file watchers. All message delivery goes through the relay
 * (sync daemon → IPC → pi.sendMessage).
 *
 * This module only tracks read pointers so tools know what's "unread".
 */

import * as fs from "node:fs";
import { pinetPath } from "./store";

// =============================================================================
// State
// =============================================================================

let myName: string | null = null;
let personalLineCount = 0;
const teamLineCounts: Map<string, number> = new Map();

// =============================================================================
// Public API
// =============================================================================

export function setWatcherIdentity(name: string) {
  myName = name;
  // Snapshot current line counts
  if (myName) {
    const mailbox = pinetPath("mailboxes", `${myName}.mailbox.jsonl`);
    personalLineCount = countLines(mailbox);
  }
}

export function resetWatchers() {
  myName = null;
  personalLineCount = 0;
  teamLineCounts.clear();
}

export function getPersonalLineCount(): number {
  return personalLineCount;
}

export function getTeamLineCount(team: string): number {
  return teamLineCounts.get(team) ?? 0;
}

export function bumpTeamLineCount(teamName: string) {
  const filePath = pinetPath("teams", teamName, "messages.jsonl");
  teamLineCounts.set(teamName, countLines(filePath));
}

/** Adjust read pointer after compaction removed lines from the head */
export function adjustPersonalPointer(removed: number) {
  personalLineCount = Math.max(0, personalLineCount - removed);
}

/** Adjust team read pointer after compaction */
export function adjustTeamPointer(team: string, removed: number) {
  const current = teamLineCounts.get(team) ?? 0;
  teamLineCounts.set(team, Math.max(0, current - removed));
}

/** Snapshot team line count on join */
export function startTeamWatcher(_pi: unknown, teamName: string) {
  const filePath = pinetPath("teams", teamName, "messages.jsonl");
  teamLineCounts.set(teamName, countLines(filePath));
}

/** Snapshot personal mailbox on login */
export function startPersonalWatcher(_pi: unknown) {
  if (!myName) return;
  const filePath = pinetPath("mailboxes", `${myName}.mailbox.jsonl`);
  personalLineCount = countLines(filePath);
}

// =============================================================================
// Helpers
// =============================================================================

function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf-8").trim();
  return content ? content.split("\n").length : 0;
}
