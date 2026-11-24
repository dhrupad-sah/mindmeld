import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { homeDir } from "../config.js";
import type { DeviceIdentity } from "../identity.js";

/** A mindmeld relay session. `expiresAt` is unix time in seconds (same unit as the token's `exp`). */
export interface Session {
  login: string;
  token: string;
  expiresAt: number;
}

const sessionPath = () => join(homeDir(), "session.json");

function isSession(v: unknown): v is Session {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.login === "string" && typeof s.token === "string" && typeof s.expiresAt === "number";
}

function saveSession(s: Session): void {
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const path = sessionPath();
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Domain prefix for the device's sign-in proof; nothing else is signed under it. */
const AUTH_PROOF_DOMAIN = "mm-auth|v1|";

async function postJson(url: string, payload?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw new Error(`relay refused sign-in: ${msg}`);
  }
  return body;
}

/**
 * Trade a GitHub token for a mindmeld session at the relay (`relayHttp` is its base URL; ws(s)://
 * is mapped to http(s)://). Proves possession of the device key by signing the relay's challenge
 * as utf8("mm-auth|v1|" + nonce + "|" + deviceId), and registers this device's public keys.
 * Saves the session to `session.json` (mode 600). The GitHub token itself is not stored.
 */
export async function exchange(relayHttp: string, githubToken: string, id: DeviceIdentity): Promise<Session> {
  const base = relayHttp.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
  const ch = await postJson(`${base}/v1/auth/challenge`);
  const nonce = (ch as { nonce?: unknown } | null)?.nonce;
  if (typeof nonce !== "string" || !/^[0-9a-f]+$/.test(nonce)) throw new Error("relay sign-in: unexpected challenge response");
  const proof = bytesToHex(ed25519.sign(new TextEncoder().encode(`${AUTH_PROOF_DOMAIN}${nonce}|${id.deviceId}`), hexToBytes(id.signPriv)));
  const body = await postJson(`${base}/v1/auth/github`, {
    githubToken,
    device: { deviceId: id.deviceId, signPub: id.signPub, boxPub: id.boxPub },
    nonce,
    proof,
  });
  if (!isSession(body)) throw new Error("relay sign-in: unexpected response");
  const session: Session = { login: body.login, token: body.token, expiresAt: body.expiresAt };
  saveSession(session);
  return session;
}

/** The saved session, or null if there is none, it is unreadable, or it has expired. */
export function loadSession(): Session | null {
  let s: unknown;
  try {
    s = JSON.parse(readFileSync(sessionPath(), "utf8"));
  } catch {
    return null;
  }
  if (!isSession(s) || s.expiresAt <= Date.now() / 1000) return null;
  return { login: s.login, token: s.token, expiresAt: s.expiresAt };
}

/** Login of the saved session even if it has expired (null if there is none), to tell "expired" from "never signed in". */
export function savedSessionLogin(): string | null {
  try {
    const s: unknown = JSON.parse(readFileSync(sessionPath(), "utf8"));
    return isSession(s) ? s.login : null;
  } catch {
    return null;
  }
}
