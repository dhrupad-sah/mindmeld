import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** Runs the bundled MCP server like Claude Code does, with its own MINDMELD_HOME. */
function startServer(home: string) {
  const child = spawn(process.execPath, [bundle, "mcp"], { cwd: "/", env: { ...process.env, MINDMELD_HOME: home } });
  let out = "";
  let nextId = 10;
  child.stdout.on("data", (d) => (out += d));
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
  const call = async (name: string, args: object = {}) => {
    const id = nextId++;
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const started = Date.now();
    while (Date.now() - started < 8000) {
      const line = out.split("\n").find((l) => l.includes(`"id":${id}`));
      if (line) return JSON.parse(line).result.content[0].text as string;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no reply to ${name}`);
  };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { call, stop: () => child.kill() };
}

function pairedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "mindmeld-home-"));
  // A relay that refuses connections: these tests are about local state only.
  writeFileSync(join(home, "config.json"), JSON.stringify({ secret: "ab".repeat(32), relay: "ws://127.0.0.1:9", name: "Tester" }));
  return home;
}

describe("leaving a group", () => {
  it("leave_group disconnects and deletes the pairing", async () => {
    const home = pairedHome();
    const s = startServer(home);
    try {
      expect(await s.call("status")).toContain("You appear as: Tester");
      expect(await s.call("leave_group", { confirmed: true })).toContain("Left the group");
      expect(existsSync(join(home, "config.json"))).toBe(false);
      expect(await s.call("status")).toContain("Not connected to anyone yet");
      expect(await s.call("leave_group", { confirmed: true })).toContain("not in a mindmeld group");
    } finally {
      s.stop();
    }
  });

  it("without confirmation and no dialog support, it refuses instead of leaving", async () => {
    const home = pairedHome();
    const s = startServer(home);
    try {
      expect(await s.call("leave_group")).toContain("confirm");
      expect(existsSync(join(home, "config.json"))).toBe(true);
    } finally {
      s.stop();
    }
  });

  it("an already-open session notices when the group was left elsewhere", async () => {
    const home = pairedHome();
    const s = startServer(home);
    try {
      expect(await s.call("status")).toContain("You appear as: Tester");
      rmSync(join(home, "config.json")); // e.g. `mindmeld leave` or another session
      await new Promise((r) => setTimeout(r, 4000));
      expect(await s.call("status")).toContain("Not connected to anyone yet");
    } finally {
      s.stop();
    }
  }, 15000);
});
