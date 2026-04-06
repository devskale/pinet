/**
 * PiNet — Permanent Agent Network
 *
 * Agent-to-agent DMs + team chats via files. Zero server.
 *
 * Usage:
 *   /pinet                       — auto-login (binding or generated name)
 *   /pinet <name>                — log in (DMs only)
 *   /pinet <name>@<team>         — log in + join/create team
 *   /pinet <name>@<t1>,<t2>      — log in + join multiple teams
 *   /pinet                       — show status (when logged in)
 *   /pinet off                   — go offline
 */

import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  pinetPath, exists, readFile, isProcessAlive,
  readAllPresence, readJsonl, readJson, appendJsonl, readTeamMessages,
  writePresence, writeIdentity, writeBinding, readBinding,
  generateName, joinTeam, readDeliveryMode, setDeliveryMode, writeJson,
} from "./store";
import { NAME_PATTERN, TeamMessage, TeamMeta, DELIVERY_MODES, DeliveryMode } from "./types";
import {
  initPersonalPointer, initTeamPointer,
  resetPointers, getPersonalLineCount, getTeamLineCount,
  bumpTeamLineCount, setPointerIdentity,
} from "./read-state";
import {
  registerPersonalTools, registerTeamTools,
  setToolIdentity, resetToolIdentity,
} from "./tools";

// =============================================================================
// Types
// =============================================================================

interface CommandContext {
  ui?: {
    notify?: (message: string, type: string) => void;
  };
}

// =============================================================================
// State
// =============================================================================

let myName: string | null = null;
let myTeams: string[] = [];
let syncProcess: child_process.ChildProcess | null = null;
let piRef: ExtensionAPI | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let presenceSweeperTimer: ReturnType<typeof setInterval> | null = null;

// =============================================================================
// Parse "Name@team1,team2"
// =============================================================================

function parseLoginArg(arg: string): { name: string; teams: string[]; teamRoles: Record<string, string> } {
  const at = arg.indexOf("@");
  if (at === -1) return { name: arg, teams: [], teamRoles: {} };
  const teamRoles: Record<string, string> = {};
  const teams = arg
    .slice(at + 1)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const colon = t.indexOf(":");
      if (colon !== -1) {
        const teamName = t.slice(0, colon);
        teamRoles[teamName] = t.slice(colon + 1);
        return teamName;
      }
      return t;
    });
  return { name: arg.slice(0, at), teams, teamRoles };
}

// =============================================================================
// Unread count helper
// =============================================================================

function teamUnread(team: string): number {
  return readTeamMessages(team, getTeamLineCount(team))
    .filter((m: TeamMessage) => m.from !== myName).length;
}

// =============================================================================
// Login
// =============================================================================

function doLogin(pi: ExtensionAPI, name: string, teams: string[], teamRoles: Record<string, string>, ctx: CommandContext, force: boolean = false) {
  // Validate
  if (!NAME_PATTERN.test(name)) {
    ctx.ui?.notify?.("Invalid name. Use letters, numbers, _ or -.", "error");
    return;
  }
  for (const t of teams) {
    if (!NAME_PATTERN.test(t)) {
      ctx.ui?.notify?.(`Invalid team name "${t}".`, "error");
      return;
    }
  }

  // Check name conflict
  const presenceFile = pinetPath("presence", `${name}.json`);
  if (!force && exists(presenceFile)) {
    try {
      const pe = JSON.parse(readFile(presenceFile));
      if (pe.status === "online" && isProcessAlive(pe.pid) && pe.pid !== process.pid) {
        ctx.ui?.notify?.(`"${name}" is already online (PID ${pe.pid}). Use /pinet off first, or /pinet --force ${name} to override.`, "error");
        return;
      }
    } catch { /* stale file, proceed */ }
  }

  // Set identity
  myName = name;
  myTeams = teams;

  // Persist
  writeIdentity(name);
  writeBinding(name, teams);
  writePresence(name, "online");

  // Init subsystems
  setToolIdentity(name, teams);
  setPointerIdentity(name);
  initPersonalPointer();
  registerPersonalTools(pi);

  for (const team of teams) {
    joinTeam(team, name, teamRoles[team]);
    initTeamPointer(team);
  }
  if (teams.length > 0) registerTeamTools(pi);

  // Start sync daemon if relay.json exists
  startSyncDaemon(ctx);

  // Notify user
  const backlog =
    readJsonl(pinetPath("mailboxes", `${name}.mailbox.jsonl`), getPersonalLineCount()).length;

  const lines = [`${name} online`];
  if (teams.length > 0) lines.push(teams.map((t) => `#${t}`).join(", "));
  if (backlog > 0) lines.push(`${backlog} DMs`);

  ctx.ui?.notify?.(lines.join(" "), "success");

  // Presence heartbeat — refresh lastSeen every 30s
  heartbeatTimer = setInterval(() => {
    if (myName) writePresence(myName, "online");
    else if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }, 30_000);

  // Presence sweeper — clean up stale entries every 60s
  presenceSweeperTimer = setInterval(() => { readAllPresence(); }, 60_000);
}

// =============================================================================
// Logout
// =============================================================================

function doLogout(ctx: CommandContext) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in.", "warning");
    return;
  }

  writePresence(myName, "offline");
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (presenceSweeperTimer) { clearInterval(presenceSweeperTimer); presenceSweeperTimer = null; }
  resetPointers();
  resetToolIdentity();
  stopSyncDaemon();

  const name = myName;
  myName = null;
  myTeams = [];

  ctx.ui?.notify?.(`${name} offline`, "info");
}

// =============================================================================
// Status
// =============================================================================

function showStatus(ctx: CommandContext) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in.", "warning");
    return;
  }

  const peers = readAllPresence().filter(
    (p) => p.status === "online" && p.name !== myName
  );
  const dmUnread =
    readJsonl(pinetPath("mailboxes", `${myName}.mailbox.jsonl`), getPersonalLineCount()).length;

  const lines = [`${myName}`];
  if (myTeams.length > 0) {
    lines.push(
      myTeams
        .map((t) => {
          const u = teamUnread(t);
          return `#${t}${u > 0 ? ` (${u})` : ""}`;
        })
        .join(", ")
    );
  }
  lines.push(`${peers.length} peer${peers.length !== 1 ? "s" : ""}`);
  if (dmUnread > 0) lines.push(`${dmUnread} DMs`);

  ctx.ui?.notify?.(lines.join(" "), "info");
}

// =============================================================================
// Sync daemon (relay bridge)
// =============================================================================

function startSyncDaemon(ctx: CommandContext) {
  const relayConfig = pinetPath("relay.json");
  if (!exists(relayConfig)) return; // no relay configured, local only

  if (syncProcess && !syncProcess.killed) return; // already running

  const syncPath = path.join(__dirname, "sync.mjs");
  if (!exists(syncPath)) {
    ctx.ui?.notify?.("sync.mjs not found — relay sync disabled", "warning");
    return;
  }

  if (!myName) return; // no identity yet — nothing to sync

  syncProcess = child_process.fork(syncPath, [], {
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    detached: false,
    env: { ...process.env, PINET_AGENT_NAME: myName },
  });

  syncProcess.on("error", (err) => {
    ctx.ui?.notify?.(`Sync daemon error: ${err.message}`, "error");
    syncProcess = null;
  });

  syncProcess.on("exit", (code) => {
    if (code && code !== 0) {
      ctx.ui?.notify?.(`Sync daemon exited (code ${code})`, "warning");
    }
    syncProcess = null;
  });

  // Relay IPC: deliver messages from sync daemon directly to agent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  syncProcess.on("message", (msg: any) => {
    if (msg.type !== "pinet-deliver") return;
    if (!myName || !piRef) return;

    if (msg.channel === "team" && msg.lines) {
      const teamName = (msg.path as string)?.split("/")[1];
      const incoming = (msg.lines as unknown[])
        .map((l) => {
          if (typeof l === "string") { try { return JSON.parse(l); } catch { return null; } }
          return l;
        })
        .filter((m): m is { from: string; body: string } => m != null && m.from !== myName);
      if (incoming.length === 0 || !teamName) return;
      const summary = incoming.map((m) => `receive from ${m.from}@${teamName}: ${m.body}`).join("\n");
      const mode = readDeliveryMode(teamName);
      piRef.sendMessage({ customType: "pinet-team", content: summary, display: true }, { triggerTurn: mode === "interrupt" });
    }

    if (msg.channel === "write") {
      const summary = `receive from ${msg.from as string}: ${(msg.content as string) ?? ""}`;
      piRef.sendMessage({ customType: "pinet", content: summary, display: true }, { triggerTurn: true });
    }
  });

  ctx.ui?.notify?.("Sync daemon started — relay bridge active", "info");
}

function stopSyncDaemon() {
  if (syncProcess && !syncProcess.killed) {
    syncProcess.kill();
    syncProcess = null;
  }
}

// =============================================================================
// Setup wizard
// =============================================================================

function doSetup(args: string, ctx: CommandContext) {
  // /pinet setup — show status
  if (!args) return showSetupStatus(ctx);

  const spaceIdx = args.indexOf(" ");
  const sub = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : args.slice(spaceIdx + 1).trim();

  if (sub === "relay") return doSetupRelay(rest, ctx);
  if (sub === "invite") return doSetupInvite(rest, ctx);
  if (sub === "join") return doSetupJoin(rest, ctx);

  ctx.ui?.notify?.("Usage: /pinet setup [relay|invite|join]", "warning");
}

function doWizard(args: string, ctx: CommandContext) {
  const parts = args.split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    ctx.ui?.notify?.(
      [
        "PiNet Wizard — one command to set up everything",
        "",
        "Create a team (you're the first):",
        "  /pinet wizard <url> <token> <machine> <team>",
        "",
        "Join a team (someone gave you the token):",
        "  /pinet wizard <url> <token> <machine> <team:token>",
        "  /pinet wizard <url> <token> <team:token>",
        "",
        "Relay only (no team):",
        "  /pinet wizard <url> <token> <machine>",
        "  /pinet wizard <url> <token>",
        "",
        "Examples:",
        "  /pinet wizard wss://relay:7654 secret mac build",
        "  /pinet wizard wss://relay:7654 secret pi5 build:a1b2c3d4e5f6a1b2",
        "  /pinet wizard wss://relay:7654 secret mac",
      ].join("\n"),
      "info"
    );
    return;
  }

  const [url, token, maybeMachine, maybeTeam] = parts;

  // Figure out which arg is machine and which is team
  // team can be "name" or "name:token"
  let machine: string;
  let teamArg: string | undefined;

  if (maybeTeam !== undefined) {
    // 4 args: url token machine team[:token]
    machine = maybeMachine;
    teamArg = maybeTeam;
  } else if (maybeMachine !== undefined) {
    // 3 args: ambiguous — resolve by colon
    //   "build:a1b2c3" → team:token (join), auto-detect machine
    //   "mac"           → machine name, relay only
    // To create a team without specifying machine, use 4 args.
    if (maybeMachine.includes(":")) {
      machine = os.hostname().split(".")[0] || "agent";
      teamArg = maybeMachine;
    } else {
      machine = maybeMachine;
    }
  } else {
    // 2 args: url token
    machine = os.hostname().split(".")[0] || "agent";
  }

  // Preserve existing teams if overwriting
  const existingTeams: Record<string, string> = {};
  const relayPath = pinetPath("relay.json");
  if (exists(relayPath)) {
    const prev = readJson<Record<string, unknown>>(relayPath);
    const prevTeams = prev?.teams as Record<string, string> | undefined;
    if (prevTeams) Object.assign(existingTeams, prevTeams);
  }

  // Handle team
  let newTeamName: string | undefined;
  let newTeamToken: string | undefined;
  let joining = false;

  if (teamArg) {
    const colonIdx = teamArg.indexOf(":");
    if (colonIdx !== -1) {
      // team:token — joining
      newTeamName = teamArg.slice(0, colonIdx);
      newTeamToken = teamArg.slice(colonIdx + 1);
      joining = true;
    } else {
      // team (no token) — creating
      newTeamName = teamArg;
      newTeamToken = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      joining = false;
    }

    if (!NAME_PATTERN.test(newTeamName)) {
      ctx.ui?.notify?.(`Invalid team name "${newTeamName}". Use letters, numbers, _ or -.`, "error");
      return;
    }

    existingTeams[newTeamName] = newTeamToken;
  }

  // Write relay.json
  writeJson(relayPath, {
    url,
    token,
    machine,
    teams: existingTeams,
  });

  // Build output
  const lines = ["relay.json saved", `  url: ${url}`, `  machine: ${machine}`];

  if (newTeamName && joining) {
    lines.push(`  joined #${newTeamName}`);
    lines.push("");
    lines.push(`Login with: /pinet <name>@${newTeamName}`);
  } else if (newTeamName && !joining) {
    lines.push(`  created #${newTeamName} (token: ${newTeamToken})`);
    lines.push("");
    lines.push("Share this relay.json with teammates:");
    lines.push(JSON.stringify({
      url,
      token,
      machine: "THEIR_MACHINE",
      teams: { [newTeamName]: newTeamToken },
    }, null, 2));
    lines.push("");
    lines.push("They save it as ~/.pinet/relay.json and run /pinet <name>@" + newTeamName);
    lines.push("");
    lines.push(`Login with: /pinet <name>@${newTeamName}`);
  } else {
    lines.push("  teams: none");
    lines.push("");
    lines.push("Next: create a team with /pinet wizard <url> <token> <machine> <team>");
  }

  ctx.ui?.notify?.(lines.join("\n"), "success");
}

function showSetupStatus(ctx: CommandContext) {
  const relayPath = pinetPath("relay.json");
  const lines = ["PiNet Setup"];

  if (exists(relayPath)) {
    const cfg = readJson<Record<string, unknown>>(relayPath);
    lines.push(`Relay: ${cfg?.url ?? "?"}`);
    lines.push(`Machine: ${cfg?.machine ?? "?"}`);
    const teams = cfg?.teams as Record<string, string> | undefined;
    if (teams && Object.keys(teams).length > 0) {
      lines.push(`Teams: ${Object.keys(teams).map(t => `#${t}`).join(", ")}`);
    } else {
      lines.push("Teams: none");
    }
    lines.push("");
    lines.push("Config OK. Commands:");
    lines.push("  /pinet setup invite <team>  — generate token to share");
    lines.push("  /pinet setup join <team> <token>  — add team");
  } else {
    lines.push("No relay.json found.");
    lines.push("");
    lines.push("To connect to a relay:");
    lines.push("  /pinet setup relay <url> <token> [machine]");
    lines.push("");
    lines.push("Example:");
    lines.push("  /pinet setup relay wss://relay.example.com:7654 my-secret-token mac");
    lines.push("");
    lines.push("Ask the relay operator for the URL and network token.");
  }

  ctx.ui?.notify?.(lines.join("\n"), "info");
}

function doSetupRelay(args: string, ctx: CommandContext) {
  const parts = args.split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    ctx.ui?.notify?.("Usage: /pinet setup relay <url> <token> [machine]", "warning");
    return;
  }

  const [url, token, machine] = parts;
  const effectiveMachine = machine || os.hostname().split(".")[0] || "agent";

  const config: Record<string, unknown> = { url, token, machine: effectiveMachine };

  // Preserve existing teams if overwriting
  const existingPath = pinetPath("relay.json");
  if (exists(existingPath)) {
    const prev = readJson<Record<string, unknown>>(existingPath);
    if (prev?.teams) config.teams = prev.teams;
  }

  writeJson(pinetPath("relay.json"), config);

  ctx.ui?.notify?.(
    [
      `relay.json saved`,
      `  url: ${url}`,
      `  machine: ${effectiveMachine}`,
      `  teams: ${config.teams ? Object.keys(config.teams as Record<string, unknown>).length : 0}`,
      "",
      "Next: /pinet setup invite <team> to create a team, or /pinet setup join <team> <token>",
    ].join("\n"),
    "success"
  );
}

function doSetupInvite(args: string, ctx: CommandContext) {
  const team = args.trim().split(/\s+/)[0];
  if (!team) {
    ctx.ui?.notify?.("Usage: /pinet setup invite <team>", "warning");
    return;
  }
  if (!NAME_PATTERN.test(team)) {
    ctx.ui?.notify?.(`Invalid team name. Use letters, numbers, _ or -.`, "error");
    return;
  }

  const relayPath = pinetPath("relay.json");
  if (!exists(relayPath)) {
    ctx.ui?.notify?.("No relay.json. Run /pinet setup relay <url> <token> first.", "error");
    return;
  }

  const config = readJson<Record<string, string | Record<string, string>>>(relayPath);
  if (!config) {
    ctx.ui?.notify?.("relay.json is corrupted.", "error");
    return;
  }

  // Generate team token
  const teamToken = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  if (!config.teams) config.teams = {};
  (config.teams as Record<string, string>)[team] = teamToken;
  writeJson(relayPath, config);

  // Show snippet to share
  const snippet = JSON.stringify({
    url: config.url,
    token: config.token,
    machine: "THEIR_MACHINE",
    teams: { [team]: teamToken },
  }, null, 2);

  ctx.ui?.notify?.(
    [
      `Team #${team} created. Token: ${teamToken}`,
      "",
      "Share this relay.json with teammates:",
      snippet,
      "",
      "They save it as ~/.pinet/relay.json and run /pinet <name>@" + team,
    ].join("\n"),
    "success"
  );
}

function doSetupJoin(args: string, ctx: CommandContext) {
  const parts = args.split(/\s+/);
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    ctx.ui?.notify?.("Usage: /pinet setup join <team> <token>", "warning");
    return;
  }

  const [team, teamToken] = parts;
  if (!NAME_PATTERN.test(team)) {
    ctx.ui?.notify?.(`Invalid team name.`, "error");
    return;
  }

  const relayPath = pinetPath("relay.json");
  if (!exists(relayPath)) {
    ctx.ui?.notify?.("No relay.json. Run /pinet setup relay <url> <token> first.", "error");
    return;
  }

  const config = readJson<Record<string, string | Record<string, string>>>(relayPath);
  if (!config) {
    ctx.ui?.notify?.("relay.json is corrupted.", "error");
    return;
  }

  if (!config.teams) config.teams = {};
  (config.teams as Record<string, string>)[team] = teamToken;
  writeJson(relayPath, config);

  ctx.ui?.notify?.(
    [
      `Joined #${team}`,
      `relay.json updated (${Object.keys(config.teams as Record<string, string>).length} teams)`,
      "",
      `Login with: /pinet <name>@${team}`,
    ].join("\n"),
    "success"
  );
}

function doWhoami(ctx: CommandContext) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in.", "warning");
    return;
  }
  const teams = myTeams.length > 0 ? myTeams.map(t => {
    const meta = readJson<TeamMeta>(pinetPath("teams", t, "meta.json"));
    const role = meta?.roles?.[myName!] || "member";
    const delivery = meta?.delivery ?? "interrupt";
    return `#${t} (${role}, ${delivery})`;
  }).join(", ") : "none";
  ctx.ui?.notify?.(`${myName} — Teams: ${teams}`, "info");
}

function doMode(args: string, ctx: CommandContext) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in.", "warning");
    return;
  }

  // /pinet mode — show current modes
  if (!args) {
    if (myTeams.length === 0) {
      ctx.ui?.notify?.("Not in any teams.", "warning");
      return;
    }
    const lines = myTeams.map(t => {
      const mode = readDeliveryMode(t);
      return `#${t}: ${mode}`;
    });
    ctx.ui?.notify?.(lines.join(", "), "info");
    return;
  }

  // /pinet mode <team> <mode>
  const parts = args.split(/\s+/);
  if (parts.length < 2) {
    ctx.ui?.notify?.("Usage: /pinet mode <team> <interrupt|digest|silent>", "warning");
    return;
  }
  const [team, mode] = parts;
  if (!myTeams.includes(team)) {
    ctx.ui?.notify?.(`Not in #${team}.`, "error");
    return;
  }
  if (!DELIVERY_MODES.includes(mode as DeliveryMode)) {
    ctx.ui?.notify?.(`Invalid mode. Use: ${DELIVERY_MODES.join(", ")}`, "error");
    return;
  }
  setDeliveryMode(team, mode as DeliveryMode);
  ctx.ui?.notify?.(`#${team} delivery: ${mode}`, "success");
}

function doMsg(args: string, ctx: CommandContext) {
  if (!myName) {
    ctx.ui?.notify?.("Not logged in. Use /pinet <name>@<team> first.", "warning");
    return;
  }
  if (!args) {
    ctx.ui?.notify?.("Usage: /pinet msg <agent>[@<team>] <message>", "warning");
    return;
  }

  const spaceIdx = args.indexOf(" ");
  if (spaceIdx === -1) {
    ctx.ui?.notify?.("Usage: /pinet msg <agent>[@<team>] <message>", "warning");
    return;
  }

  let targetSpec = args.slice(0, spaceIdx).trim().replace(/[,:;!]+$/, "");
  const body = args.slice(spaceIdx + 1).trim();

  if (!targetSpec || !body) {
    ctx.ui?.notify?.("Usage: /pinet msg <agent>[@<team>] <message>", "warning");
    return;
  }

  // Parse optional @team suffix: "BackendDev@build" → target=BackendDev, teamHint=build
  let target = targetSpec;
  let teamHint: string | undefined;
  const atIdx = targetSpec.lastIndexOf("@");
  if (atIdx !== -1) {
    target = targetSpec.slice(0, atIdx);
    teamHint = targetSpec.slice(atIdx + 1);
  }

  // Find shared team with this agent
  const sharedTeams = myTeams.filter(t => {
    const meta = readJson<TeamMeta>(pinetPath("teams", t, "meta.json"));
    return meta?.members?.includes(target);
  });

  if (sharedTeams.length === 0) {
    ctx.ui?.notify?.(`No shared team with "${target}". Both must be in the same team.`, "warning");
    return;
  }

  let team: string;
  if (teamHint) {
    if (!sharedTeams.includes(teamHint)) {
      ctx.ui?.notify?.(`No shared team #${teamHint} with "${target}". Shared: ${sharedTeams.map(t => `#${t}`).join(", ")}.`, "warning");
      return;
    }
    team = teamHint;
  } else if (sharedTeams.length === 1) {
    team = sharedTeams[0];
  } else {
    ctx.ui?.notify?.(
      `Ambiguous — ${sharedTeams.length} shared teams with "${target}": ${sharedTeams.map(t => `#${t}`).join(", ")}. ` +
      `Use /pinet msg ${target}@<team> <message>`,
      "warning"
    );
    return;
  }

  const msg = {
    id: crypto.randomUUID(),
    from: myName,
    body: `@${target} ${body}`,
    timestamp: new Date().toISOString(),
  };

  appendJsonl(pinetPath("teams", team, "messages.jsonl"), msg);
  bumpTeamLineCount(team);
  ctx.ui?.notify?.(`send to ${myName}@${team} @${target}: ${body}`, "info");
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
  piRef = pi;

  pi.registerCommand("pinet", {
    description: "PiNet: /pinet [name][@team] | wizard | setup | off | msg | mode | whoami",

    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const subcommands = ["off", "msg", "whoami", "mode", "setup", "wizard"];

      // First word — subcommand or login pattern
      if (!prefix.includes(" ")) {
        const items = [...subcommands];
        const matches = items.filter(i => i.startsWith(prefix));
        if (matches.length > 0) return matches.map(m => ({ value: m, label: m }));
        return null;
      }

      // After "mode " — suggest <team> then <mode>
      const parts = prefix.split(" ");
      if (parts[0] === "mode" && parts.length === 2 && !parts[1].includes(" ")) {
        const teamMatches = myTeams.filter(t => t.toLowerCase().startsWith(parts[1].toLowerCase()));
        if (teamMatches.length > 0) return teamMatches.map(t => ({ value: `mode ${t} `, label: `#${t}` }));
        return null;
      }
      if (parts[0] === "mode" && parts.length === 3) {
        const modeMatches = DELIVERY_MODES.filter(m => m.startsWith(parts[2]));
        if (modeMatches.length > 0) return modeMatches.map(m => ({ value: `mode ${parts[1]} ${m}`, label: m }));
        return null;
      }

      // After "setup " — suggest sub-actions
      if (parts[0] === "setup" && parts.length === 2) {
        const setupActions = ["relay", "invite", "join"];
        const filtered = setupActions.filter(a => a.startsWith(parts[1]));
        if (filtered.length > 0) return filtered.map(a => ({ value: `setup ${a} `, label: a }));
        return null;
      }

      // After "msg " — suggest online agents as target
      if (parts[0] === "msg" && parts.length === 2 && !parts[1].includes(" ")) {
        const agents = readAllPresence().filter(p => p.status === "online" && p.name !== myName).map(p => p.name);
        const filtered = agents.filter(a => a.toLowerCase().startsWith(parts[1].toLowerCase()));
        if (filtered.length > 0) return filtered.map(a => ({ value: `msg ${a} `, label: a }));
      }

      return null;
    },

    handler: async (args, ctx) => {
      const arg = args.trim();

      // ── Logout ──────────────────────────────────
      if (arg === "off") return doLogout(ctx);
      if (arg === "whoami") return doWhoami(ctx);

      // ── Setup wizard ──────────────────────────────
      if (arg === "setup") return doSetup("", ctx);
      if (arg.startsWith("setup ")) return doSetup(arg.slice(6).trim(), ctx);

      // ── One-shot wizard ───────────────────────────
      if (arg === "wizard") return doWizard("", ctx);
      if (arg.startsWith("wizard ")) return doWizard(arg.slice(7).trim(), ctx);

      // ── Send message to team member ────────────
      if (arg.startsWith("msg ")) return doMsg(arg.slice(4).trim(), ctx);

      // ── Delivery mode ────────────────────────────
      if (arg === "mode") return doMode("", ctx);
      if (arg.startsWith("mode ")) return doMode(arg.slice(5).trim(), ctx);

      // ── Force override ───────────────────────────
      const force = arg.startsWith("--force");
      const cleanArg = force ? arg.replace(/--force\s*/, "").trim() : arg;
      const effectiveArg = cleanArg;

      // ── Status ──────────────────────────────────
      if (!effectiveArg && myName) return showStatus(ctx);

      // ── Auto-login ──────────────────────────────
      if (!effectiveArg && !myName) {
        const binding = readBinding();
        return doLogin(
          pi,
          binding ? binding.name : generateName(),
          binding ? binding.teams : [],
          {},
          ctx,
          force
        );
      }

      // ── Already logged in ───────────────────────
      if (myName) {
        ctx.ui?.notify?.(
          `Already logged in as ${myName}. Use /pinet off first.`,
          "warning"
        );
        return;
      }

      // ── Login with arg ──────────────────────────
      const { name, teams, teamRoles } = parseLoginArg(effectiveArg);
      doLogin(pi, name, teams, teamRoles, ctx, force);
    },
  });

  // Cleanup on exit
  pi.on("session_shutdown", () => {
    if (myName) {
      writePresence(myName, "offline");
      resetPointers();
    }
    if (presenceSweeperTimer) { clearInterval(presenceSweeperTimer); presenceSweeperTimer = null; }
    stopSyncDaemon();
  });
}
