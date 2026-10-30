import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerWithFork } from "../src/answerer.js";
import { Daemon, type Decide } from "../src/daemon.js";
import { startRelay } from "../src/relay.js";

import { generateGroupSecret } from "../src/crypto.js";

const CODE = generateGroupSecret();
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

async function makeDaemon(
  name: string,
  decide: Decide,
  code = CODE,
  rateLimit?: { max: number; windowMs: number },
  sessionInfo?: () => { activeAt?: number },
  share?: { label: string } | null,
) {
  const d = new Daemon({ secret: code, relay: relayUrl, name, project: `${name}-proj`, decide, rateLimit, sessionInfo, share });
  daemons.push(d);
  d.start();
  return { d };
}

beforeEach(async () => {
  if (process.env.RELAY_URL) {
    relayUrl = process.env.RELAY_URL;
    return;
  }
  relay = await startRelay(0, "127.0.0.1");
  const addr = relay.address() as { port: number };
  relayUrl = `ws://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.stop()));
  if (!process.env.RELAY_URL) await new Promise((r) => relay.close(r));
});

describe("end to end", () => {
  it("discovers peers and answers a question", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "unused" }));
    const { d: bob } = await makeDaemon("bob", async (ask) => ({ action: "send", text: `bob says: ${ask.question} (from ${ask.from})` }));
    await waitFor(() => alice.onlinePeers().length === 1 && bob.onlinePeers().length === 1);

    expect(alice.onlinePeers()).toEqual([expect.objectContaining({ name: "bob", project: "bob-proj" })]);
    expect(await alice.ask("how did you fix auth?", { peer: "bob" })).toEqual({
      from: "bob",
      text: "bob says: how did you fix auth? (from alice)",
    });
  });

  it("reports declines and unknown peers", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }));
    await makeDaemon("bob", async () => ({ action: "decline", reason: "busy" }));
    await waitFor(() => alice.onlinePeers().length === 1);
    expect(await alice.ask("q")).toEqual({ error: "declined — bob: busy" });
    expect(await alice.ask("q", { peer: "carol" })).toEqual({ error: '"carol" is not online (online: bob)' });
  });

  it("isolates rooms with different codes", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }));
    await makeDaemon("eve", async () => ({ action: "send", text: "" }), generateGroupSecret());
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

  it("routes to the person's most recently active session", async () => {
    const asked: string[] = [];
    const { d: alice } = await makeDaemon("Alice", async () => ({ action: "send", text: "" }));
    await makeDaemon("Sarim Khan", async () => (asked.push("old"), { action: "send", text: "old" }), CODE, undefined, () => ({ activeAt: 1000 }), { label: "auth work" });
    await makeDaemon("Sarim Khan", async () => (asked.push("new"), { action: "send", text: "new" }), CODE, undefined, () => ({ activeAt: 2000 }), { label: "scraper" });
    await waitFor(() => alice.onlinePeers().length === 2);
    expect(alice.onlinePeers().map((p) => p.project).sort()).toEqual(["auth work", "scraper"]);
    expect(await alice.ask("q", { peer: "sarim" })).toEqual({ from: "Sarim Khan", text: "new" });
    expect(await alice.ask("q")).toEqual({ from: "Sarim Khan", text: "new" }); // one person online: no name needed
    await new Promise((r) => setTimeout(r, 100));
    expect(asked).toEqual(["new", "new"]);
  });

  it("asks you to name someone when several people are online", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }));
    await makeDaemon("bob", async () => ({ action: "send", text: "" }));
    await makeDaemon("carol", async () => ({ action: "send", text: "" }));
    await waitFor(() => alice.onlinePeers().length === 2);
    expect(await alice.ask("q")).toEqual({ error: expect.stringMatching(/several people are online \((bob, carol|carol, bob)\)/) });
  });

  it("keeps unshared sessions invisible and unanswerable, and lets them ask silently", async () => {
    const asked: string[] = [];
    // alice never shares; bob shares one session and keeps another private
    const { d: alice } = await makeDaemon("alice", async () => (asked.push("alice"), { action: "send", text: "x" }), CODE, undefined, undefined, null);
    const { d: bobPrivate } = await makeDaemon("bob", async () => (asked.push("bob-private"), { action: "send", text: "private!" }), CODE, undefined, () => ({ activeAt: 9999 }), null);
    await makeDaemon("bob", async (ask) => (asked.push(`bob-shared<-${ask.from}`), { action: "send", text: "shared" }), CODE, undefined, () => ({ activeAt: 1 }), { label: "scraper" });
    await waitFor(() => alice.onlinePeers().length === 1);
    await new Promise((r) => setTimeout(r, 150));
    // Only bob's shared session is listed, and only with its chosen label; nobody sees alice.
    expect(alice.onlinePeers()).toEqual([expect.objectContaining({ name: "bob", project: "scraper" })]);
    expect(bobPrivate.onlinePeers().map((p) => p.project)).toEqual(["scraper"]);
    // The question reaches the shared session even though the private one is "more recent".
    expect(await alice.ask("q", { peer: "bob" })).toEqual({ from: "bob", text: "shared" });
    expect(asked).toEqual(["bob-shared<-alice"]); // asker's name travels with the question
  });

  it("stops being visible or answerable after sharing stops", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }), CODE, undefined, undefined, null);
    const { d: bob } = await makeDaemon("bob", async () => ({ action: "send", text: "hi" }), CODE, undefined, undefined, { label: "work" });
    await waitFor(() => alice.onlinePeers().length === 1);
    bob.setShare(null);
    await waitFor(() => alice.onlinePeers().length === 0);
    expect(await alice.ask("q", { peer: "bob" })).toEqual({ error: "no peers online" });
  });

  it("reports progress while the answer is being prepared", async () => {
    const { d: alice } = await makeDaemon("alice", async () => ({ action: "send", text: "" }), CODE, undefined, undefined, null);
    await makeDaemon("bob", async (_ask, report) => {
      report("approved");
      await new Promise((r) => setTimeout(r, 30));
      report("drafting");
      return { action: "send", text: "done" };
    });
    await waitFor(() => alice.onlinePeers().length === 1);
    const states: string[] = [];
    expect(await alice.ask("q", { onStatus: (s) => states.push(s) })).toEqual({ from: "bob", text: "done" });
    expect(states).toEqual(["received", "approved", "drafting"]);
  });

  it("fails fast when the target session never acknowledges", async () => {
    const d = new Daemon({ secret: CODE, relay: relayUrl, name: "alice", project: "p", decide: async () => ({ action: "send", text: "" }), share: null, ackTimeoutMs: 300 });
    daemons.push(d);
    d.start();
    const { d: bob } = await makeDaemon("bob", async () => ({ action: "send", text: "" }));
    await waitFor(() => d.onlinePeers().length === 1);
    (bob as any).share = null; // vanished without saying bye (e.g. crashed)
    const started = Date.now();
    expect(await d.ask("q")).toEqual({ error: expect.stringContaining("didn't acknowledge") });
    expect(Date.now() - started).toBeLessThan(2000);
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
    expect(alice.snippet("notes", "use a retry queue", "bob")).toEqual({ ok: true, to: "bob" });
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
    expect(out.args).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk", "--setting-sources", "", "--allowedTools", "Read(./**)", "Glob(./**)"]));
    expect(out.args).toEqual(expect.arrayContaining(["Read(./**/.env)", "Read(./**/*.pem)", "Bash", "Grep", "Edit", "Write"]));
    expect(out.args).not.toContain("Read");
    expect(out.args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']));
    expect(out.args).toEqual(expect.arrayContaining(["--no-session-persistence", "--no-chrome"]));
    expect(out.input).toContain('Question from teammate "alice":\nhow?');
    expect(out.input).toContain("ctx");
    expect(out.cwd).toMatch(/tmp$/);
  });

  it("resumes a specific session when given one", async () => {
    process.env.CLAUDE_SHARE_CLAUDE_BIN = stub;
    const id = "11111111-1111-4111-8111-111111111111";
    const out = JSON.parse(await answerWithFork({ cwd: "/tmp", from: "a", question: "q", sessionId: id }));
    expect(out.args.slice(0, 4)).toEqual(["-p", "--resume", id, "--fork-session"]);
    expect(out.args).not.toContain("--continue");
  });

  it("rejects when claude fails", async () => {
    process.env.CLAUDE_SHARE_CLAUDE_BIN = stub;
    await expect(answerWithFork({ cwd: "/tmp", from: "a", question: "FAIL" })).rejects.toThrow(/exited with 2: boom/);
  });
});
