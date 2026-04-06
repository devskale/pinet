/**
 * PiNet — Tool definitions for the LLM.
 */

import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  pinetPath, readAllPresence, readJsonl, appendJsonl, compactJsonl,
  readTeamMeta, readTeamMessages, setDeliveryMode,
} from "./store";
import { getPersonalLineCount, getTeamLineCount, adjustPersonalPointer, adjustTeamPointer } from "./read-state";
import { PersonalMessage, TeamMessage, DeliveryMode, DELIVERY_MODES } from "./types";

// =============================================================================
// State
// =============================================================================

let myName: string | null = null;
let myTeams: string[] = [];

const TEAM_SEND_LIMIT = 10;
const TEAM_SEND_WINDOW_MS = 60_000;
const TEAM_SEND_MIN_GAP_MS = 5_000;
const MAX_MESSAGE_LENGTH = 2000;
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
      if (message.length > MAX_MESSAGE_LENGTH) return textReply(`Message too long (${message.length}/${MAX_MESSAGE_LENGTH} chars).`);
      const online = readAllPresence().some((p) => p.name === to);

      const mailboxPath = pinetPath("mailboxes", `${to}.mailbox.jsonl`);
      appendJsonl(mailboxPath, {
        id: randomUUID(),
        from: myName,
        to,
        body: message,
        timestamp: new Date().toISOString(),
      } satisfies PersonalMessage);

      const removed = compactJsonl(mailboxPath);
      if (removed > 0) adjustPersonalPointer(removed);

      return textReply(`send to ${myName}->${to}: ${message}${online ? "" : " (offline — queued)"}`);
    },
  });

  pi.registerTool({
    name: "pinet_mail",
    label: "pinet_mail",
    description: "Check your DMs.",
    parameters: Type.Object({}),
    async execute() {
      if (!myName) return textReply("Not logged in.");
      const messages = readJsonl<PersonalMessage>(pinetPath("mailboxes", `${myName}.mailbox.jsonl`), getPersonalLineCount());
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
      if (message.length > MAX_MESSAGE_LENGTH) return textReply(`Message too long (${message.length}/${MAX_MESSAGE_LENGTH} chars).`);

      const now = Date.now();
      const lastSend = teamLastSend.get(team) || 0;
      if (now - lastSend < TEAM_SEND_MIN_GAP_MS) return textReply(`Wait ${Math.ceil((TEAM_SEND_MIN_GAP_MS - (now - lastSend)) / 1000)}s.`);
      const times = (teamSendLog.get(team) || []).filter(t => now - t < TEAM_SEND_WINDOW_MS);
      if (times.length >= TEAM_SEND_LIMIT) return textReply(`Rate limited.`);
      times.push(now);
      teamSendLog.set(team, times);
      teamLastSend.set(team, now);

      const teamPath = pinetPath("teams", team, "messages.jsonl");
      appendJsonl(teamPath, {
        id: randomUUID(), from: myName, team, body: message,
        timestamp: new Date().toISOString(),
      } satisfies TeamMessage);

      const removed = compactJsonl(teamPath);
      if (removed > 0) adjustTeamPointer(team, removed);

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
      const messages = readTeamMessages(team, getTeamLineCount(team));
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
          const delivery = meta?.delivery ?? "interrupt";
          const unread = readTeamMessages(name, getTeamLineCount(name)).filter((m: TeamMessage) => m.from !== myName).length;
          return `#${name} [${members}] ${delivery}${unread > 0 ? ` ${unread} unread` : ""}`;
        }).join("\n")
      );
    },
  });

  pi.registerTool({
    name: "pinet_team_mode",
    label: "pinet_team_mode",
    description: "Set delivery mode for a team. interrupt = wake LLM immediately, digest = queue for manual read, silent = no auto-trigger.",
    parameters: Type.Object({
      team: Type.String({ description: "Team name" }),
      mode: Type.Union(DELIVERY_MODES.map(m => Type.Literal(m)), { description: "interrupt | digest | silent" }),
    }),
    async execute(_id, params) {
      if (!myName) return textReply("Not logged in.");
      const { team, mode } = params as { team: string; mode: DeliveryMode };
      if (!myTeams.includes(team)) return textReply(`Not in #${team}.`);
      if (!DELIVERY_MODES.includes(mode)) return textReply(`Invalid mode. Use: ${DELIVERY_MODES.join(", ")}`);
      const ok = setDeliveryMode(team, mode);
      if (!ok) return textReply(`Team #${team} not found.`);
      return textReply(`#${team} delivery: ${mode}`);
    },
  });
}
