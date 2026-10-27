import type { Server } from "node:http";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerWithFork } from "../src/answerer.js";
import { Daemon, type Decide } from "../src/daemon.js";
import { startRelay } from "../src/relay.js";

const CODE = "abcd-efgh-2345";
let relay: Server;
let relayUrl: string;
const daemons: Daemon[] = [];

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function makeDaemon(name: string, decide: Decide, code = CODE, rateLimit?: { max: number; windowMs: number }) {
  const d = new Daemon({ code, relay: relayUrl, name, project: `${name}-proj`, decide, rateLimit });
  daemons.push(d);
  const port = await d.start();
  return { d, port };
}

function http(port: number, token: string, method: string, path: string, body?: unknown): Promise<any> {
  const payload = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { authorization: `Bearer ${token}` } }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeEach(async () => {
  relay = await startRelay(0, "127.0.0.1");
  const addr = relay.address() as { port: number };
  relayUrl = `ws://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  await new Promise((r) => relay.close(r));
});

describe("end to end", () => {
  it("discovers peers and answers a question through the local API", async () => {
    const { d: alice, port } = await makeDaemon("alice", async () => ({ action: "send", text: "unused" }));
    const { d: bob } = await makeDaemon("bob", async (ask) => ({ action: "send", text: `bob says: ${ask.question} (from ${ask.from})` }));
    await waitFor(() => alice.onlinePeers().length === 1 && bob.onlinePeers().length === 1);

    const peers = await http(port, alice.token, "GET", "/peers");
    expect(peers.body).toEqual([expect.objectContaining({ name: "bob", project: "bob-proj" })]);

    const r = await http(port, alice.token, "POST", "/ask", { question: "how did you fix auth?", peer: "bob" });
    expect(r.body).toEqual({ from: "bob", text: "bob says: how did you fix auth? (from alice)" });
  });

  it("rejects requests without the token", async () => {
    const { port } = await makeDaemon("alice", async () => ({ action: "decline", reason: "x" }));
    const r = await http(port, "wrong", "GET", "/peers");
    expect(r.status).toBe(401);
  });

  it("reports declines and unknown peers", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }));
    await makeDaemon("bob", async () => ({ action: "decline", reason: "busy" }));
    await waitFor(() => alice.onlinePeers().length === 1);
    expect(await alice.ask("q")).toEqual({ error: "declined — bob: busy" });
    expect(await alice.ask("q", { peer: "carol" })).toEqual({ error: 'peer "carol" is not online' });
  });

  it("isolates rooms with different codes", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }));
    await makeDaemon("eve", async () => ({ action: "send", text: "" }), "zzzz-zzzz-zzzz");
    await new Promise((r) => setTimeout(r, 200));
    expect(alice.onlinePeers()).toEqual([]);
  });

  it("only the addressed peer answers", async () => {
    const asked: string[] = [];
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }));
    await makeDaemon("bob", async () => (asked.push("bob"), { action: "send", text: "bob" }));
    await makeDaemon("carol", async () => (asked.push("carol"), { action: "send", text: "carol" }));
    await waitFor(() => alice.onlinePeers().length === 2);
    expect(await alice.ask("q", { peer: "carol" })).toEqual({ from: "carol", text: "carol" });
    await new Promise((r) => setTimeout(r, 100));
    expect(asked).toEqual(["carol"]);
  });

  it("rate limits a chatty peer", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }));
    await makeDaemon("bob", async () => ({ action: "send", text: "ok" }), CODE, { max: 2, windowMs: 60_000 });
    await waitFor(() => alice.onlinePeers().length === 1);
    expect(await alice.ask("1")).toEqual({ from: "bob", text: "ok" });
    expect(await alice.ask("2")).toEqual({ from: "bob", text: "ok" });
    expect(await alice.ask("3")).toEqual({ error: expect.stringContaining("rate limited") });
  });

  it("delivers snippets to the inbox", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }));
    const { d: bob } = await makeDaemon("bob", async () => ({ action: "send", text: "" }));
    await waitFor(() => alice.onlinePeers().length === 1);
    expect(alice.snippet("notes", "use a retry queue", "bob")).toEqual({ ok: true });
    const received = new Promise((r) => bob.once("snippet", r));
    await received;
    expect(bob.drainInbox()).toEqual([expect.objectContaining({ from: "alice", title: "notes", text: "use a retry queue" })]);
    expect(bob.drainInbox()).toEqual([]);
  });
});

describe("answerWithFork", () => {
  const stub = fileURLToPath(new URL("./stub-claude.mjs", import.meta.url));

  it("runs a read-only forked continue with the question on stdin", async () => {
    process.env.CLAUDE_SHARE_CLAUDE_BIN = stub;
    const out = JSON.parse(await answerWithFork({ cwd: "/tmp", from: "alice", question: "how?", context: "ctx" }));
    expect(out.args.slice(0, 3)).toEqual(["-p", "--continue", "--fork-session"]);
    expect(out.args).toEqual(expect.arrayContaining(["--allowedTools", "Read", "Grep", "Glob", "--disallowedTools", "Bash", "Edit", "Write"]));
    expect(out.args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']));
    expect(out.input).toContain('Question from teammate "alice":\nhow?');
    expect(out.input).toContain("ctx");
    expect(out.cwd).toMatch(/tmp$/);
  });

  it("rejects when claude fails", async () => {
    process.env.CLAUDE_SHARE_CLAUDE_BIN = stub;
    await expect(answerWithFork({ cwd: "/tmp", from: "a", question: "FAIL" })).rejects.toThrow(/exited with 2: boom/);
  });
});
