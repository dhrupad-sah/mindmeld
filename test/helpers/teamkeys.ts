import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { DeviceIdentity } from "../../src/identity.js";
import { epochCommit, newTeamKey, type Recipient, signedWrap, wrapSig } from "../../src/teamkeys.js";

export { epochCommit, newTeamKey, type Recipient, signedWrap, wrapSig };

/** A PUT /keys body from `signer` wrapping `teamKey` for every recipient, with a commit when `rotate`. */
export function keysBody(signer: DeviceIdentity, teamId: string, epoch: number, teamKey: Uint8Array, to: Recipient[], rotate = true) {
  const wrapped = Object.fromEntries(to.map((r) => [r.deviceId, signedWrap(signer, teamId, epoch, r, teamKey)]));
  return rotate ? { epoch, wrapped, commit: epochCommit(signer, teamId, epoch, teamKey) } : { epoch, wrapped };
}

/** True if `sig` is `signPub`'s signature on that wrap. */
export const verifyWrapSig = (signPub: string, teamId: string, epoch: number, recipientId: string, sealed: string, sig: string) =>
  ed25519.verify(hexToBytes(sig), new TextEncoder().encode(`mm-wrap|v1|${teamId}|${epoch}|${recipientId}|${sealed}`), hexToBytes(signPub));
