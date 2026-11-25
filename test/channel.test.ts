import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Channel, SendTarget, ServerInfo } from "../src/channel.js";
import { Daemon, type Decide } from "../src/daemon.js";
import type { Payload } from "../src/protocol.js";

class FakeChannel extends EventEmitter implements Channel {
  connected = true;
  server: ServerInfo | null = null;
  sent: Payload[] = [];
  targets: (SendTarget | undefined)[] = [];
  /** Recipients this fake cannot reach: a send to them reports failure. */
  unreachable = new Set<string>();
  start() {
    this.emit("connected");
  }
  async stop() {}
  send(p: Payload, to?: SendTarget) {
    if (to?.peer && this.unreachable.has(to.peer)) return false;
    this.sent.push(p);
    this.targets.push(to);
    return true;
  }
}

function setup(decide: Decide = async () => ({ action: "send", text: "ok" }), rateLimit?: { max: number; windowMs: number }) {
  const channel = new FakeChannel();
  const daemon = new Daemon({
    secret: "unused",
    relay: "ws://unused",
    channel,
    name: "me",
    project: "proj",
    decide,
    rateLimit,
  });
  daemon.start();
  return { channel, daemon };
}

describe("Daemon over a Channel", () => {
  it("attributes a hello to from.login, ignoring the name in the payload", () => {
    const { channel, daemon } = setup();
    channel.emit("payload", { type: "hello", peer: "p1", name: "mallory", project: "x", v: 3 }, { cid: "c1", login: "alice" });
    expect(daemon.onlinePeers().map((p) => p.name)).toEqual(["alice"]);
    void daemon.stop();
  });

  it("attributes an ask to from.login, ignoring fromName", async () => {
    const { channel, daemon } = setup();
    const seen: string[] = [];
    daemon.on("question", (q: { from: string }) => seen.push(q.from));
    channel.emit("payload", { type: "ask", id: "a1", from: "p2", fromName: "mallory", question: "hi?" }, { login: "alice" });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["alice"]);
    void daemon.stop();
  });

  it("falls back to the claimed name when the channel gives no login", () => {
    const { channel, daemon } = setup();
    channel.emit("payload", { type: "hello", peer: "p1", name: "mallory", project: "x", v: 3 }, { cid: "c1" });
    expect(daemon.onlinePeers().map((p) => p.name)).toEqual(["mallory"]);
    void daemon.stop();
  });

  it("passes the login-derived name, not the claimed one, to decide", async () => {
    let got: { from: string; fromName?: string } | undefined;
    const { channel, daemon } = setup(async (ask) => {
      got = ask;
      return { action: "send", text: "ok" };
    });
    channel.emit("payload", { type: "ask", id: "a2", from: "p2", fromName: "mallory", question: "hi?" }, { login: "alice" });
    await new Promise((r) => setTimeout(r, 20));
    expect(got?.from).toBe("alice");
    expect(got?.fromName).toBe("alice");
    void daemon.stop();
  });

  it("attributes answers and snippets to from.login", async () => {
    const { channel, daemon } = setup();
    channel.emit("payload", { type: "hello", peer: "p1", name: "bob", project: "x", v: 3 }, { cid: "c1" });
    const res = daemon.ask("q?", { peer: "bob", timeoutSec: 2 });
    const ask = channel.sent.find((p) => p.type === "ask") as Extract<Payload, { type: "ask" }>;
    channel.emit("payload", { type: "answer", id: ask.id, from: "p1", text: "yes" }, { login: "alice" });
    expect(await res).toEqual({ from: "alice", text: "yes" });
    channel.emit("payload", { type: "snippet", id: "s1", from: "p1", title: "t", text: "x" }, { login: "alice" });
    expect(daemon.drainInbox().map((s) => s.from)).toEqual(["alice"]);
    void daemon.stop();
  });

  it("ignores a hello or bye for a peer id first seen from another login", () => {
    const { channel, daemon } = setup();
    channel.emit("payload", { type: "hello", peer: "p1", name: "x", project: "alice-proj", v: 3 }, { cid: "c1", login: "alice" });
    channel.emit("payload", { type: "hello", peer: "p1", name: "x", project: "evil", v: 3 }, { cid: "c2", login: "mallory" });
    expect(daemon.onlinePeers().map((p) => [p.name, p.project, p.cid])).toEqual([["alice", "alice-proj", "c1"]]);
    channel.emit("payload", { type: "bye", peer: "p1" }, { cid: "c2", login: "mallory" });
    expect(daemon.onlinePeers().map((p) => p.name)).toEqual(["alice"]);
    // The binding outlives the peer: after alice's bye, mallory still cannot take the id.
    channel.emit("payload", { type: "bye", peer: "p1" }, { cid: "c1", login: "alice" });
    channel.emit("payload", { type: "hello", peer: "p1", name: "x", project: "evil", v: 3 }, { cid: "c2", login: "mallory" });
    expect(daemon.onlinePeers()).toEqual([]);
    void daemon.stop();
  });

  it("ignores an answer from a login other than the asked peer's", async () => {
    const { channel, daemon } = setup();
    channel.emit("payload", { type: "hello", peer: "p1", name: "bob", project: "x", v: 3 }, { cid: "c1", login: "bob" });
    const res = daemon.ask("q?", { peer: "bob", timeoutSec: 2 });
    const ask = channel.sent.find((p) => p.type === "ask") as Extract<Payload, { type: "ask" }>;
    channel.emit("payload", { type: "answer", id: ask.id, from: "p1", text: "forged" }, { login: "mallory" });
    channel.emit("payload", { type: "answer", id: ask.id, from: "p1", text: "real" }, { login: "bob" });
    expect(await res).toEqual({ from: "bob", text: "real" });
    void daemon.stop();
  });

  it("rate limits on the verified login, not the claimed peer id", async () => {
    const { channel, daemon } = setup(undefined, { max: 1, windowMs: 60_000 });
    const handled: string[] = [];
    daemon.on("handled", (h: { action: string }) => handled.push(h.action));
    channel.emit("payload", { type: "ask", id: "q1", from: "pa", question: "1?" }, { login: "alice" });
    channel.emit("payload", { type: "ask", id: "q2", from: "pb", question: "2?" }, { login: "alice" });
    await new Promise((r) => setTimeout(r, 20));
    expect(handled).toEqual(["send"]);
    expect(channel.sent.filter((p) => p.type === "decline").map((p) => (p as { reason: string }).reason)).toEqual([
      expect.stringMatching(/rate limited/),
    ]);
    void daemon.stop();
  });

  it("addresses every directed payload: asks and snippets to the routed peer, replies to the asker's device", async () => {
    const { channel, daemon } = setup();
    channel.emit("payload", { type: "hello", peer: "p1", name: "bob", project: "x", v: 3 }, { cid: "c1", login: "bob", device: "bbbbbbbbbbbbbbbb" });
    const res = daemon.ask("q?", { peer: "bob", timeoutSec: 2 });
    const ask = channel.sent.find((p) => p.type === "ask") as Extract<Payload, { type: "ask" }>;
    expect(channel.targets[channel.sent.indexOf(ask)]).toEqual({ peer: "p1" });
    channel.emit("payload", { type: "answer", id: ask.id, from: "p1", text: "yes" }, { login: "bob", device: "bbbbbbbbbbbbbbbb" });
    expect(await res).toEqual({ from: "bob", text: "yes" });
    expect(daemon.snippet("t", "body", "bob")).toEqual({ ok: true, to: "bob" });
    expect(channel.targets[channel.sent.findIndex((p) => p.type === "snippet")]).toEqual({ peer: "p1" });

    // An incoming question: status and answer go back to the device it came from.
    channel.emit("payload", { type: "ask", id: "q9", from: "pz", question: "?" }, { login: "alice", device: "aaaaaaaaaaaaaaaa" });
    await new Promise((r) => setTimeout(r, 20));
    const replies = channel.sent.map((p, i) => [p.type, channel.targets[i]] as const).filter(([, t]) => t?.device);
    expect(replies).toEqual([
      ["status", { device: "aaaaaaaaaaaaaaaa" }],
      ["answer", { device: "aaaaaaaaaaaaaaaa" }],
    ]);
    // Presence is never addressed.
    expect(channel.sent.map((p, i) => [p.type, channel.targets[i]]).filter(([t]) => t === "hello" || t === "bye")).toEqual(
      channel.sent.filter((p) => p.type === "hello").map(() => ["hello", undefined]),
    );
    void daemon.stop();
  });

  it("an ask the channel cannot deliver fails at once with a clear error, and a snippet reports it", async () => {
    const { channel, daemon } = setup();
    channel.emit("payload", { type: "hello", peer: "p1", name: "bob", project: "x", v: 3 }, { cid: "c1", login: "bob" });
    channel.unreachable.add("p1");
    expect(await daemon.ask("q?", { peer: "bob", timeoutSec: 5 })).toEqual({ error: "can't reach bob's session right now" });
    expect(daemon.snippet("t", "body", "bob")).toEqual({ error: "can't reach bob's session right now" });
    expect(channel.sent.filter((p) => p.type === "ask" || p.type === "snippet")).toEqual([]);
    void daemon.stop();
  });

  it("caps remembered peer owners, keeping those of peers still online", () => {
    const { channel, daemon } = setup();
    channel.emit("payload", { type: "hello", peer: "keep", name: "bob", project: "x", v: 3 }, { cid: "c1", login: "bob" });
    for (let i = 0; i < 1100; i++) {
      channel.emit("payload", { type: "hello", peer: `p${i}`, name: "m", project: "x", v: 3 }, { cid: "c2", login: "mallory" });
      channel.emit("payload", { type: "bye", peer: `p${i}` }, { cid: "c2", login: "mallory" });
    }
    const owners = (daemon as unknown as { peerOwner: Map<string, string> }).peerOwner;
    expect(owners.size).toBeLessThanOrEqual(1000);
    expect(owners.get("keep")).toBe("bob");
    channel.emit("payload", { type: "hello", peer: "keep", name: "x", project: "evil", v: 3 }, { cid: "c3", login: "mallory" });
    expect(daemon.onlinePeers().find((p) => p.peer === "keep")?.name).toBe("bob");
    void daemon.stop();
  });
});
