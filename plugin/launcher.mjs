#!/usr/bin/env node
// Starts the mindmeld MCP server from the home directory. Run from a project folder, npx would
// prefer a local package of the same name (e.g. inside the mindmeld repo itself) and fail.
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const child = spawn("npx", ["-y", "mindmeld-mcp@^0.4.0", "mcp"], {
  cwd: homedir(),
  stdio: "inherit",
  shell: process.platform === "win32",
  // CLAUDE_PROJECT_DIR (set by Claude Code) still tells the server which project it serves.
  env: { ...process.env, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? process.cwd() },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
