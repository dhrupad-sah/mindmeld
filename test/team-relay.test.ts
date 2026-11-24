import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openFromDevice } from "../src/teamcrypto.js";
import { signInTestUser, type TestUser } from "./helpers/signin.js";
import { epochCommit, keysBody, newTeamKey, signedWrap, verifyWrapSig, wrapSig } from "./helpers/teamkeys.js";
import { startTestRelay, type TestRelay } from "./helpers/worker.js";

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
        { uid: alice.uid, login: alice.login, role: "admin", devices: [{ deviceId: alice.id.deviceId, signPub: alice.id.signPub, boxPub: alice.id.boxPub, hasKey: false }] },
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
      ["PUT", `/v1/teams/${teamId}/keys`, keysBody(mallory.id, teamId, 1, newTeamKey(), [mallory.id])],
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
      uid: bob.uid,
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
    const bob2 = await signInTestUser(relay, bob.login, bob.uid);
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    expect((await call(bob2, "POST", `/v1/teams/${teamId}/devices`)).status).toBe(200);
    const bobDevices = (await roster(alice, teamId)).members.find((m: any) => m.login === bob.login).devices;
    expect(bobDevices.map((d: any) => d.deviceId)).toEqual([bob.id.deviceId, bob2.id.deviceId]);
    const body = keysBody(alice.id, teamId, 1, newTeamKey(), [alice.id, bob.id, bob2.id]);
    expect((await call(alice, "PUT", `/v1/teams/${teamId}/keys`, body)).status).toBe(200);

    const del = await call(alice, "DELETE", `/v1/teams/${teamId}/members/${bob.login}`);
    expect(del).toEqual({ status: 200, body: { needsRotation: true } });
    const r = await roster(alice, teamId);
    expect(r.members.map((m: any) => m.login)).toEqual([alice.login]);
    for (const u of [bob, bob2]) {
      expect((await call(u, "GET", `/v1/teams/${teamId}`)).status).toBe(403);
      expect((await call(u, "GET", `/v1/teams/${teamId}/keys`)).status).toBe(403);
    }
    expect((await call(bob, "GET", "/v1/teams")).body).toEqual([]);
    expect((await call(alice, "GET", `/v1/teams/${teamId}/keys`)).body.wrapped.sealed).toBe(body.wrapped[alice.id.deviceId].sealed);
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
    const [k1, k2] = [newTeamKey(), newTeamKey()];
    const put = (u: TestUser, body: unknown) => call(u, "PUT", `/v1/teams/${teamId}/keys`, body);
    expect((await put(bob, keysBody(bob.id, teamId, 1, k1, [alice.id, bob.id]))).status).toBe(403);
    expect((await roster(alice, teamId)).epoch).toBe(0);
    expect((await put(alice, keysBody(alice.id, teamId, 1, k1, [alice.id, bob.id]))).status).toBe(200);
    const b2 = keysBody(alice.id, teamId, 2, k2, [alice.id, bob.id]);
    expect((await put(alice, b2)).status).toBe(200);
    // Lower epoch: refused for anyone.
    expect((await put(alice, keysBody(alice.id, teamId, 1, k1, [alice.id, bob.id]))).status).toBe(409);
    // Same epoch: any member may add a wrap for a device that lacks one, but not overwrite one.
    const bob2 = await signInTestUser(relay, bob.login, bob.uid);
    expect((await call(bob2, "POST", `/v1/teams/${teamId}/devices`)).status).toBe(200);
    expect((await put(bob, keysBody(bob.id, teamId, 2, newTeamKey(), [bob.id], false))).status).toBe(409);
    const add = keysBody(bob.id, teamId, 2, k2, [bob2.id], false);
    expect((await put(bob, add)).status).toBe(200);
    const got = (await call(bob2, "GET", `/v1/teams/${teamId}/keys`)).body;
    const wrap = { ...add.wrapped[bob2.id.deviceId], by: bob.id.deviceId, commit: { ...b2.commit, by: alice.id.deviceId } };
    expect(got).toEqual({ epoch: 2, wrapped: wrap, epochs: { 2: wrap } });
    expect(openFromDevice(bob2.id, got.wrapped.sealed)).toEqual(k2);
    expect((await call(bob, "GET", `/v1/teams/${teamId}/keys`)).body.wrapped.sealed).toBe(b2.wrapped[bob.id.deviceId].sealed);
    const r = await roster(alice, teamId);
    expect(r.members.flatMap((m: any) => m.devices.map((d: any) => d.hasKey))).toEqual([true, true, true]);
  });

  it("rotation must cover all current devices", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    const keys = (body: unknown) => call(alice, "PUT", `/v1/teams/${teamId}/keys`, body);
    const k = newTeamKey();
    expect((await keys(keysBody(alice.id, teamId, 1, k, [alice.id]))).status).toBe(400);
    expect((await keys(keysBody(alice.id, teamId, 1, k, [alice.id, bob.id, { deviceId: "0123456789abcdef", boxPub: bob.id.boxPub }]))).status).toBe(400);
    expect((await roster(alice, teamId)).epoch).toBe(0);
    const bodies = [];
    for (let e = 1; e <= 4; e++) {
      const b = keysBody(alice.id, teamId, e, newTeamKey(), [alice.id, bob.id]);
      bodies[e] = b;
      expect((await keys(b)).status).toBe(200);
    }
    // Current plus up to two previous epochs, each with who wrote it and the epoch commit.
    const got = (await call(bob, "GET", `/v1/teams/${teamId}/keys`)).body;
    const wrapAt = (e: number) => ({ ...bodies[e].wrapped[bob.id.deviceId], by: alice.id.deviceId, commit: { ...bodies[e].commit, by: alice.id.deviceId } });
    expect(got).toEqual({ epoch: 4, wrapped: wrapAt(4), epochs: { 2: wrapAt(2), 3: wrapAt(3), 4: wrapAt(4) } });
  });

  it("forged wrap signature is rejected", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    const put = (u: TestUser, body: unknown) => call(u, "PUT", `/v1/teams/${teamId}/keys`, body);
    const k = newTeamKey();
    // Bob's wrap signed by a different device (bob's) though alice sends it.
    const byOther = keysBody(alice.id, teamId, 1, k, [alice.id, bob.id]);
    byOther.wrapped[bob.id.deviceId] = signedWrap(bob.id, teamId, 1, bob.id, k);
    expect((await put(alice, byOther)).status).toBe(400);
    // A signature made over a different recipient.
    const otherRecipient = keysBody(alice.id, teamId, 1, k, [alice.id, bob.id]);
    const w = otherRecipient.wrapped[bob.id.deviceId];
    w.sig = wrapSig(alice.id, teamId, 1, alice.id.deviceId, w.sealed);
    expect((await put(alice, otherRecipient)).status).toBe(400);
    // Over a different team or epoch.
    const otherEpoch = keysBody(alice.id, teamId, 1, k, [alice.id, bob.id]);
    otherEpoch.wrapped[bob.id.deviceId].sig = wrapSig(alice.id, teamId, 2, bob.id.deviceId, otherEpoch.wrapped[bob.id.deviceId].sealed);
    expect((await put(alice, otherEpoch)).status).toBe(400);
    expect((await roster(alice, teamId)).epoch).toBe(0);
    expect((await call(bob, "GET", `/v1/teams/${teamId}/keys`)).body).toEqual({ epoch: 0, wrapped: null, epochs: {} });
    // Same-epoch add with a wrap signed by someone other than the caller.
    expect((await put(alice, keysBody(alice.id, teamId, 1, k, [alice.id, bob.id]))).status).toBe(200);
    const bob2 = await signInTestUser(relay, bob.login, bob.uid);
    expect((await call(bob2, "POST", `/v1/teams/${teamId}/devices`)).status).toBe(200);
    expect((await put(bob, keysBody(alice.id, teamId, 1, k, [bob2.id], false))).status).toBe(400);
    expect((await call(bob2, "GET", `/v1/teams/${teamId}/keys`)).body.wrapped).toBeNull();
  });

  it("wrap records who wrote it", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    await join(alice, teamId, carol);
    const k = newTeamKey();
    expect((await call(alice, "PUT", `/v1/teams/${teamId}/keys`, keysBody(alice.id, teamId, 1, k, [alice.id, bob.id, carol.id]))).status).toBe(200);
    const carol2 = await signInTestUser(relay, carol.login, carol.uid);
    expect((await call(carol2, "POST", `/v1/teams/${teamId}/devices`)).status).toBe(200);
    expect((await call(bob, "PUT", `/v1/teams/${teamId}/keys`, keysBody(bob.id, teamId, 1, k, [carol2.id], false))).status).toBe(200);
    const { wrapped } = (await call(carol2, "GET", `/v1/teams/${teamId}/keys`)).body;
    expect(wrapped.by).toBe(bob.id.deviceId);
    expect(verifyWrapSig(bob.id.signPub, teamId, 1, carol2.id.deviceId, wrapped.sealed, wrapped.sig)).toBe(true);
    expect(wrapped.commit.by).toBe(alice.id.deviceId);
    expect(openFromDevice(carol2.id, wrapped.sealed)).toEqual(k);
  });

  it("rotation without a valid commit is rejected", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    const k = newTeamKey();
    const put = (body: unknown) => call(alice, "PUT", `/v1/teams/${teamId}/keys`, body);
    const all = [alice.id, bob.id];
    expect((await put(keysBody(alice.id, teamId, 1, k, all, false))).status).toBe(400);
    expect((await put({ ...keysBody(alice.id, teamId, 1, k, all), commit: epochCommit(bob.id, teamId, 1, k) })).status).toBe(400);
    expect((await put({ ...keysBody(alice.id, teamId, 1, k, all), commit: { ...epochCommit(alice.id, teamId, 2, k), hash: epochCommit(alice.id, teamId, 1, k).hash } })).status).toBe(400);
    expect((await put({ ...keysBody(alice.id, teamId, 1, k, all), commit: { hash: "zz", sig: "00" } })).status).toBe(400);
    expect((await roster(alice, teamId)).epoch).toBe(0);
    expect((await put(keysBody(alice.id, teamId, 1, k, all))).status).toBe(200);
    // A commit only belongs on a rotation.
    expect((await put(keysBody(alice.id, teamId, 1, k, [alice.id]))).status).toBe(400);
  });

  it("rotation must be exactly current+1", async () => {
    const alice = await user("alice");
    const teamId = await createTeam(alice);
    const put = (e: number) => call(alice, "PUT", `/v1/teams/${teamId}/keys`, keysBody(alice.id, teamId, e, newTeamKey(), [alice.id]));
    expect((await put(2)).status).toBe(409);
    expect((await put(1)).status).toBe(200);
    expect((await put(3)).status).toBe(409);
    expect((await put(2)).status).toBe(200);
    expect((await roster(alice, teamId)).epoch).toBe(2);
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

  it("membership follows the GitHub numeric id, not the login", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await createTeam(alice);
    await join(alice, teamId, bob);
    const before = await roster(alice, teamId);
    expect(before.members.map((m: any) => [m.uid, m.login])).toEqual([[alice.uid, alice.login], [bob.uid, bob.login]]);

    // Bob renames his GitHub account; someone else registers his old login.
    const renamed = `${bob.login}-new`;
    const squatter = await signInTestUser(relay, bob.login);
    expect(squatter.uid).not.toBe(bob.uid);
    expect((await call(squatter, "GET", `/v1/teams/${teamId}`)).status).toBe(403);
    expect((await call(squatter, "GET", `/v1/teams/${teamId}/keys`)).status).toBe(403);
    expect((await call(squatter, "POST", `/v1/teams/${teamId}/accept`)).status).toBe(403);
    expect((await call(squatter, "GET", "/v1/teams")).body).toEqual([]);

    // Bob signs in again under the new login: still a member, shown with the new login.
    const bobAgain = await signInTestUser(relay, renamed, bob.uid);
    expect(bobAgain.uid).toBe(bob.uid);
    expect((await call(bobAgain, "GET", "/v1/teams")).body).toEqual([{ teamId, name: "core", role: "member" }]);
    const after = await roster(alice, teamId);
    expect(after.members.map((m: any) => [m.uid, m.login])).toEqual([[alice.uid, alice.login], [bob.uid, renamed]]);
    // Admins still address members by their (current) login.
    expect((await call(alice, "POST", `/v1/teams/${teamId}/roles`, { login: renamed, role: "admin" })).status).toBe(200);
    expect((await call(alice, "POST", `/v1/teams/${teamId}/roles`, { login: bob.login, role: "member" })).status).toBe(404);
  });

  it("an invite is addressed by login and binds to the id that accepts it", async () => {
    const alice = await user("alice");
    const carol = await user("carol");
    const teamId = await createTeam(alice);
    expect((await call(alice, "POST", `/v1/teams/${teamId}/invites`, { login: carol.login })).status).toBe(200);
    expect((await call(carol, "POST", `/v1/teams/${teamId}/accept`)).status).toBe(200);
    const member = (await roster(alice, teamId)).members.find((m: any) => m.login === carol.login);
    expect(member.uid).toBe(carol.uid);
    // The invite is used up: a later account with carol's old login can't accept it again.
    await signInTestUser(relay, `${carol.login}-x`, carol.uid);
    const squatter = await signInTestUser(relay, carol.login);
    expect((await call(squatter, "POST", `/v1/teams/${teamId}/accept`)).status).toBe(403);
    expect((await call(squatter, "GET", "/v1/teams")).body).toEqual([]);
  });

  it("tokens carry the GitHub id", async () => {
    const alice = await user("alice");
    const me = await (await fetch(`${relay.url}/v1/me`, { headers: { authorization: `Bearer ${alice.token}` } })).json();
    expect(me).toEqual({ uid: alice.uid, login: alice.login, deviceId: alice.id.deviceId });
    expect(Number.isSafeInteger(alice.uid) && alice.uid > 0).toBe(true);
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
    const good = keysBody(alice.id, teamId, 1, newTeamKey(), [alice.id]);
    const w = good.wrapped[dev];
    for (const body of [
      { ...good, epoch: 0 },
      { ...good, epoch: 1.5 },
      { ...good, epoch: "1" },
      { ...good, wrapped: { XYZ: w } },
      { ...good, wrapped: { [dev]: 5 } },
      { ...good, wrapped: { [dev]: w.sealed } },
      { ...good, wrapped: { [dev]: { sealed: "not base64!", sig: w.sig } } },
      { ...good, wrapped: { [dev]: { sealed: w.sealed } } },
      { ...good, commit: { hash: good.commit.hash } },
      { epoch: 1 },
    ]) {
      expect((await call(alice, "PUT", `/v1/teams/${teamId}/keys`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(alice, "GET", "/v1/teams/not-a-team")).status).toBe(404);
  });
});
