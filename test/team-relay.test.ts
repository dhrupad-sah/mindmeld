import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInTestUser, type TestUser } from "./helpers/signin.js";
import { startTestRelay, type TestRelay } from "./helpers/worker.js";

/** Fake sealed blob (the relay treats them as opaque base64). */
const sealed = (tag: string) => Buffer.from(`sealed:${tag}`).toString("base64");

describe("team relay", () => {
  let relay: TestRelay;
  beforeAll(async () => {
    relay = await startTestRelay();
  }, 60_000);
  afterAll(async () => {
    await relay?.stop();
  }, 30_000);

  let n = 0;
  /** A unique login per call so tests do not share Users state. */
  const user = (base: string) => signInTestUser(relay, `${base}${++n}`);
  const call = async (u: TestUser | null, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${relay.url}${path}`, {
      method,
      headers: { ...(u ? { authorization: `Bearer ${u.token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json };
  };
  const createTeam = async (admin: TestUser, name = "core") => {
    const r = await call(admin, "POST", "/v1/teams", { name });
    expect(r.status).toBe(200);
    return r.body.teamId as string;
  };
  /** admin invites `u`, `u` accepts. */
  const join = async (admin: TestUser, teamId: string, u: TestUser) => {
    expect((await call(admin, "POST", `/v1/teams/${teamId}/invites`, { login: u.login })).status).toBe(200);
    expect((await call(u, "POST", `/v1/teams/${teamId}/accept`)).status).toBe(200);
  };
  const roster = async (u: TestUser, teamId: string) => {
    const r = await call(u, "GET", `/v1/teams/${teamId}`);
    expect(r.status).toBe(200);
    return r.body;
  };

  it("creator is admin", async () => {
    const alice = await user("alice");
    const teamId = await createTeam(alice);
    expect(teamId).toMatch(/^[0-9a-f]{16}$/);
    expect((await call(alice, "GET", "/v1/teams")).body).toEqual([{ teamId, name: "core", role: "admin" }]);
    const r = await roster(alice, teamId);
    expect(r).toMatchObject({
      name: "core",
      epoch: 0,
      invites: [],
      members: [
        { login: alice.login, role: "admin", devices: [{ deviceId: alice.id.deviceId, signPub: alice.id.signPub, boxPub: alice.id.boxPub, hasKey: false }] },
      ],
    });
    expect(r.log.map((e: any) => [e.by, e.event, e.subject])).toEqual([[alice.login, "created", alice.login]]);
  });

  it("non-member gets 403 on roster", async () => {
    const alice = await user("alice");
    const mallory = await user("mallory");
    const teamId = await createTeam(alice);
    expect((await call(mallory, "GET", `/v1/teams/${teamId}`)).status).toBe(403);
    for (const [m, p, b] of [
      ["GET", `/v1/teams/${teamId}/keys`, undefined],
      ["POST", `/v1/teams/${teamId}/devices`, undefined],
      ["POST", `/v1/teams/${teamId}/accept`, undefined],
      ["POST", `/v1/teams/${teamId}/invites`, { login: mallory.login }],
      ["PUT", `/v1/teams/${teamId}/keys`, { epoch: 1, wrapped: { [mallory.id.deviceId]: sealed("x") } }],
    ] as const) {
      expect((await call(mallory, m, p, b)).status, `${m} ${p}`).toBe(403);
    }
    expect((await call(null, "GET", `/v1/teams/${teamId}`)).status).toBe(401);
    expect((await call(null, "GET", "/v1/teams")).status).toBe(401);
    expect((await call(mallory, "GET", "/v1/teams/0123456789abcdef")).status).toBe(404);
    expect((await call(mallory, "GET", "/v1/teams")).body).toEqual([]);
  });

  it("invite → accept adds member with device lacking key", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await createTeam(alice, "infra");
    // Logins are case-insensitive.
    expect((await call(alice, "POST", `/v1/teams/${teamId}/invites`, { login: bob.login.toUpperCase() })).status).toBe(200);
    expect((await call(bob, "GET", "/v1/teams")).body).toEqual([{ teamId, name: "infra", role: "invited" }]);
    expect((await roster(alice, teamId)).invites).toEqual([bob.login]);
    expect((await call(bob, "GET", `/v1/teams/${teamId}`)).status).toBe(403);
    expect((await call(bob, "POST", `/v1/teams/${teamId}/accept`)).status).toBe(200);
    const r = await roster(bob, teamId);
    expect(r.invites).toEqual([]);
    expect(r.members.find((m: any) => m.login === bob.login)).toEqual({
      login: bob.login,
      role: "member",
      devices: [{ deviceId: bob.id.deviceId, signPub: bob.id.signPub, boxPub: bob.id.boxPub, hasKey: false }],
    });
    expect((await call(bob, "GET", "/v1/teams")).body).toEqual([{ teamId, name: "infra", role: "member" }]);
    expect((await call(bob, "GET", `/v1/teams/${teamId}/keys`)).body).toEqual({ epoch: 0, wrapped: null, epochs: {} });
  });

  it("member cannot invite", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    expect((await call(bob, "POST", `/v1/teams/${teamId}/invites`, { login: carol.login })).status).toBe(403);
    expect((await call(bob, "POST", `/v1/teams/${teamId}/roles`, { login: bob.login, role: "admin" })).status).toBe(403);
    expect((await call(bob, "DELETE", `/v1/teams/${teamId}/members/${alice.login}`)).status).toBe(403);
    expect((await roster(alice, teamId)).invites).toEqual([]);
    expect((await call(carol, "GET", "/v1/teams")).body).toEqual([]);
  });

  it("removing a member drops all their devices", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const bob2 = await signInTestUser(relay, bob.login);
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    expect((await call(bob2, "POST", `/v1/teams/${teamId}/devices`)).status).toBe(200);
    const bobDevices = (await roster(alice, teamId)).members.find((m: any) => m.login === bob.login).devices;
    expect(bobDevices.map((d: any) => d.deviceId)).toEqual([bob.id.deviceId, bob2.id.deviceId]);
    const wrapped = Object.fromEntries([alice, bob, bob2].map((u) => [u.id.deviceId, sealed(`1:${u.id.deviceId}`)]));
    expect((await call(alice, "PUT", `/v1/teams/${teamId}/keys`, { epoch: 1, wrapped })).status).toBe(200);

    const del = await call(alice, "DELETE", `/v1/teams/${teamId}/members/${bob.login}`);
    expect(del).toEqual({ status: 200, body: { needsRotation: true } });
    const r = await roster(alice, teamId);
    expect(r.members.map((m: any) => m.login)).toEqual([alice.login]);
    for (const u of [bob, bob2]) {
      expect((await call(u, "GET", `/v1/teams/${teamId}`)).status).toBe(403);
      expect((await call(u, "GET", `/v1/teams/${teamId}/keys`)).status).toBe(403);
    }
    expect((await call(bob, "GET", "/v1/teams")).body).toEqual([]);
    expect((await call(alice, "GET", `/v1/teams/${teamId}/keys`)).body.wrapped).toBe(sealed(`1:${alice.id.deviceId}`));
    // Their wrapped keys went too: rejoining does not bring old keys back.
    await join(alice, teamId, bob);
    expect((await call(bob, "GET", `/v1/teams/${teamId}/keys`)).body).toEqual({ epoch: 1, wrapped: null, epochs: {} });
    expect((await call(bob2, "POST", `/v1/teams/${teamId}/devices`)).status).toBe(200);
    expect((await call(bob2, "GET", `/v1/teams/${teamId}/keys`)).body).toEqual({ epoch: 1, wrapped: null, epochs: {} });
  });

  it("cannot remove last admin", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    expect((await call(alice, "DELETE", `/v1/teams/${teamId}/members/${alice.login}`)).status).toBe(409);
    expect((await call(alice, "POST", `/v1/teams/${teamId}/roles`, { login: alice.login, role: "member" })).status).toBe(409);
    expect((await call(alice, "POST", `/v1/teams/${teamId}/roles`, { login: bob.login, role: "admin" })).status).toBe(200);
    expect((await call(bob, "GET", "/v1/teams")).body).toEqual([{ teamId, name: "core", role: "admin" }]);
    expect((await call(bob, "DELETE", `/v1/teams/${teamId}/members/${alice.login}`)).body).toEqual({ needsRotation: true });
    expect((await call(bob, "DELETE", `/v1/teams/${teamId}/members/${bob.login}`)).status).toBe(409);
    expect((await call(bob, "DELETE", `/v1/teams/${teamId}/members/nobody-here`)).status).toBe(404);
  });

  it("higher epoch from non-admin is refused", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    const all = (e: number) => ({ [alice.id.deviceId]: sealed(`${e}a`), [bob.id.deviceId]: sealed(`${e}b`) });
    expect((await call(bob, "PUT", `/v1/teams/${teamId}/keys`, { epoch: 1, wrapped: all(1) })).status).toBe(403);
    expect((await roster(alice, teamId)).epoch).toBe(0);
    expect((await call(alice, "PUT", `/v1/teams/${teamId}/keys`, { epoch: 2, wrapped: all(2) })).status).toBe(200);
    // Lower epoch: refused for anyone.
    expect((await call(alice, "PUT", `/v1/teams/${teamId}/keys`, { epoch: 1, wrapped: all(1) })).status).toBe(409);
    // Same epoch: any member may add a wrap for a device that lacks one, but not overwrite one.
    const bob2 = await signInTestUser(relay, bob.login);
    expect((await call(bob2, "POST", `/v1/teams/${teamId}/devices`)).status).toBe(200);
    expect((await call(bob, "PUT", `/v1/teams/${teamId}/keys`, { epoch: 2, wrapped: { [bob.id.deviceId]: sealed("evil") } })).status).toBe(409);
    expect((await call(bob, "PUT", `/v1/teams/${teamId}/keys`, { epoch: 2, wrapped: { [bob2.id.deviceId]: sealed("2b2") } })).status).toBe(200);
    expect((await call(bob2, "GET", `/v1/teams/${teamId}/keys`)).body).toEqual({ epoch: 2, wrapped: sealed("2b2"), epochs: { 2: sealed("2b2") } });
    expect((await call(bob, "GET", `/v1/teams/${teamId}/keys`)).body.wrapped).toBe(sealed("2b"));
    const r = await roster(alice, teamId);
    expect(r.members.flatMap((m: any) => m.devices.map((d: any) => d.hasKey))).toEqual([true, true, true]);
  });

  it("rotation must cover all current devices", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    const keys = (body: unknown) => call(alice, "PUT", `/v1/teams/${teamId}/keys`, body);
    expect((await keys({ epoch: 1, wrapped: { [alice.id.deviceId]: sealed("1a") } })).status).toBe(400);
    expect((await keys({ epoch: 1, wrapped: { [alice.id.deviceId]: sealed("1a"), [bob.id.deviceId]: sealed("1b"), "0123456789abcdef": sealed("x") } })).status).toBe(400);
    expect((await roster(alice, teamId)).epoch).toBe(0);
    for (let e = 1; e <= 4; e++) {
      expect((await keys({ epoch: e, wrapped: { [alice.id.deviceId]: sealed(`${e}a`), [bob.id.deviceId]: sealed(`${e}b`) } })).status).toBe(200);
    }
    // Current plus up to two previous epochs.
    expect((await call(bob, "GET", `/v1/teams/${teamId}/keys`)).body).toEqual({
      epoch: 4,
      wrapped: sealed("4b"),
      epochs: { 2: sealed("2b"), 3: sealed("3b"), 4: sealed("4b") },
    });
  });

  it("log records invited, joined, removed in order", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    await call(alice, "DELETE", `/v1/teams/${teamId}/members/${bob.login}`);
    const { log } = await roster(alice, teamId);
    expect(log.map((e: any) => [e.by, e.event, e.subject])).toEqual([
      [alice.login, "created", alice.login],
      [alice.login, "invited", bob.login],
      [bob.login, "joined", bob.login],
      [alice.login, "removed", bob.login],
    ]);
    for (const e of log) expect(typeof e.at).toBe("number");
    expect(log.map((e: any) => e.at)).toEqual([...log.map((e: any) => e.at)].sort((a, b) => a - b));
  });

  it("inputs are validated", async () => {
    const alice = await user("alice");
    for (const name of ["", "x".repeat(61), 7, undefined]) {
      expect((await call(alice, "POST", "/v1/teams", { name })).status, String(name)).toBe(400);
    }
    const teamId = await createTeam(alice);
    for (const login of ["bad login", "a".repeat(40), "", "x_y", 3]) {
      expect((await call(alice, "POST", `/v1/teams/${teamId}/invites`, { login })).status, String(login)).toBe(400);
    }
    expect((await call(alice, "POST", `/v1/teams/${teamId}/roles`, { login: alice.login, role: "owner" })).status).toBe(400);
    const dev = alice.id.deviceId;
    for (const body of [
      { epoch: 0, wrapped: { [dev]: sealed("a") } },
      { epoch: 1.5, wrapped: { [dev]: sealed("a") } },
      { epoch: "1", wrapped: { [dev]: sealed("a") } },
      { epoch: 1, wrapped: { XYZ: sealed("a") } },
      { epoch: 1, wrapped: { [dev]: 5 } },
      { epoch: 1, wrapped: { [dev]: "not base64!" } },
      { epoch: 1 },
    ]) {
      expect((await call(alice, "PUT", `/v1/teams/${teamId}/keys`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(alice, "GET", "/v1/teams/not-a-team")).status).toBe(404);
  });
});
