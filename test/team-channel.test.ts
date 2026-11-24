import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { Payload } from "../src/protocol.js";
import { openFrame, sealFrame, type TeamFrame } from "../src/teamcrypto.js";
import { backoffDelay, SIGN_IN_EXPIRED, TeamChannel } from "../src/teamchannel.js";
import { fetchRoster, fetchTeamKeys, WAITING_FOR_KEY } from "../src/teamkeys.js";
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

describe("team channel", () => {
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
  /** A team with `admin` and `members`; epoch 1 key wrapped for everyone in `keyed`. */
  async function team(admin: TestUser, members: TestUser[], keyed: TestUser[]) {
    const { teamId } = await call(admin, "POST", "/v1/teams", { name: "core" });
    for (const m of members) {
      await call(admin, "POST", `/v1/teams/${teamId}/invites`, { login: m.login });
      await call(m, "POST", `/v1/teams/${teamId}/accept`);
    }
    const key = newTeamKey();
    await call(admin, "PUT", `/v1/teams/${teamId}/keys`, keysBody(admin.id, teamId, 1, key, keyed.map((u) => u.id)));
    return { teamId: teamId as string, key };
  }
  function channel(u: TestUser, teamId: string, over: Partial<ConstructorParameters<typeof TeamChannel>[0]> = {}) {
    const ch = new TeamChannel({ relayHttp: relay.url, teamId, session: session(u), id: u.id, ...over });
    const got: { p: Payload; login?: string; uid?: number; cid?: string }[] = [];
    const closes: { code: number; reason: string }[] = [];
    ch.on("payload", (p: Payload, from: { login?: string; uid?: number; cid?: string }) => got.push({ p, ...from }));
    ch.on("closed", (code: number, reason: string) => closes.push({ code, reason }));
    ch.start();
    cleanups.push(() => ch.stop());
    return { ch, got, closes };
  }
  /** A raw team socket for `u`, recording every message and its close. */
  function raw(u: TestUser, teamId: string) {
    const ws = new WebSocket(`${relay.wsUrl}/v1/teams/${teamId}/ws`, { headers: { authorization: `Bearer ${u.token}` } });
    const msgs: any[] = [];
    let closed: { code: number; reason: string } | null = null;
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    ws.on("close", (code, reason) => (closed = { code, reason: reason.toString() }));
    ws.on("error", () => {});
    cleanups.push(() => ws.close());
    return { ws, msgs, closed: () => closed };
  }
  const hello = (name: string): Payload => ({ type: "hello", peer: `peer-${name}`, name, project: "p", v: 3 });

  it("members exchange payloads with verified login", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const { teamId } = await team(alice, [bob], [alice, bob]);
    const a = channel(alice, teamId);
    const b = channel(bob, teamId);
    await waitFor(() => a.ch.connected && b.ch.connected);
    expect(a.ch.server).toMatchObject({ t: "server", latest: expect.any(String), minimum: expect.any(String) });
    // The payload claims a name; the receiver only trusts the signature.
    a.ch.send(hello("mallory"));
    await waitFor(() => b.got.length === 1);
    expect(b.got[0]).toMatchObject({ p: { type: "hello", name: "mallory" }, login: alice.login, cid: expect.any(String) });
    b.ch.send(hello("bob"));
    await waitFor(() => a.got.length === 1);
    expect(a.got[0].login).toBe(bob.login);
    expect(a.ch.framesSent).toBe(1);
    expect(b.ch.framesSent).toBe(1);
    expect(a.got.length).toBe(1); // no echo to the sender
  }, 30_000);

  it("forged frame is dropped", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol"); // not in the team: her device key is unknown to the roster
    const { teamId, key } = await team(alice, [bob], [alice, bob]);
    const a = channel(alice, teamId);
    await waitFor(() => a.ch.connected);
    const r = raw(bob, teamId);
    await waitFor(() => r.msgs.some((m) => m.t === "server"));
    const send = (f: TeamFrame) => r.ws.send(JSON.stringify({ t: "msg", f }));
    // Signed by another device under bob's device id: bad signature.
    const forged = sealFrame(1, key, { ...carol.id, deviceId: bob.id.deviceId }, JSON.stringify(hello("forged")));
    send(forged);
    // Claims alice's device: the relay drops it (and alice's signature check would too).
    send(sealFrame(1, key, { ...bob.id, deviceId: alice.id.deviceId }, JSON.stringify(hello("as-alice"))));
    // Encrypted under a key nobody was given.
    send(sealFrame(1, newTeamKey(), bob.id, JSON.stringify(hello("wrong-key"))));
    send(sealFrame(1, key, bob.id, JSON.stringify(hello("genuine"))));
    await waitFor(() => a.got.length >= 1);
    await sleep(200);
    expect(a.got.map((g) => [g.p.type === "hello" && g.p.name, g.login])).toEqual([["genuine", bob.login]]);
  }, 30_000);

  it("drops a frame whose verified GitHub id differs from the relay's stamp or the connection's first sender", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const { teamId, key } = await team(alice, [bob], [alice, bob]);
    const a = channel(alice, teamId);
    await waitFor(() => a.ch.connected && a.ch.status === null);
    const inject = (f: TeamFrame, c: string, u: TestUser, login = u.login) =>
      (a.ch as unknown as { handleMessage(raw: string): void }).handleMessage(JSON.stringify({ t: "msg", f, c, uid: u.uid, login }));
    const fromBob = (name: string) => sealFrame(1, key, bob.id, JSON.stringify(hello(name)));
    inject(fromBob("stamp-mismatch"), "c1", alice); // relay says alice, signature says bob
    inject(fromBob("login-only"), "c3", alice, bob.login); // relay stamps bob's login but alice's id
    inject(fromBob("first"), "c2", bob); // binds c2 to bob's id
    inject(sealFrame(1, key, alice.id, JSON.stringify(hello("rebind"))), "c2", alice); // c2 already bob's
    inject(fromBob("again"), "c2", bob);
    await sleep(50);
    expect(a.got.map((g) => g.p.type === "hello" && g.p.name)).toEqual(["first", "again"]);
    // Delivered with the roster's login for display and the verified id.
    expect(a.got[0]).toMatchObject({ login: bob.login, uid: bob.uid });
  }, 30_000);

  it("removed member cannot read frames after rotation", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const { teamId } = await team(alice, [bob, carol], [alice, bob, carol]);
    const a = channel(alice, teamId);
    const b = channel(bob, teamId);
    await waitFor(() => a.ch.connected && b.ch.connected);
    const bobKeys = await fetchTeamKeys(relay.url, teamId, session(bob), bob.id, await fetchRoster(relay.url, teamId, session(bob)));
    expect([...bobKeys.keys.keys()]).toEqual([1]);

    await call(alice, "DELETE", `/v1/teams/${teamId}/members/${bob.login}`);
    await waitFor(() => b.closes.length > 0);
    expect(b.closes[0]).toEqual({ code: 4001, reason: "removed from team" });
    expect(b.ch.connected).toBe(false);
    expect(b.ch.status).toMatch(/removed/);

    await call(alice, "PUT", `/v1/teams/${teamId}/keys`, keysBody(alice.id, teamId, 2, newTeamKey(), [alice.id, carol.id]));
    await waitFor(() => a.ch.epoch === 2);
    const c = raw(carol, teamId);
    await waitFor(() => c.msgs.some((m) => m.t === "server"));
    a.ch.send(hello("after-rotation"));
    await waitFor(() => c.msgs.some((m) => m.t === "msg"));
    const f = c.msgs.find((m) => m.t === "msg").f as TeamFrame;
    expect(f.e).toBe(2);
    const roster = new Map([[alice.id.deviceId, { uid: alice.uid, login: alice.login, signPub: alice.id.signPub }]]);
    for (const k of bobKeys.keys.values()) expect(openFrame(f, new Map([[f.e, k]]), roster)).toBeNull();
    // Bob's channel does not come back.
    await sleep(2500);
    expect(b.closes.length).toBe(1);
  }, 30_000);

  it("device without key gets 4003 and a clear reason", async () => {
    const alice = await user("alice");
    const dave = await user("dave");
    const { teamId } = await team(alice, [], [alice]);
    await call(alice, "POST", `/v1/teams/${teamId}/invites`, { login: dave.login });
    await call(dave, "POST", `/v1/teams/${teamId}/accept`);
    const r = raw(dave, teamId);
    await waitFor(() => r.closed() !== null);
    expect(r.closed()).toEqual({ code: 4003, reason: "no team key yet" });
    expect(r.msgs).toEqual([]);
    const d = channel(dave, teamId);
    await waitFor(() => d.closes.length > 0);
    expect(d.closes[0]).toEqual({ code: 4003, reason: "no team key yet" });
    expect(d.ch.connected).toBe(false);
    expect(d.ch.status).toBe(WAITING_FOR_KEY);
  }, 30_000);

  it("non-members are refused and sockets need a token", async () => {
    const alice = await user("alice");
    const eve = await user("eve");
    const { teamId } = await team(alice, [], [alice]);
    const r = raw(eve, teamId);
    await waitFor(() => r.closed() !== null);
    expect(r.closed()!.code).toBe(4001);
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${relay.wsUrl}/v1/teams/${teamId}/ws`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
    expect(status).toBe(401);
  }, 30_000);

  it("roster changes reach every socket and joined/left carry the id and login", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const { teamId } = await team(alice, [bob], [alice, bob]);
    const r = raw(alice, teamId);
    await waitFor(() => r.msgs.some((m) => m.t === "server"));
    expect(r.msgs[0]).toEqual({ t: "server", latest: expect.any(String), minimum: expect.any(String), epoch: 1 });
    const b = raw(bob, teamId);
    await waitFor(() => r.msgs.some((m) => m.t === "joined"));
    const joined = r.msgs.find((m) => m.t === "joined");
    expect(joined).toEqual({ t: "joined", c: expect.any(String), uid: bob.uid, login: bob.login });
    await call(alice, "POST", `/v1/teams/${teamId}/roles`, { login: bob.login, role: "admin" });
    await waitFor(() => r.msgs.some((m) => m.t === "roster") && b.msgs.some((m) => m.t === "roster"));
    b.ws.close();
    await waitFor(() => r.msgs.some((m) => m.t === "left"));
    expect(r.msgs.find((m) => m.t === "left")).toEqual({ t: "left", c: joined.c, uid: bob.uid, login: bob.login });
  }, 30_000);

  it("daemons ask and answer over team channels, named by login", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const { teamId } = await team(alice, [bob], [alice, bob]);
    const asked: string[] = [];
    const daemon = (u: TestUser, claimed: string) => {
      const d = new Daemon({
        secret: "unused",
        relay: "ws://unused",
        channel: new TeamChannel({ relayHttp: relay.url, teamId, session: session(u), id: u.id }),
        name: claimed,
        project: "proj",
        decide: async (ask) => {
          asked.push(ask.from);
          return { action: "send", text: `hi from ${u.login}` };
        },
      });
      d.start();
      cleanups.push(() => d.stop());
      return d;
    };
    const a = daemon(alice, "mallory");
    const b = daemon(bob, "someone-else");
    await waitFor(() => a.onlinePeers().length === 1 && b.onlinePeers().length === 1);
    expect(a.onlinePeers()[0].name).toBe(bob.login);
    expect(await a.ask("hello?", { peer: bob.login, timeoutSec: 5 })).toEqual({ from: bob.login, text: `hi from ${bob.login}` });
    expect(asked).toEqual([alice.login]);
    expect(a.framesSent).toBeGreaterThan(0);
  }, 30_000);

  it("demoting the admin who rotated keeps the team working", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const { teamId } = await team(alice, [bob, carol], [alice, bob, carol]); // epoch 1 committed by alice
    await call(alice, "POST", `/v1/teams/${teamId}/roles`, { login: bob.login, role: "admin" });
    await call(bob, "POST", `/v1/teams/${teamId}/roles`, { login: alice.login, role: "member" });
    const a = channel(alice, teamId);
    const c = channel(carol, teamId);
    await waitFor(() => a.ch.connected && c.ch.connected);
    expect(c.ch.status).toBeNull();
    expect(c.ch.epoch).toBe(1);
    a.ch.send(hello("alice"));
    await waitFor(() => c.got.length === 1);
    expect(c.got[0].login).toBe(alice.login);
  }, 30_000);

  /** Count fetches to this team's routes from now on. */
  function countFetches(teamId: string) {
    const real = globalThis.fetch;
    let n = 0;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes(teamId)) n++;
      return real(input, init);
    }) as typeof fetch;
    cleanups.push(() => (globalThis.fetch = real));
    return () => n;
  }

  it("a 401 from the relay stops retrying and says sign-in expired", async () => {
    const alice = await user("alice");
    const { teamId } = await team(alice, [], [alice]);
    const fetches = countFetches(teamId);
    const a = channel(alice, teamId, { session: { uid: alice.uid, login: alice.login, token: "not-a-token", expiresAt: Date.now() / 1000 + 3600, relay: relay.url } });
    const expired: string[] = [];
    a.ch.on("auth-expired", (r: string) => expired.push(r));
    await waitFor(() => a.closes.length > 0);
    expect(a.closes).toEqual([{ code: 4401, reason: SIGN_IN_EXPIRED }]);
    expect(a.ch.status).toBe(SIGN_IN_EXPIRED);
    expect(expired).toEqual([SIGN_IN_EXPIRED]);
    const after = fetches();
    expect(after).toBe(1);
    await sleep(3000);
    expect(fetches()).toBe(after);
    expect(a.closes.length).toBe(1);
  }, 30_000);

  it("an expired local session never reaches the relay", async () => {
    const alice = await user("alice");
    const { teamId } = await team(alice, [], [alice]);
    const fetches = countFetches(teamId);
    const a = channel(alice, teamId, { session: { uid: alice.uid, login: alice.login, token: alice.token, expiresAt: Date.now() / 1000 - 1, relay: relay.url } });
    await waitFor(() => a.closes.length > 0);
    expect(a.ch.status).toBe(SIGN_IN_EXPIRED);
    await sleep(300);
    expect(fetches()).toBe(0);
  });

  it("backs off exponentially with jitter while the relay is unreachable, and stop() cancels the retry", async () => {
    const alice = await user("alice");
    const ch = new TeamChannel({ relayHttp: "http://127.0.0.1:1", teamId: "0123456789abcdef", session: { ...session(alice), relay: "http://127.0.0.1:1" }, id: alice.id, retry: { baseMs: 40, maxMs: 320 } });
    ch.on("relay-error", () => {});
    const delays: number[] = [];
    ch.on("retry", (ms: number) => delays.push(ms));
    ch.start();
    cleanups.push(() => ch.stop());
    await waitFor(() => delays.length >= 6, 10_000);
    for (const [i, d] of delays.slice(0, 6).entries()) {
      const exp = Math.min(320, 40 * 2 ** i);
      expect(d).toBeGreaterThanOrEqual(exp * 0.8);
      expect(d).toBeLessThanOrEqual(exp * 1.2);
    }
    await ch.stop();
    const seen = delays.length;
    await sleep(800);
    expect(delays.length).toBe(seen);
  }, 20_000);

  it("backoffDelay starts at the base, doubles, caps and jitters", () => {
    expect(backoffDelay(0, 2000, 60_000, 0.5)).toBe(2000);
    expect(backoffDelay(1, 2000, 60_000, 0.5)).toBe(4000);
    expect(backoffDelay(10, 2000, 60_000, 0.5)).toBe(60_000);
    expect(backoffDelay(0, 2000, 60_000, 0)).toBe(1600);
    expect(backoffDelay(0, 2000, 60_000, 1)).toBe(2400);
    expect(backoffDelay(1000, 2000, 60_000, 1)).toBe(72_000);
  });
});
