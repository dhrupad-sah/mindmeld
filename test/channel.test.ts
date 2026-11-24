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

function setup(decide: Decide = async () => ({ action: "send", text: "ok" })) {
  const channel = new FakeChannel();
  const daemon = new Daemon({
    secret: "unused",
    relay: "ws://unused",
    channel,
    name: "me",
    project: "proj",
    decide,
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
});
