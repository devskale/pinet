#!/usr/bin/env node
// pinet — agent CLI for the PiNet board (the workhorse surface).
// Talks to the PiNet webapp API. Identity + token live in ./.pinet/config.json (per-cwd).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SERVER = process.env.PINET_URL || "http://localhost:3000";
const CFG_DIR = path.join(process.cwd(), ".pinet");
const CFG_FILE = path.join(CFG_DIR, "config.json");

const loadCfg = () => {
  try {
    return JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveCfg = (c) => {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(c, null, 2));
};

async function api(method, p, body) {
  const { token } = loadCfg();
  const res = await fetch(SERVER + p, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✗ ${res.status} ${j.error || res.statusText}`);
    process.exit(1);
  }
  return j;
}

const WRAP = { start: "WIP", review: "FOR_REVIEW", done: "DONE", cancel: "CANCELLED", approve: "DONE" };
const HELP = `pinet — agent board CLI
  pinet login [--machine M] [--path P]   log in as the agent for this repo (default: machine=hostname, path=cwd)
  pinet dev-login <persona>              dev only: become admin|orchestrator|frontend|backend (needs the project seeded)
  pinet whoami                           who am I
  pinet board [--subproject X]           show the board
  pinet todo                             issues addressed to me, live columns
  pinet new <slug> <to> "<task>" [--module X]   create an issue in backlog (from = me)
  pinet show <slug>                      print one issue
  pinet move <slug> <STATE>              OPEN|WIP|FOR_REVIEW|DONE|CANCELLED
  pinet comment <slug> "<text>"          add a comment
  pinet approve <slug>                   accept a reviewed issue (issuer) → DONE
  pinet overview                         board rollup: counts, per-actor load, stale WIP
  pinet start|review|done|cancel <slug>  move (wrappers)`;

// split positional args from --flag value pairs
function parse(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) flags[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  return { flags, pos };
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "login": {
    const { flags, pos } = parse(rest);
    const machine = flags.machine || os.hostname().split(".")[0];
    const p = flags.path || pos[0] || process.cwd();
    const j = await api("POST", "/api/login/agent", { machine, path: p });
    saveCfg({ token: j.token, handle: j.user.handle, server: SERVER });
    console.log(`✓ ${j.user.handle} (${j.role}) · ${j.assignment}`);
    break;
  }
  case "dev-login": {
    const j = await api("POST", "/api/login/dev", { persona: rest[0] });
    saveCfg({ token: j.token, handle: j.user.handle, server: SERVER });
    console.log(`✓ ${j.user.handle} (${j.user.role}) [dev]`);
    break;
  }
  case "whoami": {
    const j = await api("GET", "/api/me");
    console.log(`${j.user.handle} (${j.user.role})${j.user.display_name ? ` · ${j.user.display_name}` : ""}`);
    break;
  }
  case "board": {
    const { flags } = parse(rest);
    const j = await api("GET", "/api/board" + (flags.subproject ? `?subproject=${encodeURIComponent(flags.subproject)}` : ""));
    const byCol = {};
    for (const i of j.issues) (byCol[i.column] ||= []).push(i);
    console.log(`project: ${j.project} · you: ${j.user}`);
    for (const col of ["backlog", "active", "review", "archive", "cancelled"]) {
      const items = byCol[col] || [];
      console.log(`\n${col} (${items.length})`);
      for (const i of items) console.log(`  ${i.slug}  [${i.state}]  ${i.from} → ${i.to || "–"}${i.module ? ` · ${i.module}` : ""}`);
      if (!items.length) console.log("  —");
    }
    break;
  }
  case "todo": {
    const j = await api("GET", "/api/todo");
    console.log(`todo for ${j.me} (${j.issues.length})`);
    for (const i of j.issues) console.log(`  [${i.column}] ${i.slug} — ${i.task}${i.module ? ` (${i.module})` : ""}`);
    if (!j.issues.length) console.log("  — nothing addressed to you —");
    break;
  }
  case "new": {
    const { flags, pos } = parse(rest);
    const [slug, to, ...taskParts] = pos;
    const task = taskParts.join(" ").trim();
    if (!slug || !to || !task) {
      console.error("usage: pinet new <slug> <to> \"<task>\" [--module X]");
      process.exit(1);
    }
    const j = await api("POST", "/api/issues", { slug, to, task, module: flags.module || undefined });
    console.log(`✓ created ${j.issue.slug} → ${j.issue.to} (${j.issue.column})`);
    break;
  }
  case "show": {
    const j = await api("GET", `/api/issues/${encodeURIComponent(rest[0])}`);
    const i = j.issue;
    console.log(`${i.slug} [${i.state}] · ${i.column}\nfrom ${i.from} → to ${i.to || "–"}${i.module ? ` · ${i.module}` : ""} · ${i.date}\n\n## Task\n${i.task}${i.context ? `\n\n## Context\n${i.context}` : ""}${i.comments?.length ? `\n\n## Comments\n` + i.comments.map((c) => `  ${c.author} · ${c.date}: ${c.text}`).join("\n") : ""}`);
    break;
  }
  case "move": {
    const j = await api("POST", `/api/issues/${encodeURIComponent(rest[0])}/move`, { state: rest[1] });
    console.log(`✓ ${j.issue.slug} → ${j.issue.state} (${j.issue.column})`);
    break;
  }
  case "start":
  case "review":
  case "done":
  case "cancel":
  case "approve": {
    const j = await api("POST", `/api/issues/${encodeURIComponent(rest[0])}/move`, { state: WRAP[cmd] });
    console.log(`✓ ${j.issue.slug} → ${j.issue.state} (${j.issue.column})`);
    break;
  }
  case "comment": {
    const { pos } = parse(rest);
    const [slug, ...textParts] = pos;
    const text = textParts.join(" ").trim();
    if (!slug || !text) {
      console.error('usage: pinet comment <slug> "<text>"');
      process.exit(1);
    }
    const j = await api("POST", `/api/issues/${encodeURIComponent(slug)}/comment`, { text });
    console.log(`✓ commented on ${j.issue.slug} (${j.issue.comments.length})`);
    break;
  }
  case "overview": {
    const j = await api("GET", "/api/overview");
    console.log(`project: ${j.project} · ${j.total} issues`);
    console.log("by column: " + Object.entries(j.byCol).map(([k, v]) => `${k}=${v}`).join("  "));
    console.log("load: " + (Object.entries(j.load).map(([k, v]) => `${k}=${v}`).join("  ") || "—"));
    console.log("stale WIP: " + (j.stale.length ? j.stale.map((s) => `${s.slug}(${s.ageDays}d)`).join(", ") : "none"));
    break;
  }
  default:
    console.log(HELP);
}
