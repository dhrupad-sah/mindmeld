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
  [alice.deviceId, { uid: 101, login: "alice", signPub: alice.signPub }],
  [bob.deviceId, { uid: 102, login: "bob", signPub: bob.signPub }],
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

  it("frame round trip returns the sender's id and login", () => {
    const teamKey = new Uint8Array(randomBytes(32));
    const f = sealFrame(3, teamKey, alice, '{"hello":"world"}');
    expect(f.e).toBe(3);
    expect(f.dev).toBe(alice.deviceId);
    expect(openFrame(f, new Map([[3, teamKey]]), roster)).toEqual({ uid: 101, login: "alice", payload: '{"hello":"world"}' });
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

  it("rejects a dev that is not exactly 16 lowercase hex, even if the roster has it", () => {
    const teamKey = new Uint8Array(randomBytes(32));
    const keys = new Map([[1, teamKey]]);
    for (const dev of ["ABCDEF0123456789", "abc", "0123456789abcdef0", "zzzzzzzzzzzzzzzz", "0123456789abcde|"]) {
      // A roster entry under the odd id, and a frame correctly signed and sealed for it.
      const odd = { ...alice, deviceId: dev };
      const f = sealFrame(1, teamKey, odd, "hi");
      const r = new Map([[dev, { uid: 101, login: "alice", signPub: alice.signPub }]]);
      expect(openFrame(f, keys, r), dev).toBeNull();
    }
    // Control: the same construction with a well-formed id opens.
    expect(openFrame(sealFrame(1, teamKey, alice, "hi"), keys, roster)).not.toBeNull();
  });

  it("uses strict Ed25519: a small-order key with a universal signature is refused", () => {
    const teamKey = new Uint8Array(randomBytes(32));
    const f = sealFrame(1, teamKey, alice, "hi");
    // A = identity point, R = identity, S = 0 verifies for every message under ZIP-215, never under RFC 8032.
    const identity = "01" + "00".repeat(31);
    const universal = identity + "00".repeat(32);
    const weak = new Map([[alice.deviceId, { uid: 101, login: "alice", signPub: identity }]]);
    expect(openFrame({ ...f, sig: universal }, new Map([[1, teamKey]]), weak)).toBeNull();
  });

  it("rejects unknown epoch", () => {
    const teamKey = new Uint8Array(randomBytes(32));
    const f = sealFrame(1, teamKey, alice, "hi");
    expect(openFrame(f, new Map([[2, teamKey]]), roster)).toBeNull();
    // Relabelling the epoch breaks the signature even when the receiver holds that epoch's key.
    expect(openFrame({ ...f, e: 2 }, new Map([[1, teamKey], [2, teamKey]]), roster)).toBeNull();
  });
});
