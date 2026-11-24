import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadOrCreateIdentity, type DeviceIdentity } from "../src/identity.js";
import { openFrame, sealFrame } from "../src/teamcrypto.js";
import { TeamChannel } from "../src/teamchannel.js";
import { ensureTeamKeys, fetchRoster, fetchTeamKeys, rotate, type TeamRoster, verifyTeamKeys, WAITING_FOR_KEY, type WrapEntry } from "../src/teamkeys.js";
import { signInTestUser, type TestUser } from "./helpers/signin.js";
import { epochCommit, keysBody, newTeamKey, signedWrap } from "./helpers/teamkeys.js";
import { startTestRelay, type TestRelay } from "./helpers/worker.js";

function device(): DeviceIdentity {
  const dir = mkdtempSync(join(tmpdir(), "mindmeld-tk-"));
  const prev = process.env.MINDMELD_HOME;
  process.env.MINDMELD_HOME = dir;
  try {
    return loadOrCreateIdentity();
  } finally {
    if (prev === undefined) delete process.env.MINDMELD_HOME;
    else process.env.MINDMELD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

const TEAM = "0123456789abcdef";
const admin = device();
const member = device();
const me = device();
const outsider = device();
const dev = (d: DeviceIdentity) => ({ deviceId: d.deviceId, signPub: d.signPub, boxPub: d.boxPub, hasKey: true });
const roster: TeamRoster = {
  name: "core",
  epoch: 3,
  invites: [],
  log: [],
  members: [
    { login: "ann", role: "admin", devices: [dev(admin)] },
    { login: "max", role: "member", devices: [dev(member)] },
    { login: "me", role: "member", devices: [dev(me)] },
  ],
};

/** A wrap of `key` for `me`, written by `writer`, committed by `committer`. */
function entry(epoch: number, key: Uint8Array, writer = admin, committer = admin): WrapEntry {
  const w = signedWrap(writer, TEAM, epoch, me, key);
  const c = epochCommit(committer, TEAM, epoch, key);
  return { sealed: w.sealed, by: writer.deviceId, sig: w.sig, commit: { hash: c.hash, by: committer.deviceId, sig: c.sig } };
}

describe("verifyTeamKeys", () => {
  it("accepts wraps by any member device committed by an admin", () => {
    const k2 = newTeamKey();
    const k3 = newTeamKey();
    const out = verifyTeamKeys(TEAM, me, roster, { epoch: 3, epochs: { 2: entry(2, k2), 3: entry(3, k3, member) } });
    expect(out.problems).toEqual([]);
    expect(out.epoch).toBe(3);
    expect(out.keys).toEqual(new Map([[2, k2], [3, k3]]));
  });

  it("drops each epoch that fails a check and says why", () => {
    const k = newTeamKey();
    const badWrapSig = { ...entry(1, k), sig: entry(1, newTeamKey()).sig };
    const byOutsider = entry(2, k, outsider);
    const commitByOutsider = entry(3, k, admin, outsider);
    const badCommitSig = (() => {
      const e = entry(4, k);
      return { ...e, commit: { ...e.commit!, sig: entry(5, k).commit!.sig } };
    })();
    const hashMismatch = (() => {
      const e = entry(5, k);
      return { ...e, commit: { ...entry(5, newTeamKey()).commit! } };
    })();
    const noCommit = { ...entry(6, k), commit: null };
    const notForMe = (() => {
      const w = signedWrap(admin, TEAM, 7, { deviceId: me.deviceId, boxPub: outsider.boxPub }, k);
      return { ...entry(7, k), sealed: w.sealed, sig: w.sig };
    })();
    const replayedEpoch = { ...entry(8, k), sig: entry(9, k).sig };
    const out = verifyTeamKeys(TEAM, me, { ...roster, epoch: 9 }, {
      epoch: 9,
      epochs: { 1: badWrapSig, 2: byOutsider, 3: commitByOutsider, 4: badCommitSig, 5: hashMismatch, 6: noCommit, 7: notForMe, 8: replayedEpoch, 9: entry(9, k) },
    });
    expect([...out.keys.keys()]).toEqual([9]);
    expect(out.problems).toHaveLength(8);
    for (const [i, why] of ["signature", "not in the team", "commit signed by a device not in the team", "signature", "hash", "commit", "unwrap", "signature"].entries()) {
      expect(out.problems[i]).toMatch(new RegExp(`^team key for epoch ${i + 1} failed verification \\(.*${why}`));
    }
  });

  it("keeps an epoch committed by an admin who has since been demoted", () => {
    const k = newTeamKey();
    const demoted: TeamRoster = { ...roster, members: roster.members.map((m) => ({ ...m, role: "member" as const })) };
    const out = verifyTeamKeys(TEAM, me, demoted, { epoch: 1, epochs: { 1: entry(1, k) } });
    expect(out.problems).toEqual([]);
    expect(out.keys).toEqual(new Map([[1, k]]));
  });

  it("rejects a wrap signed for another team", () => {
    const k = newTeamKey();
    const w = signedWrap(admin, "fedcba9876543210", 1, me, k);
    const out = verifyTeamKeys(TEAM, me, roster, { epoch: 1, epochs: { 1: { ...entry(1, k), sealed: w.sealed, sig: w.sig } } });
    expect(out.keys.size).toBe(0);
    expect(out.problems[0]).toMatch(/epoch 1 failed verification/);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

describe("key distribution and rotation", () => {
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
  const session = (u: TestUser) => ({ login: u.login, token: u.token, expiresAt: Date.now() / 1000 + 3600 });
  const opts = (u: TestUser, teamId: string) => ({ relayHttp: relay.url, teamId, session: session(u), id: u.id });
  const call = async (u: TestUser, method: string, path: string, body?: unknown, status = 200) => {
    const res = await fetch(`${relay.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${u.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    expect(res.status, `${method} ${path}`).toBe(status);
    return res.json() as Promise<any>;
  };
  async function newTeam(admin: TestUser, members: TestUser[]) {
    const { teamId } = await call(admin, "POST", "/v1/teams", { name: "core" });
    for (const m of members) {
      await call(admin, "POST", `/v1/teams/${teamId}/invites`, { login: m.login });
      await call(m, "POST", `/v1/teams/${teamId}/accept`);
    }
    return teamId as string;
  }
  const keysOf = async (u: TestUser, teamId: string) =>
    fetchTeamKeys(relay.url, teamId, session(u), u.id, await fetchRoster(relay.url, teamId, session(u)));
  function channel(u: TestUser, teamId: string) {
    const ch = new TeamChannel({ ...opts(u, teamId), retry: { baseMs: 50, maxMs: 200 }, noKeyRetryMs: 200 });
    ch.on("relay-error", () => {});
    ch.start();
    cleanups.push(() => ch.stop());
    return ch;
  }

  it("first member creates epoch 1", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await newTeam(alice, [bob]);
    expect((await fetchRoster(relay.url, teamId, session(alice))).epoch).toBe(0);
    // A non-admin cannot create the first key.
    expect(await ensureTeamKeys(opts(bob, teamId))).toEqual({ waiting: WAITING_FOR_KEY });
    expect((await fetchRoster(relay.url, teamId, session(alice))).epoch).toBe(0);
    const a = channel(alice, teamId);
    await waitFor(() => a.connected);
    expect(a.epoch).toBe(1);
    const ak = await keysOf(alice, teamId);
    const bk = await keysOf(bob, teamId);
    expect(ak.problems).toEqual([]);
    expect(bk.problems).toEqual([]);
    expect(bk.keys.get(1)).toEqual(ak.keys.get(1));
    expect(ak.keys.get(1)?.length).toBe(32);
    expect(await ensureTeamKeys(opts(bob, teamId))).toBe("ok");
    expect(await ensureTeamKeys(opts(alice, teamId))).toBe("ok");
    expect((await fetchRoster(relay.url, teamId, session(alice))).epoch).toBe(1);
  }, 30_000);

  it("pending device gets the key when a member comes online", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const teamId = await newTeam(alice, []);
    expect(await ensureTeamKeys(opts(alice, teamId))).toBe("ok"); // epoch 1, alice only
    // Bob accepts while alice is offline.
    await call(alice, "POST", `/v1/teams/${teamId}/invites`, { login: bob.login });
    await call(bob, "POST", `/v1/teams/${teamId}/accept`);
    const b = channel(bob, teamId);
    await waitFor(() => b.status === WAITING_FOR_KEY);
    expect(WAITING_FOR_KEY).toBe("waiting for a teammate to come online to give this device the team key");
    expect(b.connected).toBe(false);
    await sleep(300);
    expect(b.connected).toBe(false);
    // Alice comes online and delivers the key; bob's channel connects on its own.
    const a = channel(alice, teamId);
    await waitFor(() => a.connected && b.connected);
    expect(b.status).toBeNull();
    const roster = await fetchRoster(relay.url, teamId, session(bob));
    expect(roster.members.flatMap((m) => m.devices).every((d) => d.hasKey)).toBe(true);
    expect((await keysOf(bob, teamId)).keys.get(1)).toEqual((await keysOf(alice, teamId)).keys.get(1));
  }, 30_000);

  it("concurrent delivery by two members both succeed", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const teamId = await newTeam(alice, [bob]);
    expect(await ensureTeamKeys(opts(alice, teamId))).toBe("ok");
    await call(alice, "POST", `/v1/teams/${teamId}/invites`, { login: carol.login });
    await call(carol, "POST", `/v1/teams/${teamId}/accept`);
    const results = await Promise.all([ensureTeamKeys(opts(alice, teamId)), ensureTeamKeys(opts(bob, teamId))]);
    expect(results).toEqual(["ok", "ok"]);
    const ck = await keysOf(carol, teamId);
    expect(ck.problems).toEqual([]);
    expect(ck.keys.has(1)).toBe(true);
  }, 30_000);

  it("rotation after removal is readable by remaining devices only", async () => {
    const alice = await user("alice");
    const bob = await user("bob");
    const carol = await user("carol");
    const teamId = await newTeam(alice, [bob, carol]);
    expect(await ensureTeamKeys(opts(alice, teamId))).toBe("ok");
    const bobKeys = await keysOf(bob, teamId);
    expect([...bobKeys.keys.keys()]).toEqual([1]);
    // Only admins rotate.
    await expect(rotate({ ...opts(carol, teamId), reason: "removed" })).rejects.toThrow(/admin/);

    await call(alice, "DELETE", `/v1/teams/${teamId}/members/${bob.login}`);
    expect(await rotate({ ...opts(alice, teamId), reason: "removed" })).toBe(2);

    const ak = await keysOf(alice, teamId);
    const ck = await keysOf(carol, teamId);
    expect(ak.epoch).toBe(2);
    expect(ck.problems).toEqual([]);
    expect(ck.keys.get(2)).toEqual(ak.keys.get(2));
    expect(ck.keys.get(2)).not.toEqual(ck.keys.get(1));
    await call(bob, "GET", `/v1/teams/${teamId}/keys`, undefined, 403);

    const f = sealFrame(2, ak.keys.get(2)!, alice.id, "after-rotation");
    const roster = new Map([[alice.id.deviceId, { login: alice.login, signPub: alice.id.signPub }]]);
    expect(openFrame(f, ck.keys, roster)?.payload).toBe("after-rotation");
    expect(openFrame(f, bobKeys.keys, roster)).toBeNull();
    for (const k of bobKeys.keys.values()) expect(openFrame(f, new Map([[2, k]]), roster)).toBeNull();
  }, 30_000);

  it("a concurrent rotation is reported, not retried", async () => {
    const alice = await user("alice");
    const teamId = await newTeam(alice, []);
    expect(await ensureTeamKeys(opts(alice, teamId))).toBe("ok");
    const real = globalThis.fetch;
    let raced = false;
    // Just before alice's rotation PUT lands, someone else rotates to epoch 2.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (!raced && init?.method === "PUT") {
        raced = true;
        await real(`${relay.url}/v1/teams/${teamId}/keys`, {
          method: "PUT",
          headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
          body: JSON.stringify(keysBody(alice.id, teamId, 2, newTeamKey(), [alice.id])),
        });
      }
      return real(input, init);
    }) as typeof fetch;
    cleanups.push(() => (globalThis.fetch = real));
    await expect(rotate({ ...opts(alice, teamId), reason: "removed" })).rejects.toThrow(/rotated concurrently.*epoch 2/);
    expect((await fetchRoster(relay.url, teamId, session(alice))).epoch).toBe(2);
  }, 30_000);
});
