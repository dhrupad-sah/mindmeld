import { hkdfSync } from "node:crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { open, openBytes, seal, sealBytes } from "./crypto.js";
import type { DeviceIdentity } from "./identity.js";

/** A team message on the wire: epoch, sending device id, AES-GCM ciphertext (base64), Ed25519 signature (hex). */
export interface TeamFrame {
  e: number;
  dev: string;
  d: string;
  sig: string;
}

const SEAL_INFO = "mindmeld/seal/v1";
const DEVICE_ID = /^[0-9a-f]{16}$/;
const SIG_HEX = /^[0-9a-f]{128}$/;
const frameAad = (epoch: number, dev: string) => `mindmeld/frame/v1|${epoch}|${dev}`;
const sigMessage = (epoch: number, dev: string, d: string) => new TextEncoder().encode(`${epoch}|${dev}|${d}`);

function sealKey(shared: Uint8Array, ephPub: Uint8Array, boxPub: Uint8Array): Buffer {
  const salt = Buffer.concat([ephPub, boxPub]);
  return Buffer.from(hkdfSync("sha256", shared, salt, SEAL_INFO, 32));
}

/**
 * Seal bytes to one device's X25519 key (anonymous sender).
 * Fresh ephemeral X25519 keypair; shared = X25519(ephPriv, boxPub);
 * key = HKDF-SHA256(ikm = shared, salt = ephPub(32) ‖ boxPub(32), info = utf8 "mindmeld/seal/v1", L = 32);
 * AES-256-GCM with a random 96-bit nonce, no AAD. Output base64(ephPub ‖ nonce ‖ ct ‖ tag).
 * The key is single-use (fresh ephemeral per call), so nonce reuse cannot occur.
 */
export function sealToDevice(boxPub: string, plaintext: Uint8Array): string {
  const recipient = hexToBytes(boxPub);
  const ephPriv = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const key = sealKey(x25519.getSharedSecret(ephPriv, recipient), ephPub, recipient);
  return Buffer.concat([ephPub, sealBytes(key, plaintext)]).toString("base64");
}

/**
 * Inverse of `sealToDevice` using this device's boxPriv: shared = X25519(boxPriv, ephPub), same HKDF and AES-256-GCM.
 * Returns null on any failure (sealed to another device, tampered, malformed); never throws.
 */
export function openFromDevice(id: DeviceIdentity, sealed: string): Uint8Array | null {
  try {
    const buf = Buffer.from(sealed, "base64");
    if (buf.length < 32 + 28) return null;
    const ephPub = buf.subarray(0, 32);
    const key = sealKey(x25519.getSharedSecret(hexToBytes(id.boxPriv), ephPub), ephPub, hexToBytes(id.boxPub));
    const out = openBytes(key, buf.subarray(32));
    return out === null ? null : new Uint8Array(out);
  } catch {
    return null;
  }
}

/**
 * Encrypt and sign a team frame.
 * d   = base64(nonce ‖ ct ‖ tag) of AES-256-GCM(teamKey, utf8 payload, random 96-bit nonce,
 *       AAD = utf8 "mindmeld/frame/v1|" + epoch + "|" + deviceId);
 * sig = hex Ed25519(signPriv, utf8(epoch + "|" + deviceId + "|" + d)).
 */
export function sealFrame(epoch: number, teamKey: Uint8Array, id: DeviceIdentity, payload: string): TeamFrame {
  const d = seal(teamKey, payload, frameAad(epoch, id.deviceId));
  const sig = Buffer.from(ed25519.sign(sigMessage(epoch, id.deviceId, d), hexToBytes(id.signPriv))).toString("hex");
  return { e: epoch, dev: id.deviceId, d, sig };
}

/**
 * Verify then decrypt a team frame. `f.dev` must be exactly 16 lowercase hex (checked first). The sender is looked up in `roster` by `f.dev`; the Ed25519 signature over
 * utf8(e + "|" + dev + "|" + d) is checked (strict Ed25519, zip215: false) against that entry's signPub BEFORE decryption; then `d` is opened with
 * keys.get(e) and AAD "mindmeld/frame/v1|" + e + "|" + dev. Returns the roster login and payload, or null on any
 * failure (unknown device, bad signature, unknown epoch, decrypt failure, malformed input); never throws.
 */
export function openFrame(
  f: TeamFrame,
  keys: Map<number, Uint8Array>,
  roster: Map<string, { login: string; signPub: string }>,
): { login: string; payload: string } | null {
  try {
    if (!f || typeof f.dev !== "string" || !DEVICE_ID.test(f.dev)) return null;
    if (typeof f.e !== "number" || !Number.isSafeInteger(f.e) || typeof f.d !== "string" || typeof f.sig !== "string" || !SIG_HEX.test(f.sig)) return null;
    const sender = roster.get(f.dev);
    if (!sender) return null;
    if (!ed25519.verify(hexToBytes(f.sig), sigMessage(f.e, f.dev, f.d), hexToBytes(sender.signPub), { zip215: false })) return null;
    const key = keys.get(f.e);
    if (!key) return null;
    const payload = open(key, f.d, frameAad(f.e, f.dev));
    return payload === null ? null : { login: sender.login, payload };
  } catch {
    return null;
  }
}
