/**
 * PiNet — Permanent Agent Network (PoC)
 *
 * Minimal extension that lets pi agents send DMs to each other via files.
 *
 * Usage:
 *   /pinet <name>     — log in as <name>, start watching for messages
 *   /pinet off        — go offline
 *   /pinet            — show status
 *
 * Tools (registered after login):
 *   pinet_send        — send a DM to another agent
 *   pinet_mail        — check your personal messages
 *   pinet_list        — list online agents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

interface Identity {
  name: string;
  created: string;
}

interface PersonalMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
}

interface PresenceEntry {
  name: string;
  status: "online" | "offline";
  pid: number;
  lastSeen: string;
}

// =============================================================================
// State
// =============================================================================

const PINET_DIR = path.join(process.env.HOME || "~", ".pinet");

let myIdentity: Identity | null = null;
let myWatcher: fs.FSWatcher | null = null;
let myLineCount = 0; // lines in mailbox at login — anything after is new
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// =============================================================================
// Helpers
// =============================================================================

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function pinetPath(...segments: string[]): string {
  return path.join(PINET_DIR, ...segments);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJsonl(filePath: string): PersonalMessage[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((m): m is PersonalMessage => m !== null);
}

function appendJsonl(filePath: string, obj: unknown) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n");
}

function writePresence(name: string, status: "online" | "offline") {
  ensureDir(pinetPath("presence"));
  const entry: PresenceEntry = {
    name,
    status,
    pid: process.pid,
    lastSeen: new Date().toISOString(),
  };
  fs.writeFileSync(pinetPath("presence", `${name}.json`), JSON.stringify(entry, null, 2));
}

function readAllPresence(): PresenceEntry[] {
  const dir = pinetPath("presence");
  if (!fs.existsSync(dir)) return [];
  const entries: PresenceEntry[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const entry: PresenceEntry = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf-8")
      );
      // Clean up stale entries
      if (entry.status === "online" && !isProcessAlive(entry.pid)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch {}
        continue;
      }
      entries.push(entry);
    } catch {}
  }
  return entries;
}

function readOwnMailbox(): PersonalMessage[] {
  if (!myIdentity) return [];
  return readJsonl(pinetPath("mailboxes", `${myIdentity.name}.mailbox.jsonl`));
}

// =============================================================================
// Message Delivery — feed into agent conversation
// =============================================================================

function deliverMessages(pi: ExtensionAPI, messages: PersonalMessage[]) {
  if (messages.length === 0) return;

  const summary = messages
    .map((m) => `${m.from}: ${m.body}`)
    .join("\n");

  pi.sendMessage(
    {
      customType: "pinet",
      content: `[PiNet] ${messages.length} new message${messages.length > 1 ? "s" : ""}:\n${summary}`,
      display: true,
    },
    {
      triggerTurn: true,
    }
  );
}

// =============================================================================
// Watcher — detects new messages in personal mailbox
// =============================================================================

function startWatcher(pi: ExtensionAPI) {
  if (!myIdentity) return;

  const mailboxPath = pinetPath("mailboxes", `${myIdentity.name}.mailbox.jsonl`);
  ensureDir(path.dirname(mailboxPath));

  // Capture baseline
  if (fs.existsSync(mailboxPath)) {
    const content = fs.readFileSync(mailboxPath, "utf-8").trim();
    myLineCount = content ? content.split("\n").length : 0;
  } else {
    myLineCount = 0;
  }

  try {
    myWatcher = fs.watch(path.dirname(mailboxPath), (eventType, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;
      if (filename !== `${myIdentity!.name}.mailbox.jsonl`) return;

      // Debounce rapid events
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        processNewMessages(pi);
      }, 100);
    });
  } catch {
    // Can't watch — polling fallback not needed for PoC
  }
}

function processNewMessages(pi: ExtensionAPI) {
  if (!myIdentity) return;

  const allMessages = readOwnMailbox();
  const newMessages = allMessages.slice(myLineCount);
  myLineCount = allMessages.length;

  if (newMessages.length > 0) {
    deliverMessages(pi, newMessages);
  }
}

function stopWatcher() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (myWatcher) {
    myWatcher.close();
    myWatcher = null;
  }
}

// =============================================================================
// Tool Registration
// =============================================================================

function registerTools(pi: ExtensionAPI) {
  // pinet_send — send DM
  pi.registerTool({
    name: "pinet_send",
    label: "Send PiNet Message",
    description:
      "Send a direct message to another agent on the PiNet network. " +
      "The recipient will receive it immediately if online, or on next login if offline.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name" }),
      message: Type.String({ description: "Message text" }),
    }),
    async execute(_toolCallId, params) {
      if (!myIdentity) {
        return {
          content: [{ type: "text", text: "Not logged in. Use /pinet <name> first." }],
        };
      }

      const { to, message } = params as { to: string; message: string };

      // Validate recipient exists (has a presence file or identity)
      const allPresence = readAllPresence();
      const recipientOnline = allPresence.some((p) => p.name === to);

      // Even if offline, we deliver — messages queue
      const msg: PersonalMessage = {
        id: randomUUID(),
        from: myIdentity.name,
        to,
        body: message,
        timestamp: new Date().toISOString(),
      };

      const mailboxPath = pinetPath("mailboxes", `${to}.mailbox.jsonl`);
      appendJsonl(mailboxPath, msg);

      return {
        content: [
          {
            type: "text",
            text: `Message sent to ${to}. ${recipientOnline ? "They are online." : "They are currently offline — message will be delivered on next login."}`,
          },
        ],
      };
    },
  });

  // pinet_mail — check personal messages
  pi.registerTool({
    name: "pinet_mail",
    label: "Check PiNet Mail",
    description:
      "Check your personal PiNet mailbox for messages from other agents.",
    parameters: Type.Object({
      unreadOnly: Type.Optional(
        Type.Boolean({ description: "Only show unread messages (default: true)" })
      ),
    }),
    async execute(_toolCallId, params) {
      if (!myIdentity) {
        return {
          content: [{ type: "text", text: "Not logged in. Use /pinet <name> first." }],
        };
      }

      const { unreadOnly = true } = params as { unreadOnly?: boolean };
      const allMessages = readOwnMailbox();

      let messages = allMessages;
      if (unreadOnly) {
        messages = allMessages.slice(myLineCount);
      }

      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: unreadOnly ? "No unread messages." : "No messages." }],
        };
      }

      const formatted = messages
        .map((m) => `[${new Date(m.timestamp).toLocaleTimeString()}] ${m.from}: ${m.body}`)
        .join("\n");

      return {
        content: [{ type: "text", text: formatted }],
      };
    },
  });

  // pinet_list — list online agents
  pi.registerTool({
    name: "pinet_list",
    label: "List PiNet Agents",
    description: "List all agents on the PiNet network and their online status.",
    parameters: Type.Object({}),
    async execute() {
      const allPresence = readAllPresence();

      if (allPresence.length === 0) {
        return {
          content: [{ type: "text", text: "No agents on the network." }],
        };
      }

      const lines = allPresence.map((p) => {
        const indicator = p.status === "online" ? "🟢" : "⚪";
        const ago = new Date(p.lastSeen).toLocaleTimeString();
        return `${indicator} ${p.name} (${p.status}, last seen ${ago})`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  });
}

// =============================================================================
// Login / Logout
// =============================================================================

function doLogin(pi: ExtensionAPI, name: string, ctx: { hasUI: boolean; ui: any }) {
  // Validate name
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    if (ctx.hasUI) ctx.ui.notify("Invalid name. Use letters, numbers, underscore, hyphen.", "error");
    return;
  }

  // Check if name is already online (different PID)
  const existingPath = pinetPath("presence", `${name}.json`);
  if (fs.existsSync(existingPath)) {
    try {
      const existing: PresenceEntry = JSON.parse(fs.readFileSync(existingPath, "utf-8"));
      if (existing.status === "online" && isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        if (ctx.hasUI) ctx.ui.notify(`"${name}" is already online (PID ${existing.pid})`, "error");
        return;
      }
    } catch {}
  }

  // Register identity
  myIdentity = { name, created: new Date().toISOString() };
  ensureDir(pinetPath());
  appendJsonl(pinetPath("identities.jsonl"), myIdentity);

  // Set presence online
  writePresence(name, "online");

  // Start watching mailbox
  startWatcher(pi);

  // Register tools
  registerTools(pi);

  // Deliver any backlog
  const backlog = readOwnMailbox().slice(myLineCount);
  // Don't deliver backlog yet — let the agent ask for it via pinet_mail

  const backlogNote = backlog.length > 0 ? `\n  ${backlog.length} unread messages waiting. Use pinet_mail to read them.` : "";

  if (ctx.hasUI) {
    ctx.ui.notify(`Logged in as ${name} ✨${backlogNote}`, "success");
  }
}

function doLogout(ctx: { hasUI: boolean; ui: any }) {
  if (!myIdentity) {
    if (ctx.hasUI) ctx.ui.notify("Not logged in.", "warning");
    return;
  }

  const name = myIdentity.name;
  writePresence(name, "offline");
  stopWatcher();
  myIdentity = null;
  myLineCount = 0;

  if (ctx.hasUI) {
    ctx.ui.notify(`${name} went offline.`, "info");
  }
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
  // /pinet command
  pi.registerCommand("pinet", {
    description: "Log into PiNet: /pinet <name> | /pinet off | /pinet (status)",

    handler: async (args, ctx) => {
      const arg = args.trim();

      // Logout
      if (arg === "off") {
        doLogout(ctx);
        return;
      }

      // Status (already logged in, no arg)
      if (!arg && myIdentity) {
        const presence = readAllPresence();
        const onlineCount = presence.filter((p) => p.status === "online" && p.name !== myIdentity!.name).length;
        const mailbox = readOwnMailbox();
        const unread = mailbox.length - myLineCount;

        ctx.ui.notify(
          `Logged in as ${myIdentity.name}\n  ${onlineCount} peer${onlineCount !== 1 ? "s" : ""} online\n  ${unread} unread message${unread !== 1 ? "s" : ""}`,
          "info"
        );
        return;
      }

      // Need a name
      if (!arg) {
        ctx.ui.notify("Usage: /pinet <name>", "warning");
        return;
      }

      // Already logged in?
      if (myIdentity) {
        ctx.ui.notify(`Already logged in as ${myIdentity.name}. Use /pinet off first.`, "warning");
        return;
      }

      doLogin(pi, arg, ctx);
    },
  });

  // Clean up on shutdown
  pi.on("session_shutdown", () => {
    if (myIdentity) {
      writePresence(myIdentity.name, "offline");
      stopWatcher();
    }
  });
}
