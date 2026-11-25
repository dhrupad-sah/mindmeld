import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { Payload } from "../src/protocol.js";
import { openFrame, sealDirect, sealFrame, type DirectFrame, type TeamFrame } from "../src/teamcrypto.js";
import { TeamChannel } from "../src/teamchannel.js";
import { VERSION } from "../src/version.js";
import { signInTestUser, type TestUser } from "./helpers/signin.js";
import { keysBody, newTeamKey } from "./helpers/teamkeys.js";
import { startTestRelay, type TestRelay } from "./helpers/worker.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

const TOO_OLD = (v: string) => `mindmeld ${v} is too old for teams; update: claude plugin update mindmeld@mindmeld`;

describe("direct (per-recipient) team messages", () => {
  let relay: TestRelay;
  beforeAll(async () => {
    relay = await startTestRelay();
  }, 60_000);
  afterAll(async () => {
    await relay?.stop();
  }, 30_000);

  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  let n = 0;
  const user = (base: string) => signInTestUser(relay, `${base}${++n}`);
  const session = (u: TestUser) => ({ uid: u.uid, login: u.login, token: u.token, expiresAt: Date.now() / 1000 + 3600, relay: relay.url });
  const call = async (u: TestUser, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${relay.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${u.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.status, `${method} ${path}`).toBe(200);
    return res.json() as Promise<any>;
  };
  async function team(admin: TestUser, members: TestUser[]) {
    const { teamId } = await call(admin, "POST", "/v1/teams", { name: "core" });
    for (const m of members) {
      await call(admin, "POST", `/v1/teams/${teamId}/invites`, { login: m.login });
      await call(m, "POST", `/v1/teams/${teamId}/accept`);
    }
    const key = newTeamKey();
    await call(admin, "PUT", `/v1/teams/${teamId}/keys`, keysBody(admin.id, teamId, 1, key, [admin, ...members].map((u) => u.id)));
    return { teamId: teamId as string, key };
  }
  /** A raw team socket for `u` (client version `v`), recording every message and its close. */
  function raw(u: TestUser, teamId: string, v: string | null = VERSION) {
    const q = v === null ? "" : `?v=${encodeURIComponent(v)}`;
    const ws = new WebSocket(`${relay.wsUrl}/v1/teams/${teamId}/ws${q}`, { headers: { authorization: `Bearer ${u.token}` } });
    const msgs: any[] = [];
    let closed: { code: number; reason: string } | null = null;
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    ws.on("close", (code, reason) => (closed = { code, reason: reason.toString() }));
    ws.on("error", () => {});
    cleanups.push(() => ws.close());
    return { ws, msgs, closed: () => closed };
  }
  function daemon(u: TestUser, teamId: string, share: boolean) {
    const channel = new TeamChannel({ relayHttp: relay.url, teamId, session: session(u), id: u.id });
    const payloads: Payload[] = [];
    channel.on("payload", (p: Payload) => payloads.push(p));
    const questions: string[] = [];
    const d = new Daemon({
      relay: "ws://unused",
      channel,
      name: u.login,
      project: "proj",
      share: share ? { label: `${u.login}-work` } : null,
      decide: async (ask) => {
        questions.push(ask.question);
        return { action: "send", text: `answer from ${u.login}: 42` };
      },
    });
    d.start();
    cleanups.push(() => d.stop());
    return { d, channel, payloads, questions };
  }
  const roster = (...us: TestUser[]) => new Map(us.map((u) => [u.id.deviceId, { uid: u.uid, login: u.login, signPub: u.id.signPub }]));

  it("a question and its answer reach only the two devices involved", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const { teamId, key } = await team(alice, [bob, carol]);
    const c = daemon(carol, teamId, true);
    const spy = raw(carol, teamId); // a second socket on carol's device, as a modified client would see it
    await waitFor(() => spy.msgs.some((m) => m.t === "server"));
    const b = daemon(bob, teamId, true);
    const a = daemon(alice, teamId, false); // askers never announce themselves
    await waitFor(() => a.d.onlinePeers().length === 2 && c.d.onlinePeers().length === 1);

    const statuses: string[] = [];
    const res = await a.d.ask("what is the secret plan?", { peer: bob.login, timeoutSec: 10, onStatus: (s) => statuses.push(s) });
    expect(res).toEqual({ from: bob.login, text: `answer from ${bob.login}: 42` });
    expect(statuses).toContain("received");
    expect(b.questions).toEqual(["what is the secret plan?"]);
    expect(a.d.snippet("notes", "secret snippet body", bob.login)).toEqual({ ok: true, to: bob.login });
    await waitFor(() => b.payloads.some((p) => p.type === "snippet"));
    await sleep(200);

    // Carol's device got no directed frame at all, and every broadcast frame it can open is presence.
    expect(spy.msgs.filter((m) => m.t === "dm")).toEqual([]);
    const keys = new Map([[1, key]]);
    const opened = spy.msgs.filter((m) => m.t === "msg").map((m) => openFrame(m.f as TeamFrame, keys, roster(alice, bob, carol)));
    expect(opened.length).toBeGreaterThan(0);
    for (const o of opened) expect(["hello", "bye"]).toContain(JSON.parse(o!.payload).type);
    expect(JSON.stringify(spy.msgs)).not.toContain("secret");
    expect(c.questions).toEqual([]);
    expect(c.payloads.map((p) => p.type).filter((t) => t !== "hello")).toEqual([]);
  }, 30_000);

  it("the relay delivers a dm only to its recipient, only from the sending socket's own device, only to member devices", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const eve = await user("eve"); // signed in, not in the team
    const { teamId } = await team(alice, [bob, carol]);
    const ra = raw(alice, teamId);
    const rb = raw(bob, teamId);
    const rc = raw(carol, teamId);
    await waitFor(() => [ra, rb, rc].every((r) => r.msgs.some((m) => m.t === "server")));
    const dm = (f: DirectFrame, to = f.to) => rc.ws.send(JSON.stringify({ t: "dm", to, f }));
    const toBob = { deviceId: bob.id.deviceId, boxPub: bob.id.boxPub };
    dm(sealDirect(teamId, { ...carol.id, deviceId: alice.id.deviceId }, toBob, "claims alice")); // f.dev is not carol's device
    dm(sealDirect(teamId, carol.id, { deviceId: eve.id.deviceId, boxPub: eve.id.boxPub }, "to a non-member"));
    dm(sealDirect(teamId, carol.id, toBob, "mismatched to"), alice.id.deviceId); // envelope and frame disagree
    dm(sealDirect(teamId, carol.id, toBob, "genuine"));
    await waitFor(() => rb.msgs.some((m) => m.t === "dm"));
    await sleep(300);
    const got = rb.msgs.filter((m) => m.t === "dm");
    expect(got).toEqual([{ t: "dm", f: expect.objectContaining({ dev: carol.id.deviceId, to: bob.id.deviceId }), c: expect.any(String), uid: carol.uid, login: carol.login }]);
    expect(ra.msgs.filter((m) => m.t === "dm")).toEqual([]);
    expect(rc.msgs.filter((m) => m.t === "dm")).toEqual([]); // no echo
  }, 30_000);

  it("a forged or misdirected dm reaching a client is dropped", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const { teamId } = await team(alice, [bob, carol]);
    const b = new TeamChannel({ relayHttp: relay.url, teamId, session: session(bob), id: bob.id });
    const got: { p: Payload; device?: string; login?: string }[] = [];
    b.on("payload", (p: Payload, from: { device?: string; login?: string }) => got.push({ p, ...from }));
    b.start();
    cleanups.push(() => b.stop());
    await waitFor(() => b.connected && b.status === null);
    const inject = (f: DirectFrame, u: TestUser, c = `c-${u.login}`) =>
      (b as unknown as { handleMessage(raw: string): void }).handleMessage(JSON.stringify({ t: "dm", f, c, uid: u.uid, login: u.login }));
    const toBob = { deviceId: bob.id.deviceId, boxPub: bob.id.boxPub };
    const ask = (q: string) => JSON.stringify({ type: "ask", id: q, from: "pa", question: q });
    inject(sealDirect(teamId, { ...carol.id, deviceId: alice.id.deviceId }, toBob, ask("forged-sig")), alice);
    inject(sealDirect(teamId, alice.id, { deviceId: carol.id.deviceId, boxPub: carol.id.boxPub }, ask("for-carol")), alice);
    inject(sealDirect("ffffffffffffffff", alice.id, toBob, ask("other-team")), alice);
    inject(sealDirect(teamId, alice.id, toBob, ask("stamp-mismatch")), carol);
    inject(sealDirect(teamId, alice.id, toBob, JSON.stringify({ type: "hello", peer: "px", name: "x", project: "p", v: 3 })), alice);
    inject(sealDirect(teamId, alice.id, toBob, ask("genuine")), alice);
    await sleep(50);
    expect(got).toEqual([{ p: expect.objectContaining({ type: "ask", question: "genuine" }), device: alice.id.deviceId, login: alice.login, uid: alice.uid, cid: "c-" + alice.login }]);
    expect(b.framesDropped).toBe(5);
    // A broadcast carrying a question (as a modified client might send) is dropped too.
    const key = (b as unknown as { keys: Map<number, Uint8Array> }).keys.get(1)!;
    (b as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify({ t: "msg", f: sealFrame(1, key, alice.id, ask("broadcast-ask")), c: "c-" + alice.login, uid: alice.uid, login: alice.login }),
    );
    await sleep(20);
    expect(got.length).toBe(1);
    expect(b.framesDropped).toBe(6);
  }, 30_000);

  it("a directed payload with no resolvable recipient is not sent, and never broadcast", async () => {
    const alice = await user("alice");
    const { teamId } = await team(alice, []);
    const a = new TeamChannel({ relayHttp: relay.url, teamId, session: session(alice), id: alice.id });
    a.start();
    cleanups.push(() => a.stop());
    await waitFor(() => a.connected && a.status === null);
    const ask: Payload = { type: "ask", id: "q1", from: "pa", question: "?" };
    expect(a.send(ask)).toBe(false);
    expect(a.send(ask, { peer: "nobody" })).toBe(false);
    expect(a.send(ask, { device: "0123456789abcdef" })).toBe(false);
    expect(a.framesSent).toBe(0);
    expect(a.send({ type: "hello", peer: "pa", name: "a", project: "p", v: 3 })).toBe(true);
    expect(a.framesSent).toBe(1);
  }, 30_000);

  it("refuses team clients older than 0.7 with a clear reason", async () => {
    const alice = await user("alice");
    const { teamId } = await team(alice, []);
    const old = new TeamChannel({ relayHttp: relay.url, teamId, session: session(alice), id: alice.id, version: "0.6.1", retry: { baseMs: 50, maxMs: 100 } });
    const closes: { code: number; reason: string }[] = [];
    old.on("closed", (code: number, reason: string) => closes.push({ code, reason }));
    old.on("relay-error", () => {});
    old.start();
    cleanups.push(() => old.stop());
    await waitFor(() => closes.length > 0);
    expect(closes[0]).toEqual({ code: 4005, reason: TOO_OLD("0.6.1") });
    expect(old.status).toBe(TOO_OLD("0.6.1"));
    expect(old.connected).toBe(false);
    await sleep(500);
    expect(closes.length).toBe(1); // no retry: the relay will refuse it again
    // 0.6.x clients send no version at all.
    const r = raw(alice, teamId, null);
    await waitFor(() => r.closed() !== null);
    expect(r.closed()!.code).toBe(4005);
    expect(r.msgs).toEqual([]);
    const current = raw(alice, teamId);
    await waitFor(() => current.msgs.some((m) => m.t === "server"));
  }, 30_000);
});
