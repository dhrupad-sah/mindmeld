import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The plugin runs this file directly (no npx download), so it must start on its own.
const bundle = fileURLToPath(new URL("../plugin/server/mindmeld.cjs", import.meta.url));

describe("plugin bundle", () => {
  it("exists and serves the MCP tools over stdio", async () => {
    expect(existsSync(bundle)).toBe(true);
    const child = spawn(process.execPath, [bundle, "mcp"], {
      cwd: "/",
      env: { ...process.env, MINDMELD_HOME: fileURLToPath(new URL("../node_modules/.cache/mindmeld-test", import.meta.url)) },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const started = Date.now();
    while (!out.includes('"id":2') && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 50));
    child.kill();
    const msgs = out.trim().split("\n").map((l) => JSON.parse(l));
    expect(msgs.find((m) => m.id === 1).result.serverInfo.name).toBe("mindmeld");
    const tools = msgs.find((m) => m.id === 2).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["share_session", "stop_sharing", "status", "ask_peer", "invite_peer", "join_peer"]));
    expect(Date.now() - started).toBeLessThan(3000); // starts fast: nothing to download
  });
});
