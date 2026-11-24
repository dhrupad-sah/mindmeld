import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { DeviceIdentity } from "../../src/identity.js";
import { sealToDevice } from "../../src/teamcrypto.js";

/** A device a wrap is addressed to. */
export interface Recipient {
  deviceId: string;
  boxPub: string;
}

/** A fresh random 32-byte team key. */
export const newTeamKey = (): Uint8Array => new Uint8Array(randomBytes(32));

const sign = (signer: DeviceIdentity, msg: string) => bytesToHex(ed25519.sign(new TextEncoder().encode(msg), hexToBytes(signer.signPriv)));

/** Ed25519 signature `signer` puts on a wrap: utf8("mm-wrap|v1|" + teamId + "|" + epoch + "|" + recipient + "|" + sealed). */
export const wrapSig = (signer: DeviceIdentity, teamId: string, epoch: number, recipientId: string, sealed: string) =>
  sign(signer, `mm-wrap|v1|${teamId}|${epoch}|${recipientId}|${sealed}`);

/** Seal `teamKey` to `to` and sign the wrap as `signer`. */
export function signedWrap(signer: DeviceIdentity, teamId: string, epoch: number, to: Recipient, teamKey: Uint8Array) {
  const sealed = sealToDevice(to.boxPub, teamKey);
  return { sealed, sig: wrapSig(signer, teamId, epoch, to.deviceId, sealed) };
}

/** An admin's epoch commitment: hash = hex sha256(teamKey), sig over utf8("mm-epoch|v1|" + teamId + "|" + epoch + "|" + hash). */
export function epochCommit(signer: DeviceIdentity, teamId: string, epoch: number, teamKey: Uint8Array) {
  const hash = createHash("sha256").update(teamKey).digest("hex");
  return { hash, sig: sign(signer, `mm-epoch|v1|${teamId}|${epoch}|${hash}`) };
}

/** A PUT /keys body from `signer` wrapping `teamKey` for every recipient, with a commit when `rotate`. */
export function keysBody(signer: DeviceIdentity, teamId: string, epoch: number, teamKey: Uint8Array, to: Recipient[], rotate = true) {
  const wrapped = Object.fromEntries(to.map((r) => [r.deviceId, signedWrap(signer, teamId, epoch, r, teamKey)]));
  return rotate ? { epoch, wrapped, commit: epochCommit(signer, teamId, epoch, teamKey) } : { epoch, wrapped };
}

/** True if `sig` is `signPub`'s signature on that wrap. */
export const verifyWrapSig = (signPub: string, teamId: string, epoch: number, recipientId: string, sealed: string, sig: string) =>
  ed25519.verify(hexToBytes(sig), new TextEncoder().encode(`mm-wrap|v1|${teamId}|${epoch}|${recipientId}|${sealed}`), hexToBytes(signPub));
