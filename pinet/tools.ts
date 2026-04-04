/**
 * PiNet — Tool definitions for the LLM.
 */

import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  pinetPath, readAllPresence, readJsonl, appendJsonl,
  readTeamMeta, readTeamMessages,
} from "./store";
import { getPersonalLineCount, getTeamLineCount } from "./watchers";
import { PersonalMessage, TeamMessage } from "./types";

// =============================================================================
// State
// =============================================================================

let myName: string | null = null;
let myTeams: string[] = [];

const TEAM_SEND_LIMIT = 10;
const TEAM_SEND_WINDOW_MS = 60_000;
const TEAM_SEND_MIN_GAP_MS = 5_000;
const teamSendLog = new Map<string, number[]>();
const teamLastSend = new Map<string, number>();

export function setToolIdentity(name: string, teams: string[]) {
  myName = name;
  myTeams = teams;
}

export function resetToolIdentity() {
  myName = null;
  myTeams = [];
}

function textReply(text: string) {
  return { content: [{ type: "text", text }] };
}

// =============================================================================
// Personal tools
// =============================================================================

export function registerPersonalTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pinet_send",
    label: "pinet_send",
    description: "Send a DM to an agent. Use for private 1:1 communication.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient" }),
      message: Type.String({ description: "Message" }),
    }),
    async execute(_id, params) {
      if (!myName) return textReply("Not logged in.");
      const { to, message } = params as { to: string; message: string };
      const online = readAllPresence().some((p) => p.name === to);

      appendJsonl(pinetPath("mailboxes", `${to}.mailbox.jsonl`), {
        id: randomUUID(),
        from: myName,
        to,
        body: message,
        timestamp: new Date().toISOString(),
      } satisfies PersonalMessage);

      return textReply(`send to ${myName}->${to}: ${message}`);
    },
  });

  pi.registerTool({
    name: "pinet_mail",
    label: "pinet_mail",
    description: "Check your DMs.",
    parameters: Type.Object({}),
    async execute() {
      if (!myName) return textReply("Not logged in.");
      const all = readJsonl<PersonalMessage>(pinetPath("mailboxes", `${myName}.mailbox.jsonl`));
      const messages = all.slice(getPersonalLineCount());
      if (messages.length === 0) return textReply("No DMs.");
      return textReply(messages.map((m) => `receive from ${m.from}->${myName}: ${m.body}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "pinet_list",
    label: "pinet_list",
    description: "List online agents.",
    parameters: Type.Object({}),
    async execute() {
      const all = readAllPresence();
      if (all.length === 0) return textReply("No agents.");
      return textReply(all.map((p) => `${p.status === "online" ? "●" : "○"} ${p.name}`).join("\n"));
    },
  });
}

// =============================================================================
// Team tools
// =============================================================================

export function registerTeamTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pinet_team_send",
    label: "pinet_team_send",
    description: "Send a message to your team. One sentence max. Facts only. No greetings/emojis/filler.",
    parameters: Type.Object({
      team: Type.String({ description: "Team name" }),
      message: Type.String({ description: "Message" }),
    }),
    async execute(_id, params) {
      if (!myName) return textReply("Not logged in.");
      const { team, message } = params as { team: string; message: string };
      if (!myTeams.includes(team)) return textReply(`Not in #${team}.`);

      const now = Date.now();
      const lastSend = teamLastSend.get(team) || 0;
      if (now - lastSend < TEAM_SEND_MIN_GAP_MS) return textReply(`Wait ${Math.ceil((TEAM_SEND_MIN_GAP_MS - (now - lastSend)) / 1000)}s.`);
      const times = (teamSendLog.get(team) || []).filter(t => now - t < TEAM_SEND_WINDOW_MS);
      if (times.length >= TEAM_SEND_LIMIT) return textReply(`Rate limited.`);
      times.push(now);
      teamSendLog.set(team, times);
      teamLastSend.set(team, now);

      appendJsonl(pinetPath("teams", team, "messages.jsonl"), {
        id: randomUUID(), from: myName, team, body: message,
        timestamp: new Date().toISOString(),
      } satisfies TeamMessage);
      return textReply(`send to ${myName}@${team}: ${message}`);
    },
  });

  pi.registerTool({
    name: "pinet_team_read",
    label: "pinet_team_read",
    description: "Read unread team messages.",
    parameters: Type.Object({
      team: Type.String({ description: "Team name" }),
    }),
    async execute(_id, params) {
      if (!myName) return textReply("Not logged in.");
      const { team } = params as { team: string };
      if (!myTeams.includes(team)) return textReply(`Not in #${team}.`);
      const all = readTeamMessages(team);
      const messages = all.slice(getTeamLineCount(team));
      if (messages.length === 0) return textReply(`No unread in #${team}.`);
      return textReply(messages.map((m) => `receive from ${m.from}@${team}: ${m.body}`).join("\n"));
    },
  });

  pi.registerTool({
    name: "pinet_team_list",
    label: "pinet_team_list",
    description: "List your teams and members.",
    parameters: Type.Object({}),
    async execute() {
      if (!myName) return textReply("Not logged in.");
      if (myTeams.length === 0) return textReply("No teams.");
      return textReply(
        myTeams.map((name) => {
          const meta = readTeamMeta(name);
          const members = meta?.members.join(", ") ?? "?";
          const unread = readTeamMessages(name).slice(getTeamLineCount(name)).filter((m: TeamMessage) => m.from !== myName).length;
          return `#${name} [${members}]${unread > 0 ? ` ${unread} unread` : ""}`;
        }).join("\n")
      );
    },
  });
}
