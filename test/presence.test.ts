import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateGroupSecret, keyFor, roomIdFor, seal } from "../src/crypto.js";
import { Daemon, type Decide } from "../src/daemon.js";
import { startRelay } from "../src/relay.js";
import { compareVersions, VERSION } from "../src/version.js";

let relay: Server;
let relayUrl: string;
const cleanups: (() => unknown)[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

const answer: Decide = async () => ({ action: "send", text: "ok" });

function daemon(secret: string, name: string, extra: Partial<ConstructorParameters<typeof Daemon>[0]> = {}) {
  const d = new Daemon({ secret, relay: relayUrl, name, project: `${name}-proj`, decide: answer, ...extra });
  d.start();
  cleanups.push(() => d.stop());
  return d;
}

// RELAY_URL=ws://… runs these against another relay (e.g. the Cloudflare Worker), whose
// latest/minimum come from its own config.
const external = process.env.RELAY_URL;
beforeEach(async () => {
  if (external) {
    relayUrl = external;
    return;
  }
  relay = await startRelay(0, "127.0.0.1", { latest: "0.6.0", minimum: "0.5.0" });
  relayUrl = `ws://127.0.0.1:${(relay.address() as { port: number }).port}`;
});
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((f) => f()));
  if (external) return;
  relay.closeAllConnections?.();
  await new Promise((r) => relay.close(r));
});

describe("versions", () => {
  it("keeps VERSION in sync with package.json", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });

  it("compares dotted versions", () => {
    expect(compareVersions("0.4.2", "0.5.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.5.0", "0.5")).toBe(0);
  });

  it("tells clients the latest version", async () => {
    const d = daemon(generateGroupSecret(), "alice");
    await waitFor(() => d.server !== null);
    expect(d.server).toMatchObject(external ? { minimum: "0.5.0" } : { latest: "0.6.0", minimum: "0.5.0" });
    expect(d.server?.latest).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("blocks clients below the minimum and stops them retrying", async () => {
    const d = daemon(generateGroupSecret(), "alice", { version: "0.4.9" });
    const blocked = new Promise((r) => d.once("blocked", r));
    expect(await blocked).toMatchObject({ blocked: true, minimum: "0.5.0" });
    await sleep(2500); // past the 2s reconnect delay
    expect(d.connected).toBe(false);
  });
});

describe("old clients", () => {
  it("are kept apart from new clients, which are told how many there are", async () => {
    const secret = generateGroupSecret();
    const asked: string[] = [];
    const alice = daemon(secret, "alice", { share: null });
    daemon(secret, "bob", { decide: async () => (asked.push("bob"), { action: "send", text: "hi" }) });
    await waitFor(() => alice.onlinePeers().length === 1);

    // A pre-0.5 client: no ?v, announces itself with an old-style hello.
    const old = new WebSocket(`${relayUrl}/room/${roomIdFor(secret)}`);
    cleanups.push(() => old.close());
    const oldGot: string[] = [];
    old.on("message", (m) => oldGot.push(m.toString()));
    await new Promise((r) => old.once("open", r));
    old.send(JSON.stringify({ t: "msg", d: seal(keyFor(secret), JSON.stringify({ type: "hello", peer: "old-1", name: "carol", project: "x" })) }));

    await waitFor(() => alice.server?.legacy === 1);
    await sleep(200);
    expect(alice.onlinePeers().map((p) => p.name)).toEqual(["bob"]); // carol is invisible
    expect(await alice.ask("q")).toEqual({ from: "bob", text: "hi" });
    expect(oldGot).toEqual([]); // and nothing from new clients reaches the old one

    old.close();
    await waitFor(() => alice.server?.legacy === 0);
  });
});

describe("presence", () => {
  it("removes a session the moment its connection drops, and fails a question waiting on it", async () => {
    const secret = generateGroupSecret();
    const alice = daemon(secret, "alice", { share: null });
    const bob = daemon(secret, "bob", { decide: () => new Promise(() => {}) }); // never answers
    await waitFor(() => alice.onlinePeers().length === 1);
    const pending = alice.ask("q", { timeoutSec: 60 });
    await sleep(200);
    (bob as any).stopped = true; // crash: no bye, no reconnect
    (bob as any).ws.terminate();
    const started = Date.now();
    expect(await pending).toEqual({ error: "bob's session closed before answering" });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(alice.onlinePeers()).toEqual([]);
  });

  it("sees a session that shares after others are already connected", async () => {
    const secret = generateGroupSecret();
    const alice = daemon(secret, "alice", { share: null });
    const bob = daemon(secret, "bob", { share: null });
    await sleep(300);
    expect(alice.onlinePeers()).toEqual([]);
    bob.setShare({ label: "scraper" });
    await waitFor(() => alice.onlinePeers().length === 1);
    expect(alice.onlinePeers()[0]).toMatchObject({ name: "bob", project: "scraper" });
  });

  it("an idle shared session sends nothing, and re-announces only when it was active again", async () => {
    const secret = generateGroupSecret();
    let activeAt = Date.now();
    const alice = daemon(secret, "alice", { share: null });
    const bob = daemon(secret, "bob", { activityCheckMs: 100, sessionInfo: () => ({ activeAt }) });
    await waitFor(() => alice.onlinePeers().length === 1);
    await sleep(300);
    const before = bob.framesSent;
    await sleep(1000);
    expect(bob.framesSent).toBe(before); // no heartbeat
    activeAt += 6 * 60_000; // used again, more than 5 minutes later
    await waitFor(() => bob.framesSent === before + 1);
    await waitFor(() => alice.onlinePeers()[0]?.activeAt === activeAt);
  });
});
