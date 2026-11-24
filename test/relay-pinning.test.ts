import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { exchange, loadSession } from "../src/auth/session.js";
import { credentialRelayAllowed, HOSTED_RELAY, teamRelay, type Config } from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { getRoster } from "../src/teamapi.js";
import { startServer } from "./helpers/mcpserver.js";
import { startTestRelay, type TestRelay } from "./helpers/worker.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for a hostile relay: records every request it gets and answers 404. */
async function startCapture() {
  const seen: { method: string; url: string; auth?: string; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"nope"}');
    });
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ method: "UPGRADE", url: req.url ?? "", auth: req.headers.authorization, body: "" });
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}`, seen, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("credentials only go to the chosen relay", () => {
  let relay: TestRelay;
  let capture: Awaited<ReturnType<typeof startCapture>>;
  beforeAll(async () => {
    relay = await startTestRelay();
    capture = await startCapture();
  }, 60_000);
  afterAll(async () => {
    await relay?.stop();
    await capture?.stop();
  }, 30_000);
  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const s of stops.splice(0)) s();
    capture.seen.length = 0;
  });

  it("teamRelay ignores MINDMELD_RELAY / CLAUDE_SHARE_RELAY and the legacy relay field", () => {
    const prev = { m: process.env.MINDMELD_RELAY, c: process.env.CLAUDE_SHARE_RELAY };
    process.env.MINDMELD_RELAY = "wss://evil.example";
    process.env.CLAUDE_SHARE_RELAY = "wss://evil2.example";
    try {
      expect(teamRelay(null)).toBe(HOSTED_RELAY);
      expect(teamRelay({ relay: "wss://evil.example", name: "x", secret: "ab".repeat(32) })).toBe(HOSTED_RELAY);
      expect(teamRelay({ relay: "wss://evil.example", name: "x", teamRelay: "wss://mine.example" })).toBe("wss://mine.example");
    } finally {
      if (prev.m === undefined) delete process.env.MINDMELD_RELAY;
      else process.env.MINDMELD_RELAY = prev.m;
      if (prev.c === undefined) delete process.env.CLAUDE_SHARE_RELAY;
      else process.env.CLAUDE_SHARE_RELAY = prev.c;
    }
  });

  it("credentialRelayAllowed: hosted, loopback, or the relay the user wrote into config", () => {
    const none: Config | null = null;
    expect(credentialRelayAllowed(HOSTED_RELAY, none)).toBe(true);
    expect(credentialRelayAllowed(HOSTED_RELAY.replace(/^wss/, "https") + "/", none)).toBe(true);
    for (const r of ["ws://127.0.0.1:8787", "http://localhost:1234", "https://127.0.0.1", "wss://localhost"]) expect(credentialRelayAllowed(r, none), r).toBe(true);
    for (const r of ["wss://evil.example", "http://127.0.0.1.evil.example", "ws://localhost.evil.example:80", "wss://user@evil.example"]) {
      expect(credentialRelayAllowed(r, none), r).toBe(false);
    }
    expect(credentialRelayAllowed("wss://mine.example", { relay: "wss://evil.example", name: "x", teamRelay: "wss://mine.example" })).toBe(true);
    // The legacy relay field can come from MINDMELD_RELAY at pairing time, so it never counts.
    expect(credentialRelayAllowed("wss://evil.example", { relay: "wss://evil.example", name: "x", secret: "ab".repeat(32) })).toBe(false);
  });

  it("MINDMELD_RELAY pointing elsewhere never receives the GitHub token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mindmeld-pin-"));
    // The legacy relay (and the env) name the capture server; the team relay is the one the user wrote.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ secret: "ab".repeat(32), relay: capture.wsUrl, name: "x", teamRelay: relay.url }));
    const gh = relay.github.addUser("pinned1");
    relay.github.setDeviceFlow({ interval: 0, steps: [{ token: gh }] });
    const s = startServer(dir, { MINDMELD_RELAY: capture.wsUrl, CLAUDE_SHARE_RELAY: capture.wsUrl, MINDMELD_GITHUB_BASE: relay.github.url });
    stops.push(s.stop);
    expect(await s.call("login")).toContain("Open https://github.com/login/device");
    const end = Date.now() + 15_000;
    let st = "";
    while (Date.now() < end && !st.includes("Signed in: @pinned1")) {
      st = await s.call("status");
      await sleep(200);
    }
    expect(st).toContain("Signed in: @pinned1");
    const v1 = capture.seen.filter((r) => r.url.startsWith("/v1"));
    expect(v1).toEqual([]);
    expect(capture.seen.some((r) => r.body.includes(gh) || r.auth !== undefined)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);

  it("a session saved for relay A is not used with relay B", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mindmeld-pin-"));
    const prev = process.env.MINDMELD_HOME;
    process.env.MINDMELD_HOME = dir;
    try {
      const session = await exchange(relay.url, relay.github.addUser("pinned2"), loadOrCreateIdentity());
      expect(loadSession(relay.url)?.token).toBe(session.token);
      expect(loadSession(relay.wsUrl + "/")?.token).toBe(session.token); // same relay, other spelling
      expect(loadSession(capture.url)).toBeNull();
      // The API layer refuses too, without sending anything.
      await expect(getRoster(capture.url, session, "0123456789abcdef")).rejects.toThrow(/sign/i);
      expect(capture.seen).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.MINDMELD_HOME;
      else process.env.MINDMELD_HOME = prev;
    }

    // The MCP server, configured for relay B, treats the machine as signed out and sends B nothing.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ relay: capture.wsUrl, name: "x", teamRelay: capture.url, team: { teamId: "0123456789abcdef", name: "core" } }));
    const s = startServer(dir, { MINDMELD_GITHUB_BASE: relay.github.url });
    stops.push(s.stop);
    expect(await s.call("status")).toContain("Not signed in: run /mindmeld:login");
    expect(await s.call("team")).toContain("Not signed in: run /mindmeld:login");
    expect(await s.call("list_peers")).toContain("Not signed in: run /mindmeld:login");
    await sleep(500);
    expect(capture.seen.filter((r) => r.auth !== undefined)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  }, 30_000);
});
