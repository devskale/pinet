#!/usr/bin/env node
/**
 * pinet CLI — Project scaffolding and management.
 *
 * Usage:
 *   pinet init <template> <name>        — create project from template
 *   pinet init --list                  — list available templates
 *   pinet up                            — start all agents for this project
 *   pinet down                          — stop all agents
 *   pinet status                        — show project status
 *   pinet logs <agent>                  — tail agent output
 *   pinet brief [--file <path>]           — send scenario to all agents
 *   pinet restart <agent>              — restart a single agent
 *   pinet deploy --machine <name>       — deploy to remote machine via SSH
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";

const PINET_DIR = path.join(os.homedir(), ".pinet");
const TEMPLATES_DIR = path.join(PINET_DIR, "templates");

// =============================================================================
// Built-in templates
// =============================================================================

const BUILTIN_TEMPLATES = {
  fullstack: {
    name: "fullstack",
    description: "General web app (4 agents)",
    agents: [
      { name: "Master", model: "claude-sonnet-4", role: "coordinator", dir: "master" },
      { name: "FrontendDev", model: "glm-5.1", dir: "frontend" },
      { name: "BackendDev", model: "glm-5.1", dir: "backend" },
      { name: "Tester", model: "glm-4.7", dir: "tester" },
    ],
    teams: ["build"],
  },
  "nextjs-devteam": {
    name: "nextjs-devteam",
    description: "Next.js app with API routes (4 agents)",
    agents: [
      { name: "Architect", model: "claude-sonnet-4", role: "Plan features, decompose tasks", dir: "architect" },
      { name: "UIDev", model: "glm-5.1", dir: "frontend" },
      { name: "APIDev", model: "glm-5.1", dir: "backend" },
      { name: "QA", model: "glm-4.7", role: "Validate endpoints + UI", dir: "qa" },
    ],
    teams: ["build"],
  },
  devops: {
    name: "devops",
    description: "Infra management (3 agents)",
    agents: [
      { name: "SRE", model: "claude-sonnet-4", role: "Plan and coordinate", dir: "sre" },
      { name: "DeployBot", model: "glm-5.1", dir: "deploy" },
      { name: "Monitor", model: "glm-4.7", dir: "monitor" },
    ],
    teams: ["ops"],
  },
  "code-review": {
    name: "code-review",
    description: "PR workflow (3 agents)",
    agents: [
      { name: "Author", model: "glm-5.1", dir: "author" },
      { name: "Reviewer", model: "claude-sonnet-4", role: "Review code quality", dir: "reviewer" },
      { name: "CI", model: "glm-4.7", role: "Run checks", dir: "ci" },
    ],
    teams: ["review"],
  },
  duo: {
    name: "duo",
    description: "Pair programming (2 agents)",
    agents: [
      { name: "Lead", model: "claude-sonnet-4", role: "Direct work", dir: "lead" },
      { name: "Worker", model: "glm-5.1", dir: "worker" },
    ],
    teams: ["pair"],
  },
  research: {
    name: "research",
    description: "Document creation (3 agents)",
    agents: [
      { name: "Researcher", model: "claude-sonnet-4", role: "Find sources and facts", dir: "researcher" },
      { name: "Writer", model: "glm-5.1", dir: "writer" },
      { name: "FactChecker", model: "glm-4.7", role: "Verify claims", dir: "factchecker" },
    ],
    teams: ["editorial"],
  },
};

// =============================================================================
// Helpers
// =============================================================================

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
  console.log(msg);
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// =============================================================================
// Load templates (built-in + custom)
// =============================================================================

function loadTemplates() {
  const templates = { ...BUILTIN_TEMPLATES };

  // Load custom templates from ~/.pinet/templates/
  if (fs.existsSync(TEMPLATES_DIR)) {
    for (const file of fs.readdirSync(TEMPLATES_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const tpl = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf-8"));
        if (tpl.name) templates[tpl.name] = tpl;
      } catch { /* skip malformed */ }
    }
  }

  return templates;
}

// =============================================================================
// pinet init
// =============================================================================

function cmdInit(templateName, projectName, opts = {}) {
  const templates = loadTemplates();

  // --list
  if (templateName === "--list" || templateName === "-l") {
    console.log("Available templates:\n");
    for (const [key, tpl] of Object.entries(templates)) {
      console.log(`  ${key.padEnd(20)} ${tpl.description}`);
    }
    return;
  }

  if (!templateName || !projectName) {
    die("Usage: pinet init <template> <project-name>\n       pinet init --list");
  }

  const template = templates[templateName];
  if (!template) {
    die(`Unknown template "${templateName}". Run: pinet init --list`);
  }

  const projectDir = path.resolve(projectName);

  if (fs.existsSync(projectDir)) {
    die(`Directory "${projectName}" already exists.`);
  }

  // Create project structure
  ensureDir(projectDir);

  // Build project.json
  const project = {
    name: path.basename(projectDir),
    template: templateName,
    created: new Date().toISOString(),
    machines: {},
    teams: {},
    agents: {},
  };

  // Default machine assignment — all agents on current machine
  const hostname = os.hostname().split(".")[0] || "local";
  const agentNames = [];

  for (const agent of template.agents) {
    const agentDir = path.join(projectDir, agent.dir || agent.name.toLowerCase());
    const relAgentDir = path.relative(projectDir, agentDir);

    // Create workspace dir with .pi/settings.json and extension symlink
    ensureDir(agentDir);
    const piDir = path.join(agentDir, ".pi");
    ensureDir(piDir);
    ensureDir(path.join(piDir, "extensions"));

    // Write settings.json
    fs.writeFileSync(
      path.join(piDir, "settings.json"),
      JSON.stringify({ defaultModel: agent.model }, null, 2) + "\n"
    );

    // Symlink extension
    const extLink = path.join(piDir, "extensions", "pinet");
    // Resolve relative to the pinet package (this file's parent dir)
    const pinetPkg = path.resolve(path.dirname(new URL(import.meta.url).pathname));
    const relPath = path.relative(path.dirname(extLink), pinetPkg);
    try {
      fs.symlinkSync(relPath, extLink);
    } catch {
      // Symlink might fail on some systems — try absolute path
      try { fs.symlinkSync(pinetPkg, extLink); } catch { /* skip */ }
    }

    // Add to project
    project.agents[agent.name] = {
      model: agent.model,
      machine: hostname,
      dir: relAgentDir,
    };
    if (agent.role) project.agents[agent.name].role = agent.role;
    agentNames.push(agent.name);
  }

  // All agents on this machine by default
  project.machines[hostname] = agentNames;

  // Teams (empty tokens — user runs wizard to fill in)
  for (const team of template.teams || []) {
    project.teams[team] = { token: "" };
  }

  // Brief from template
  if (template.brief) {
    project.brief = template.brief;
  }

  // Write project.json
  ensureDir(path.join(projectDir, ".pinet"));
  fs.writeFileSync(
    path.join(projectDir, ".pinet", "project.json"),
    JSON.stringify(project, null, 2) + "\n"
  );

  // Summary
  log(`\nProject "${path.basename(projectDir)}" created from template "${templateName}"`);
  log(`  Agents: ${agentNames.join(", ")}`);
  log(`  Teams: ${(template.teams || []).map(t => `#${t}`).join(", ") || "none"}`);
  log(`  Machine: ${hostname} (all agents)`);
  log(``);
  log(`Next steps:`);
  log(`  cd ${projectName}`);
  log(`  pinet wizard <url> <token> ${hostname} ${(template.teams || [])[0] || ""}`);
  log(`  pinet up`);
}

// =============================================================================
// pinet up
// =============================================================================

function cmdUp(opts = {}) {
  const projectDir = path.resolve(".");
  const projectFile = path.join(projectDir, ".pinet", "project.json");

  if (!fs.existsSync(projectFile)) {
    die("No .pinet/project.json found. Run: pinet init <template> <name>");
  }

  const project = JSON.parse(fs.readFileSync(projectFile, "utf-8"));
  const hostname = os.hostname().split(".")[0] || "local";
  const agentsForMachine = project.machines[hostname] || Object.keys(project.agents);

  log(`Starting ${agentsForMachine.length} agents on ${hostname}...`);

  const logsDir = path.join(PINET_DIR, "projects", project.name, "logs");
  ensureDir(logsDir);

  // Check relay.json
  const relayFile = path.join(PINET_DIR, "relay.json");
  if (!fs.existsSync(relayFile)) {
    log("Warning: No relay.json found. Agents will run in local-only mode.");
    log("Run: pinet wizard <url> <token> <machine> <team>");
  }

  // Start each agent
  for (const agentName of agentsForMachine) {
    const agentConfig = project.agents[agentName];
    if (!agentConfig) {
      log(`  Skipping ${agentName} — not in project.json`);
      continue;
    }

    const agentDir = path.resolve(projectDir, agentConfig.dir);
    const logFile = path.join(logsDir, `${agentName}.log`);

    if (!fs.existsSync(agentDir)) {
      log(`  Skipping ${agentName} — directory not found: ${agentConfig.dir}`);
      continue;
    }

    // Build teams string
    const teams = Object.keys(project.teams).filter(t => project.teams[t].token);
    const loginArg = teams.length > 0 ? `${agentName}@${teams.join(",")}` : agentName;

    // Spawn pi in the agent's directory
    log(`  Starting ${agentName} in ${agentConfig.dir}/ ...`);

    const logStream = fs.openSync(logFile, "a");
    const proc = spawn("pi", [], {
      cwd: agentDir,
      stdio: ["pipe", logStream, logStream],
      detached: false,
      env: { ...process.env },
    });

    // Write PID file
    const pidFile = path.join(logsDir, `${agentName}.pid`);
    fs.writeFileSync(pidFile, String(proc.pid));

    // Wait a moment then send login command
    const loginDelay = setTimeout(() => {
      try {
        proc.stdin.write(`/pinet ${loginArg}\n`);
      } catch { /* process may have exited */ }
    }, 2000);

    log(`    PID ${proc.pid} — /pinet ${loginArg}`);
  }

  log(`\nAll agents started. Logs: ${logsDir}`);
  log("Use: pinet status  — check agent status");
  log("     pinet logs <agent>  — tail output");
}

// =============================================================================
// pinet down
// =============================================================================

function cmdDown() {
  const projectDir = path.resolve(".");
  const projectFile = path.join(projectDir, ".pinet", "project.json");

  if (!fs.existsSync(projectFile)) {
    die("No .pinet/project.json found.");
  }

  const project = JSON.parse(fs.readFileSync(projectFile, "utf-8"));
  const logsDir = path.join(PINET_DIR, "projects", project.name, "logs");

  if (!fs.existsSync(logsDir)) {
    log("No running agents found.");
    return;
  }

  // Read PIDs and kill processes
  let killed = 0;
  for (const file of fs.readdirSync(logsDir)) {
    if (!file.endsWith(".pid")) continue;
    const agentName = file.replace(".pid", "");
    const pidFile = path.join(logsDir, file);
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);

    try {
      process.kill(pid, "SIGTERM");
      log(`  Stopped ${agentName} (PID ${pid})`);
      killed++;
    } catch {
      log(`  ${agentName} (PID ${pid}) already stopped`);
    }

    fs.unlinkSync(pidFile);
  }

  log(`${killed} agent${killed !== 1 ? "s" : ""} stopped.`);
}

// =============================================================================
// pinet status
// =============================================================================

function cmdStatus() {
  const projectDir = path.resolve(".");
  const projectFile = path.join(projectDir, ".pinet", "project.json");

  if (!fs.existsSync(projectFile)) {
    die("No .pinet/project.json found.");
  }

  const project = JSON.parse(fs.readFileSync(projectFile, "utf-8"));
  const logsDir = path.join(PINET_DIR, "projects", project.name, "logs");

  log(`Project: ${project.name} (template: ${project.template})`);

  for (const [name, config] of Object.entries(project.agents)) {
    const pidFile = path.join(logsDir, `${name}.pid`);
    let status = "offline";

    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      try {
        process.kill(pid, 0);
        status = `online (PID ${pid})`;
      } catch {
        status = "dead (stale PID)";
      }
    }

    const marker = status.startsWith("online") ? "●" : "○";
    log(`  ${marker} ${name.padEnd(15)} ${config.model.padEnd(20)} ${config.machine}  ${status}`);
  }

  const teams = Object.entries(project.teams);
  if (teams.length > 0) {
    log(`\nTeams:`);
    for (const [name, data] of teams) {
      log(`  #${name}  token: ${data.token ? data.token.slice(0, 8) + "..." : "not set"}`);
    }
  }
}

// =============================================================================
// pinet logs
// =============================================================================

function cmdLogs(agentName) {
  if (!agentName) die("Usage: pinet logs <agent-name>");

  const projectDir = path.resolve(".");
  const projectFile = path.join(projectDir, ".pinet", "project.json");
  if (!fs.existsSync(projectFile)) die("No .pinet/project.json found.");

  const project = JSON.parse(fs.readFileSync(projectFile, "utf-8"));
  const logFile = path.join(PINET_DIR, "projects", project.name, "logs", `${agentName}.log`);

  if (!fs.existsSync(logFile)) {
    die(`No logs for ${agentName}. Is the agent running?`);
  }

  // Tail the log file
  try {
    execSync(`tail -f ${logFile}`, { stdio: "inherit" });
  } catch {
    // tail was interrupted
  }
}

// =============================================================================
// pinet brief
// =============================================================================

function cmdBrief(filePath) {
  const projectDir = path.resolve(".");
  const projectFile = path.join(projectDir, ".pinet", "project.json");
  if (!fs.existsSync(projectFile)) die("No .pinet/project.json found.");

  const project = JSON.parse(fs.readFileSync(projectFile, "utf-8"));

  // Read brief from project.json or from --file argument
  let briefPath;
  if (filePath) {
    briefPath = path.resolve(filePath);
  } else if (project.brief) {
    briefPath = path.resolve(projectDir, project.brief);
  } else {
    die("No brief configured. Add 'brief' to project.json or use: pinet brief --file <path>");
  }

  if (!fs.existsSync(briefPath)) {
    die(`Brief file not found: ${briefPath}`);
  }

  const content = fs.readFileSync(briefPath, "utf-8");

  // Send brief to all agents with active PIDs
  const logsDir = path.join(PINET_DIR, "projects", project.name, "logs");
  let sent = 0;

  for (const [name, config] of Object.entries(project.agents)) {
    const pidFile = path.join(logsDir, `${name}.pid`);
    if (!fs.existsSync(pidFile)) continue;

    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }

    // Write brief to agent's stdin
    // Note: this is a best-effort approach — the brief appears as user input in pi
    const agentDir = path.resolve(projectDir, config.dir);
    const mailboxPath = path.join(PINET_DIR, "mailboxes", `${name}.mailbox.jsonl`);

    // Append brief as a system message to each team the agent is in
    for (const teamName of Object.keys(project.teams)) {
      const teamPath = path.join(PINET_DIR, "teams", teamName, "messages.jsonl");
      ensureDir(path.dirname(teamPath));
      const msg = {
        id: crypto.randomUUID(),
        from: "SYSTEM",
        team: teamName,
        body: `[BRIEF for ${name}]\n${content}`,
        timestamp: new Date().toISOString(),
      };
      fs.appendFileSync(teamPath, JSON.stringify(msg) + "\n");
      sent++;
    }
  }

  log(`Brief sent to ${sent} team channel(s).`);
}

// =============================================================================
// pinet restart
// =============================================================================

function cmdRestart(agentName) {
  if (!agentName) die("Usage: pinet restart <agent-name>");

  log(`Restarting ${agentName}...`);

  // Stop the agent
  const projectDir = path.resolve(".");
  const projectFile = path.join(projectDir, ".pinet", "project.json");
  if (!fs.existsSync(projectFile)) die("No .pinet/project.json found.");

  const project = JSON.parse(fs.readFileSync(projectFile, "utf-8"));
  const agentConfig = project.agents[agentName];
  if (!agentConfig) die(`Agent "${agentName}" not found in project.`);

  const logsDir = path.join(PINET_DIR, "projects", project.name, "logs");
  const pidFile = path.join(logsDir, `${agentName}.pid`);

  if (fs.existsSync(pidFile)) {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
    fs.unlinkSync(pidFile);
  }

  // Start it again
  const agentDir = path.resolve(projectDir, agentConfig.dir);
  const logFile = path.join(logsDir, `${agentName}.log`);
  const teams = Object.keys(project.teams).filter(t => project.teams[t].token);
  const loginArg = teams.length > 0 ? `${agentName}@${teams.join(",")}` : agentName;

  const logStream = fs.openSync(logFile, "a");
  const proc = spawn("pi", [], {
    cwd: agentDir,
    stdio: ["pipe", logStream, logStream],
    detached: false,
    env: { ...process.env },
  });

  fs.writeFileSync(pidFile, String(proc.pid));

  const loginDelay = setTimeout(() => {
    try { proc.stdin.write(`/pinet ${loginArg}\n`); } catch { /* */ }
  }, 2000);

  log(`${agentName} restarted (PID ${proc.pid})`);
}

// =============================================================================
// Main
// =============================================================================

import { randomUUID } from "node:crypto";

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "init":
    cmdInit(rest[0], rest[1]);
    break;
  case "up":
    cmdUp();
    break;
  case "down":
    cmdDown();
    break;
  case "status":
    cmdStatus();
    break;
  case "logs":
    cmdLogs(rest[0]);
    break;
  case "brief":
    cmdBrief(rest.includes("--file") ? rest[rest.indexOf("--file") + 1] : null);
    break;
  case "restart":
    cmdRestart(rest[0]);
    break;
  default:
    console.log(`PiNet CLI v0.1.2

Usage:
  pinet init <template> <name>    Create project from template
  pinet init --list               List available templates
  pinet up                         Start all agents for this project
  pinet down                       Stop all agents
  pinet status                     Show project status
  pinet logs <agent>               Tail agent output
  pinet brief [--file <path>]      Send scenario to all agents
  pinet restart <agent>            Restart a single agent
  pinet deploy --machine <name>    Deploy to remote machine (Phase 3)

Templates: fullstack, nextjs-devteam, devops, code-review, duo, research
`);
}
