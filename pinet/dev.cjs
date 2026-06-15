#!/usr/bin/env node
/**
 * Dev launcher: autoreloads the relay on any source change.
 *
 *   npm run dev         # node v18+ built-in --watch, zero deps
 *   pnpm dev            # same, once pnpm is installed
 *
 * Env overrides:
 *   PORT=8000 npm run dev
 *   TOKEN=secret npm run dev
 *
 * Ensures a relay-token exists (writes "dev-token" if missing) so first-run
 * just works. Watches relay.js, sync.mjs, and dashboard.html.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const TOKEN_FILE = path.join(ROOT, "relay-token");
const PORT = process.env.PORT || "7654";
const HTTP_PORT = process.env.HTTP_PORT || "8081";

// Ensure a token exists for first-run convenience.
if (process.env.TOKEN) {
  fs.writeFileSync(TOKEN_FILE, process.env.TOKEN);
} else if (!fs.existsSync(TOKEN_FILE)) {
  fs.writeFileSync(TOKEN_FILE, "dev-token");
  console.log(`[dev] wrote relay-token ("dev-token") — dashboard login with: dev-token`);
}

const args = [
  "--watch",
  "--watch-path", ROOT,
  path.join(ROOT, "relay.js"),
  "--port", PORT,
  "--http-port", HTTP_PORT,
  "--token-file", TOKEN_FILE,
];

console.log(`[dev] relay  ws://localhost:${PORT}`);
console.log(`[dev] dash   http://localhost:${HTTP_PORT}  (token: ${fs.readFileSync(TOKEN_FILE, "utf-8").trim()})`);
console.log(`[dev] watching ${ROOT} — edit any file to reload\n`);

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { child.kill(sig); process.exit(0); });
}
