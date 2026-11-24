import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { homeDir } from "./config.js";

/** This device's long-lived keys (all hex): ed25519 for signing, x25519 for sealed boxes. */
export interface DeviceIdentity {
  /** First 16 hex chars of sha256(signPub). */
  deviceId: string;
  signPub: string;
  signPriv: string;
  boxPub: string;
  boxPriv: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Read `identity.json` from the mindmeld home, creating it (mode 600) on first use. */
export function loadOrCreateIdentity(): DeviceIdentity {
  const path = join(homeDir(), "identity.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as DeviceIdentity;
  const signPriv = ed25519.utils.randomSecretKey();
  const signPub = ed25519.getPublicKey(signPriv);
  const boxPriv = x25519.utils.randomSecretKey();
  const boxPub = x25519.getPublicKey(boxPriv);
  const id: DeviceIdentity = {
    deviceId: sha256Hex(signPub).slice(0, 16),
    signPub: bytesToHex(signPub),
    signPriv: bytesToHex(signPriv),
    boxPub: bytesToHex(boxPub),
    boxPriv: bytesToHex(boxPriv),
  };
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(id, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return id;
}

/** Human-comparable key fingerprint: first 16 bytes of sha256(signPub) as groups of 4 hex chars. */
export function fingerprint(signPub: string): string {
  const hex = sha256Hex(hexToBytes(signPub)).slice(0, 32);
  return hex.match(/.{4}/g)!.join(" ");
}
