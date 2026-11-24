import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The plugin runs this file directly (no npx download), so it must start on its own.
export const bundle = fileURLToPath(new URL("../../plugin/server/mindmeld.cjs", import.meta.url));

/** One tool result: its first text block and whether it was an error. */
export interface ToolReply {
  text: string;
  isError: boolean;
}

/**
 * Runs the bundled MCP server like Claude Code does, with its own MINDMELD_HOME (and any extra env).
 * With `elicit`, the client says it supports dialogs and answers every one with that action.
 */
export function startServer(home: string, env: Record<string, string> = {}, opts: { elicit?: "accept" | "decline" | "cancel" } = {}) {
  const child = spawn(process.execPath, [bundle, "mcp"], { cwd: "/", env: { ...process.env, MINDMELD_HOME: home, ...env } });
  let out = "";
  let nextId = 10;
  const dialogs: string[] = [];
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
  let buf = "";
  child.stdout.on("data", (d) => {
    out += d;
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) {
      if (!l.includes('"elicitation/create"')) continue;
      const m = JSON.parse(l);
      dialogs.push(m.params?.message ?? "");
      send({ jsonrpc: "2.0", id: m.id, result: { action: opts.elicit ?? "cancel" } });
    }
  });
  const reply = async (name: string, args: object = {}): Promise<ToolReply> => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const line = out.split("\n").find((l) => l.includes(`"id":${id}`) && !l.includes('"method"'));
      if (line) {
        const r = JSON.parse(line).result;
        return { text: r.content[0].text as string, isError: Boolean(r.isError) };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no reply to ${name}`);
  };
  const call = async (name: string, args: object = {}) => (await reply(name, args)).text;
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: opts.elicit ? { elicitation: {} } : {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  /** Messages of the dialogs the server has shown so far. */
  return { call, reply, dialogs, stop: () => child.kill() };
}
