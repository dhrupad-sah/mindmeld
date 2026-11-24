import { DurableObject } from "cloudflare:workers";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * GitHub sign-in for the relay.
 * - POST /v1/auth/challenge returns { nonce, expiresAt }: a stateless, relay-MACed nonce, valid 5 min.
 * - POST /v1/auth/github { githubToken, device: { deviceId, signPub, boxPub }, nonce, proof } first
 *   checks the nonce and that `proof` is an Ed25519 signature by signPub over
 *   utf8("mm-auth|v1|" + nonce + "|" + deviceId) (proof of possession), then checks the GitHub
 *   token against `${GITHUB_API_BASE}/user`, records the device under that login (Users Durable
 *   Object, one per login) and returns { login, token, expiresAt }. The GitHub token is used once
 *   and never stored.
 * - GET /v1/me with `Authorization: Bearer <token>` returns { login, deviceId }.
 * Token: base64url(JSON {login, deviceId, exp}) + "." + base64url(HMAC-SHA256(TOKEN_SIGNING_KEY, first part)).
 * `exp` and `expiresAt` are unix time in SECONDS.
 */

export interface AuthEnv {
  USERS: DurableObjectNamespace<Users>;
  GITHUB_API_BASE: string;
  TOKEN_SIGNING_KEY: string;
}

/** Session token lifetime, seconds. */
export const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** GitHub's login rules: alphanumerics and single hyphens, up to 39 chars. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const MAX_BODY_BYTES = 16 * 1024;
/** Challenge lifetime, seconds. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;
/** Domain prefixes: the relay's nonce MAC and the device's proof signature each own one. */
const CHALLENGE_DOMAIN = "mm-challenge|v1|";
const AUTH_PROOF_DOMAIN = "mm-auth|v1|";
/** nonce = hex(random 32 bytes) + hex(exp, 8 bytes big-endian) + hex(HMAC 32 bytes). */
const NONCE = /^[0-9a-f]{144}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export interface DeviceRecord {
  deviceId: string;
  signPub: string;
  boxPub: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url decode (no padding); null on anything else. */
function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function signingKey(env: AuthEnv): Promise<CryptoKey> {
  const hex = env.TOKEN_SIGNING_KEY ?? "";
  // Fail closed: no key, or a short one, means no tokens at all.
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(hex)) throw new Error("TOKEN_SIGNING_KEY missing or shorter than 32 bytes");
  return crypto.subtle.importKey("raw", hexToBytes(hex.toLowerCase()), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function challengeMac(randHex: string, expHex: string, env: AuthEnv): Promise<Uint8Array> {
  const msg = new TextEncoder().encode(`${CHALLENGE_DOMAIN}${randHex}|${expHex}`);
  return new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), msg));
}

/** Mint a sign-in challenge. Stateless: the relay recognises it later by its MAC. */
export async function issueChallenge(env: AuthEnv): Promise<{ nonce: string; expiresAt: number }> {
  const exp = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;
  const randHex = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const expHex = exp.toString(16).padStart(16, "0");
  return { nonce: randHex + expHex + toHex(await challengeMac(randHex, expHex, env)), expiresAt: exp };
}

/** True if `nonce` was minted by this relay (constant-time MAC check) and has not expired. */
export async function verifyChallenge(nonce: string, env: AuthEnv): Promise<boolean> {
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return false;
  const randHex = nonce.slice(0, 64);
  const expHex = nonce.slice(64, 80);
  const msg = new TextEncoder().encode(`${CHALLENGE_DOMAIN}${randHex}|${expHex}`);
  const ok = await crypto.subtle.verify("HMAC", await signingKey(env), hexToBytes(nonce.slice(80)), msg);
  if (!ok) return false;
  const exp = parseInt(expHex, 16);
  return Number.isSafeInteger(exp) && exp > Math.floor(Date.now() / 1000);
}

/** Strict Ed25519 (zip215: false) check of the device's proof over its own domain-prefixed message. */
function verifyDeviceProof(dev: DeviceRecord, nonce: string, proof: string): boolean {
  try {
    const msg = new TextEncoder().encode(`${AUTH_PROOF_DOMAIN}${nonce}|${dev.deviceId}`);
    return ed25519.verify(hexToBytes(proof), msg, hexToBytes(dev.signPub), { zip215: false });
  } catch {
    return false;
  }
}

/** Issue a session token for `login` on `deviceId`, valid TOKEN_TTL_SECONDS. */
export async function issueToken(login: string, deviceId: string, env: AuthEnv): Promise<{ token: string; expiresAt: number }> {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify({ login, deviceId, exp })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(env), new TextEncoder().encode(body)));
  return { token: `${body}.${b64urlEncode(sig)}`, expiresAt: exp };
}

/** Check a session token's signature (constant time, via WebCrypto verify), shape and expiry. */
export async function verifyToken(token: string, env: AuthEnv): Promise<{ login: string; deviceId: string } | null> {
  if (typeof token !== "string" || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sigText] = parts;
  const sig = b64urlDecode(sigText);
  if (!sig || sig.length !== 32 || !body) return null;
  const ok = await crypto.subtle.verify("HMAC", await signingKey(env), sig, new TextEncoder().encode(body));
  if (!ok) return null;
  const raw = b64urlDecode(body);
  if (!raw) return null;
  let p: unknown;
  try {
    p = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  const { login, deviceId, exp } = p as Record<string, unknown>;
  if (typeof login !== "string" || !GITHUB_LOGIN.test(login)) return null;
  if (typeof deviceId !== "string" || !HEX16.test(deviceId)) return null;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
  return { login, deviceId };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parse and validate the device in a sign-in body; deviceId must be the first 16 hex of sha256(signPub). */
async function parseDevice(v: unknown): Promise<DeviceRecord | null> {
  if (!v || typeof v !== "object") return null;
  const { deviceId, signPub, boxPub } = v as Record<string, unknown>;
  if (typeof deviceId !== "string" || !HEX16.test(deviceId)) return null;
  if (typeof signPub !== "string" || !HEX64.test(signPub)) return null;
  if (typeof boxPub !== "string" || !HEX64.test(boxPub)) return null;
  if ((await sha256Hex(hexToBytes(signPub))).slice(0, 16) !== deviceId) return null;
  return { deviceId, signPub, boxPub };
}

/** Ask GitHub who owns this token. "denied" on 401/403, "error" when GitHub misbehaves. */
async function githubLogin(githubToken: string, env: AuthEnv): Promise<string | "denied" | "error"> {
  let res: Response;
  try {
    res = await fetch(`${env.GITHUB_API_BASE}/user`, {
      headers: {
        authorization: `Bearer ${githubToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "mindmeld-relay",
      },
    });
  } catch {
    return "error";
  }
  if (res.status === 401 || res.status === 403) return "denied";
  if (!res.ok) return "error";
  try {
    const { login } = (await res.json()) as { login?: unknown };
    return typeof login === "string" && GITHUB_LOGIN.test(login) ? login : "error";
  } catch {
    return "error";
  }
}

async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function signIn(req: Request, env: AuthEnv): Promise<Response> {
  const body = await readJsonBody(req);
  if (!body || typeof body !== "object") return json(400, { error: "bad request" });
  const { githubToken, device, nonce, proof } = body as Record<string, unknown>;
  if (typeof githubToken !== "string" || !githubToken || githubToken.length > 255 || /\s/.test(githubToken)) {
    return json(400, { error: "bad request" });
  }
  const dev = await parseDevice(device);
  if (!dev) return json(400, { error: "bad device" });
  if (typeof nonce !== "string" || !NONCE.test(nonce) || typeof proof !== "string" || !HEX128.test(proof)) {
    return json(400, { error: "missing or malformed challenge proof" });
  }
  // Proof of possession before anything is recorded or GitHub is even asked.
  if (!(await verifyChallenge(nonce, env))) return json(401, { error: "challenge expired or invalid" });
  if (!verifyDeviceProof(dev, nonce, proof)) return json(401, { error: "device proof failed" });
  const login = await githubLogin(githubToken, env);
  if (login === "denied") return json(401, { error: "github sign-in failed" });
  if (login === "error") return json(502, { error: "github unavailable" });
  // GitHub logins are case-insensitive: one Users object per lowercased login.
  const users = env.USERS.get(env.USERS.idFromName(login.toLowerCase()));
  const added = await users.addDevice(login, dev);
  if (!added) return json(409, { error: "device id already registered with different keys" });
  const { token, expiresAt } = await issueToken(login, dev.deviceId, env);
  return json(200, { login, token, expiresAt });
}

async function whoami(req: Request, env: AuthEnv): Promise<Response> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  const who = m ? await verifyToken(m[1], env) : null;
  if (!who) return json(401, { error: "sign-in required" });
  return json(200, who);
}

/** Handle /v1/auth/* and /v1/me; null for any other path. */
export async function handleAuth(req: Request, env: AuthEnv, pathname: string): Promise<Response | null> {
  if (pathname === "/v1/auth/challenge") {
    return req.method === "POST" ? json(200, await issueChallenge(env)) : json(405, { error: "method not allowed" });
  }
  if (pathname === "/v1/auth/github") return req.method === "POST" ? signIn(req, env) : json(405, { error: "method not allowed" });
  if (pathname === "/v1/me") return req.method === "GET" ? whoami(req, env) : json(405, { error: "method not allowed" });
  return null;
}

/** One per GitHub login (keyed by the lowercased login): the devices that signed in as it. */
export class Users extends DurableObject<AuthEnv> {
  constructor(ctx: DurableObjectState, env: AuthEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, sign_pub TEXT NOT NULL, box_pub TEXT NOT NULL, added_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  /** Record (or refresh) a device. False if that deviceId is already here with different keys. */
  addDevice(login: string, d: DeviceRecord): boolean {
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const existing = sql.exec<{ sign_pub: string; box_pub: string }>("SELECT sign_pub, box_pub FROM devices WHERE device_id = ?", d.deviceId).toArray();
    if (existing.length) {
      if (existing[0].sign_pub !== d.signPub || existing[0].box_pub !== d.boxPub) return false;
      sql.exec("UPDATE devices SET last_seen = ? WHERE device_id = ?", now, d.deviceId);
    } else {
      sql.exec("INSERT INTO devices (device_id, sign_pub, box_pub, added_at, last_seen) VALUES (?, ?, ?, ?, ?)", d.deviceId, d.signPub, d.boxPub, now, now);
    }
    sql.exec("INSERT INTO meta (k, v) VALUES ('login', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", login);
    return true;
  }

  /** Devices recorded for this login. */
  devices(): DeviceRecord[] {
    return this.ctx.storage.sql
      .exec<{ device_id: string; sign_pub: string; box_pub: string }>("SELECT device_id, sign_pub, box_pub FROM devices ORDER BY added_at")
      .toArray()
      .map((r) => ({ deviceId: r.device_id, signPub: r.sign_pub, boxPub: r.box_pub }));
  }
}
