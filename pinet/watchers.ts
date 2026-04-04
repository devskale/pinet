/**
 * PiNet — File watchers for personal mailbox and team messages.
 *
 * Watches ~/.pinet/mailboxes/ and ~/.pinet/teams/<name>/ for changes.
 * Delivers new messages into the agent's conversation via pi.sendMessage().
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { pinetPath, ensureDir, readJsonl } from "./store";
import { PersonalMessage, TeamMessage } from "./types";

// =============================================================================
// Types
// =============================================================================

interface WatcherState {
  watcher: fs.FSWatcher;
  lineCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

// =============================================================================
// State
// =============================================================================

let myName: string | null = null;

let personalState: WatcherState | null = null;
let teamStates: Map<string, WatcherState> = new Map();

const DEBOUNCE_MS = 100;

// =============================================================================
// Public API
// =============================================================================

/** Set the agent name (called on login) */
export function setWatcherIdentity(name: string) {
  myName = name;
}

/** Stop all watchers and reset state (called on logout) */
export function resetWatchers() {
  myName = null;
  stopWatcher(personalState);
  personalState = null;
  for (const state of teamStates.values()) stopWatcher(state);
  teamStates.clear();
}

/** Current personal mailbox read pointer */
export function getPersonalLineCount(): number {
  return personalState?.lineCount ?? 0;
}

/** Current team timeline read pointer */
export function getTeamLineCount(team: string): number {
  return teamStates.get(team)?.lineCount ?? 0;
}

/** Advance line count for a team (called after /pinet msg writes directly) */
export function bumpTeamLineCount(teamName: string) {
  const state = teamStates.get(teamName);
  if (!state) return;
  const filePath = pinetPath("teams", teamName, "messages.jsonl");
  state.lineCount = countLines(filePath);
}

/** Start watching the personal mailbox */
export function startPersonalWatcher(pi: ExtensionAPI) {
  if (!myName) return;

  const filePath = pinetPath("mailboxes", `${myName}.mailbox.jsonl`);
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const lineCount = countLines(filePath);
  const watcher = fs.watch(dir, (_evt, filename) => {
    if (filename !== `${myName}.mailbox.jsonl`) return;
    debounce(personalState, DEBOUNCE_MS, () => {
      if (!personalState) return;
      const all = readJsonl<PersonalMessage>(filePath);
      const fresh = all.slice(personalState.lineCount);
      personalState.lineCount = all.length;
      deliverPersonal(pi, fresh);
    });
  });

  personalState = { watcher, lineCount, timer: null };
}

/** Start watching a team's timeline */
export function startTeamWatcher(pi: ExtensionAPI, teamName: string) {
  const filePath = pinetPath("teams", teamName, "messages.jsonl");
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const lineCount = countLines(filePath);
  const watcher = fs.watch(dir, (_evt, filename) => {
    if (filename !== "messages.jsonl") return;
    const state = teamStates.get(teamName);
    if (!state) return;
    debounce(state, DEBOUNCE_MS, () => {
      if (!state) return;
      const all = readJsonl<TeamMessage>(filePath);
      const fresh = all.slice(state.lineCount);
      state.lineCount = all.length;
      deliverTeam(pi, teamName, fresh);
    });
  });

  teamStates.set(teamName, { watcher, lineCount, timer: null });
}

// =============================================================================
// Delivery
// =============================================================================

function deliverPersonal(pi: ExtensionAPI, messages: PersonalMessage[]) {
  if (messages.length === 0) return;
  const summary = messages.map((m) => `receive from ${m.from}->${myName}: ${m.body}`).join("\n");
  pi.sendMessage(
    {
      customType: "pinet",
      content: summary,
      display: true,
    },
    { triggerTurn: true }
  );
}

function deliverTeam(pi: ExtensionAPI, teamName: string, messages: TeamMessage[]) {
  if (messages.length === 0 || !myName) return;
  // Filter out own messages to prevent echo loops
  const incoming = messages.filter((m) => m.from !== myName);
  if (incoming.length === 0) return;
  const summary = incoming.map((m) => `receive from ${m.from}@${teamName}: ${m.body}`).join("\n");
  pi.sendMessage(
    {
      customType: "pinet-team",
      content: summary,
      display: true,
    },
    { triggerTurn: true }
  );
}

// =============================================================================
// Helpers
// =============================================================================

function countLines(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf-8").trim();
  return content ? content.split("\n").length : 0;
}

function debounce(state: WatcherState | null, ms: number, fn: () => void) {
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    fn();
  }, ms);
}

function stopWatcher(state: WatcherState | null) {
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.watcher.close();
}
