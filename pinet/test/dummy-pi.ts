/**
 * dummy-pi — a fake pi host that loads the REAL pinet extension and drives it.
 *
 * Why: tests login / send / receive / logout through the actual extension +
 * sync daemon + relay, without needing the real pi binary.
 *
 * The extension only needs 4 API methods: registerCommand, registerTool,
 * sendMessage, on. We stub them and capture everything.
 *
 * Run with tsx (the extension is TypeScript):
 *   PINET_DIR=/tmp/a npx tsx test/dummy-pi.ts
 *
 * Then feed it commands on stdin, one per line:
 *   login Master@build         # run the /pinet command (the part after /pinet)
 *   cmd off                     # same as typing /pinet off
 *   tool pinet_team_send {"team":"build","message":"hi"}   # call a tool directly
 *   tool pinet_send {"to":"Bob","message":"hey"}
 *   tool pinet_mail {}
 *   tool pinet_team_read {"team":"build"}
 *   tool pinet_list {}
 *   wait 3000                   # sleep ms (let sync daemon deliver)
 *   exit
 *
 * Output is tagged for easy parsing:
 *   [notify]    ui.notify messages (command results)
 *   [tool]      tool execute() result text
 *   [received]  pi.sendMessage (an incoming message reached this agent)
 */
import * as readline from "node:readline";
// Static import — tsx resolves the .ts extension and its type-only imports
// (@mariozechner/*) are erased at runtime, so no install needed.
import piNet from "../index";

// ── Fake ExtensionAPI ─────────────────────────────────────────────────────
const commands = new Map<string, any>();
const tools = new Map<string, any>();
let shutdownHandler: (() => void) | null = null;

const api: any = {
  registerCommand(name: string, config: any) {
    commands.set(name, config);
  },
  registerTool(config: any) {
    tools.set(config.name, config);
  },
  sendMessage(msg: { content: string }, _opts?: any) {
    // This is the agent RECEIVING a message (sync daemon → IPC → sendMessage).
    console.log(`[received] ${msg.content}`);
  },
  on(event: string, handler: () => void) {
    if (event === "session_shutdown") shutdownHandler = handler;
  },
};

piNet(api);

// ── Driver ────────────────────────────────────────────────────────────────
function notify(name: string) {
  return (message: string, _type?: string) => console.log(`[notify] ${message}`);
}

async function handleLine(line: string): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return true; // comment / blank

  const spaceIdx = trimmed.indexOf(" ");
  const head = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  // ── login / cmd: run the /pinet command ─────────────────────────────
  if (head === "login" || head === "cmd") {
    const args = head === "login" ? rest : rest;
    const cmd = commands.get("pinet");
    if (!cmd) { console.log("[error] pinet command not registered"); return true; }
    await cmd.handler(args, { ui: { notify: notify("pinet") } });
    return true;
  }

  // ── tool: call a registered tool directly ───────────────────────────
  if (head === "tool") {
    const toolSpace = rest.indexOf(" ");
    const toolName = toolSpace === -1 ? rest : rest.slice(0, toolSpace);
    const jsonStr = toolSpace === -1 ? "{}" : rest.slice(toolSpace + 1);
    const tool = tools.get(toolName);
    if (!tool) { console.log(`[error] tool "${toolName}" not registered`); return true; }
    let params: any = {};
    try { params = JSON.parse(jsonStr); } catch { console.log(`[error] bad json: ${jsonStr}`); return true; }
    const result = await tool.execute("dummy-call-id", params);
    const text = result?.content?.[0]?.text ?? "(no text)";
    console.log(`[tool] ${toolName}: ${text}`);
    return true;
  }

  // ── wait: sleep ─────────────────────────────────────────────────────
  if (head === "wait") {
    const ms = parseInt(rest, 10) || 1000;
    await new Promise((r) => setTimeout(r, ms));
    return true;
  }

  // ── list: show registered commands/tools (debug) ────────────────────
  if (head === "list") {
    console.log(`[commands] ${[...commands.keys()].join(", ")}`);
    console.log(`[tools] ${[...tools.keys()].join(", ") || "(none — login first)"}`);
    return true;
  }

  // ── exit ────────────────────────────────────────────────────────────
  if (head === "exit") {
    if (shutdownHandler) shutdownHandler();
    return false;
  }

  console.log(`[error] unknown command: ${head}`);
  return true;
}

// ── Read stdin ────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });

(async () => {
  for await (const line of rl) {
    const keepGoing = await handleLine(line);
    if (!keepGoing) break;
  }
  // Graceful shutdown of sync daemon if still running
  if (shutdownHandler) shutdownHandler();
  process.exit(0);
})();
