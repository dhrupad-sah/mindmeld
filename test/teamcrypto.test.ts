import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DeviceIdentity } from "../src/identity.js";
import { openFrame, openFromDevice, sealFrame, sealToDevice } from "../src/teamcrypto.js";

function makeIdentity(): DeviceIdentity {
  const signPriv = ed25519.utils.randomSecretKey();
  const signPub = ed25519.getPublicKey(signPriv);
  const boxPriv = x25519.utils.randomSecretKey();
  return {
    deviceId: createHash("sha256").update(signPub).digest("hex").slice(0, 16),
    signPub: bytesToHex(signPub),
    signPriv: bytesToHex(signPriv),
    boxPub: bytesToHex(x25519.getPublicKey(boxPriv)),
    boxPriv: bytesToHex(boxPriv),
  };
}

const alice = makeIdentity();
const bob = makeIdentity();
const roster = new Map([
  [alice.deviceId, { login: "alice", signPub: alice.signPub }],
  [bob.deviceId, { login: "bob", signPub: bob.signPub }],
]);

describe("teamcrypto", () => {
  it("seal/open round trip", () => {
    const key = new Uint8Array(randomBytes(32));
    const sealed = sealToDevice(bob.boxPub, key);
    // ephPub(32) + nonce(12) + ct(32) + tag(16)
    expect(Buffer.from(sealed, "base64").length).toBe(92);
    expect(sealToDevice(bob.boxPub, key)).not.toBe(sealed);
    const opened = openFromDevice(bob, sealed);
    expect(opened).not.toBeNull();
    expect(Buffer.from(opened!).equals(Buffer.from(key))).toBe(true);
  });

  it("open fails for a different device", () => {
    const sealed = sealToDevice(bob.boxPub, new Uint8Array(randomBytes(32)));
    expect(openFromDevice(alice, sealed)).toBeNull();
    expect(openFromDevice(bob, "not base64 at all!!")).toBeNull();
    expect(openFromDevice(bob, "")).toBeNull();
  });

  it("frame round trip returns sender login", () => {
    const teamKey = new Uint8Array(randomBytes(32));
    const f = sealFrame(3, teamKey, alice, '{"hello":"world"}');
    expect(f.e).toBe(3);
    expect(f.dev).toBe(alice.deviceId);
    expect(openFrame(f, new Map([[3, teamKey]]), roster)).toEqual({ login: "alice", payload: '{"hello":"world"}' });
  });

  it("rejects forged sender", () => {
    const teamKey = new Uint8Array(randomBytes(32));
    const f = sealFrame(1, teamKey, alice, "hi");
    expect(openFrame({ ...f, dev: bob.deviceId }, new Map([[1, teamKey]]), roster)).toBeNull();
    expect(openFrame({ ...f, dev: "0000000000000000" }, new Map([[1, teamKey]]), roster)).toBeNull();
  });

  it("rejects tampered d", () => {
    const teamKey = new Uint8Array(randomBytes(32));
    const f = sealFrame(1, teamKey, alice, "hi");
    const raw = Buffer.from(f.d, "base64");
    raw[raw.length - 1] ^= 1;
    const keys = new Map([[1, teamKey]]);
    expect(openFrame({ ...f, d: raw.toString("base64") }, keys, roster)).toBeNull();
    expect(openFrame({ ...f, sig: "zz" }, keys, roster)).toBeNull();
  });

  it("rejects unknown epoch", () => {
    const teamKey = new Uint8Array(randomBytes(32));
    const f = sealFrame(1, teamKey, alice, "hi");
    expect(openFrame(f, new Map([[2, teamKey]]), roster)).toBeNull();
    // Relabelling the epoch breaks the signature even when the receiver holds that epoch's key.
    expect(openFrame({ ...f, e: 2 }, new Map([[1, teamKey], [2, teamKey]]), roster)).toBeNull();
  });
});
