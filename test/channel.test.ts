import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Channel, ServerInfo } from "../src/channel.js";
import { Daemon, type Decide } from "../src/daemon.js";
import type { Payload } from "../src/protocol.js";

class FakeChannel extends EventEmitter implements Channel {
  connected = true;
  server: ServerInfo | null = null;
  sent: Payload[] = [];
  start() {
    this.emit("connected");
  }
  async stop() {}
  send(p: Payload) {
    this.sent.push(p);
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
});
