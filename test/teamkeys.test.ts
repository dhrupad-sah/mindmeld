import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateIdentity, type DeviceIdentity } from "../src/identity.js";
import { type TeamRoster, verifyTeamKeys, type WrapEntry } from "../src/teamkeys.js";
import { epochCommit, newTeamKey, signedWrap } from "./helpers/teamkeys.js";

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
    const commitByMember = entry(3, k, admin, member);
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
      epochs: { 1: badWrapSig, 2: byOutsider, 3: commitByMember, 4: badCommitSig, 5: hashMismatch, 6: noCommit, 7: notForMe, 8: replayedEpoch, 9: entry(9, k) },
    });
    expect([...out.keys.keys()]).toEqual([9]);
    expect(out.problems).toHaveLength(8);
    for (const [i, why] of ["signature", "not in the team", "admin", "signature", "hash", "commit", "unwrap", "signature"].entries()) {
      expect(out.problems[i]).toMatch(new RegExp(`^team key for epoch ${i + 1} failed verification \\(.*${why}`));
    }
  });

  it("rejects a wrap signed for another team", () => {
    const k = newTeamKey();
    const w = signedWrap(admin, "fedcba9876543210", 1, me, k);
    const out = verifyTeamKeys(TEAM, me, roster, { epoch: 1, epochs: { 1: { ...entry(1, k), sealed: w.sealed, sig: w.sig } } });
    expect(out.keys.size).toBe(0);
    expect(out.problems[0]).toMatch(/epoch 1 failed verification/);
  });
});
