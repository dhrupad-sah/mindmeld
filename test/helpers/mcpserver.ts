import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The plugin runs this file directly (no npx download), so it must start on its own.
export const bundle = fileURLToPath(new URL("../../plugin/server/mindmeld.cjs", import.meta.url));

/** One tool result: its first text block and whether it was an error. */
export interface ToolReply {
  text: string;
  isError: boolean;
}

/** Runs the bundled MCP server like Claude Code does, with its own MINDMELD_HOME (and any extra env). */
export function startServer(home: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [bundle, "mcp"], { cwd: "/", env: { ...process.env, MINDMELD_HOME: home, ...env } });
  let out = "";
  let nextId = 10;
  child.stdout.on("data", (d) => (out += d));
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
  const reply = async (name: string, args: object = {}): Promise<ToolReply> => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const line = out.split("\n").find((l) => l.includes(`"id":${id}`));
      if (line) {
        const r = JSON.parse(line).result;
        return { text: r.content[0].text as string, isError: Boolean(r.isError) };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no reply to ${name}`);
  };
  const call = async (name: string, args: object = {}) => (await reply(name, args)).text;
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { call, reply, stop: () => child.kill() };
}
