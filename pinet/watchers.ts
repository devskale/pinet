/**
 * PiNet — File watchers for personal mailbox and team messages
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { pinetPath, ensureDir, readJsonl } from "./store";
import { PersonalMessage, TeamMessage } from "./types";

// =============================================================================
// State (module-scoped, cleared on logout)
// =============================================================================

let myName: string | null = null;

// Personal
let personalWatcher: fs.FSWatcher | null = null;
let personalLineCount = 0;
let personalDebounce: ReturnType<typeof setTimeout> | null = null;

// Teams
let teamWatchers: Map<string, {
  watcher: fs.FSWatcher;
  lineCount: number;
  debounce: ReturnType<typeof setTimeout> | null;
}> = new Map();

// =============================================================================
// Init / Reset
// =============================================================================

export function setWatcherIdentity(name: string) {
  myName = name;
}

export function resetWatchers() {
  myName = null;
  stopPersonalWatcher();
  stopAllTeamWatchers();
  personalLineCount = 0;
}

export function getPersonalLineCount() { return personalLineCount; }
export function getTeamLineCount(team: string): number {
  return teamWatchers.get(team)?.lineCount ?? 0;
}

// =============================================================================
// Delivery
// =============================================================================

function deliverPersonal(pi: ExtensionAPI, messages: PersonalMessage[]) {
  if (messages.length === 0) return;
  const summary = messages.map((m) => `${m.from}: ${m.body}`).join("\n");
  pi.sendMessage(
    { customType: "pinet", content: `[PiNet DM] ${messages.length} new message${messages.length > 1 ? "s" : ""}:\n${summary}`, display: true },
    { triggerTurn: true }
  );
}

function deliverTeam(pi: ExtensionAPI, teamName: string, messages: TeamMessage[]) {
  if (messages.length === 0 || !myName) return;
  const filtered = messages.filter((m) => m.from !== myName);
  if (filtered.length === 0) return;
  const summary = filtered.map((m) => `${m.from}: ${m.body}`).join("\n");
  pi.sendMessage(
    { customType: "pinet-team", content: `[PiNet #${teamName}] ${filtered.length} new message${filtered.length > 1 ? "s" : ""}:\n${summary}`, display: true },
    { triggerTurn: true }
  );
}

// =============================================================================
// Personal Mailbox
// =============================================================================

export function startPersonalWatcher(pi: ExtensionAPI) {
  if (!myName) return;

  const mailboxPath = pinetPath("mailboxes", `${myName}.mailbox.jsonl`);
  ensureDir(path.dirname(mailboxPath));

  if (fs.existsSync(mailboxPath)) {
    const content = fs.readFileSync(mailboxPath, "utf-8").trim();
    personalLineCount = content ? content.split("\n").length : 0;
  } else {
    personalLineCount = 0;
  }

  try {
    personalWatcher = fs.watch(path.dirname(mailboxPath), (_eventType, filename) => {
      if (!filename || filename !== `${myName}.mailbox.jsonl`) return;
      if (personalDebounce) clearTimeout(personalDebounce);
      personalDebounce = setTimeout(() => {
        personalDebounce = null;
        const all = readJsonl(mailboxPath) as PersonalMessage[];
        const newMsgs = all.slice(personalLineCount);
        personalLineCount = all.length;
        if (newMsgs.length > 0) deliverPersonal(pi, newMsgs);
      }, 100);
    });
  } catch {}
}

function stopPersonalWatcher() {
  if (personalDebounce) { clearTimeout(personalDebounce); personalDebounce = null; }
  if (personalWatcher) { personalWatcher.close(); personalWatcher = null; }
}

// =============================================================================
// Team
// =============================================================================

export function startTeamWatcher(pi: ExtensionAPI, teamName: string) {
  const msgPath = pinetPath("teams", teamName, "messages.jsonl");
  ensureDir(path.dirname(msgPath));

  let lineCount = 0;
  if (fs.existsSync(msgPath)) {
    const content = fs.readFileSync(msgPath, "utf-8").trim();
    lineCount = content ? content.split("\n").length : 0;
  }

  try {
    const watcher = fs.watch(path.dirname(msgPath), (_eventType, filename) => {
      if (!filename || filename !== "messages.jsonl") return;
      const state = teamWatchers.get(teamName);
      if (!state) return;
      if (state.debounce) clearTimeout(state.debounce);
      state.debounce = setTimeout(() => {
        if (!state) return;
        state.debounce = null;
        const all = readJsonl(msgPath) as TeamMessage[];
        const newMsgs = all.slice(state.lineCount);
        state.lineCount = all.length;
        if (newMsgs.length > 0) deliverTeam(pi, teamName, newMsgs);
      }, 100);
    });

    teamWatchers.set(teamName, { watcher, lineCount, debounce: null });
  } catch {}
}

function stopAllTeamWatchers() {
  for (const [, state] of teamWatchers) {
    if (state.debounce) clearTimeout(state.debounce);
    state.watcher.close();
  }
  teamWatchers.clear();
}
