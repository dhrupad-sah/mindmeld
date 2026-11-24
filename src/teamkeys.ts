import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { assertSessionRelay, type Session } from "./auth/session.js";
import { httpBase } from "./config.js";
import type { DeviceIdentity } from "./identity.js";
import { openFromDevice, sealToDevice } from "./teamcrypto.js";

/** One device in a team roster, as GET /v1/teams/:id returns it. */
export interface RosterDevice {
  deviceId: string;
  signPub: string;
  boxPub: string;
  hasKey?: boolean;
}

/** One member of a team roster. */
export interface RosterMember {
  login: string;
  role: "admin" | "member";
  devices: RosterDevice[];
}

/** GET /v1/teams/:id. The relay distributes these public keys; they are trusted as given. */
export interface TeamRoster {
  name: string;
  epoch: number;
  members: RosterMember[];
  invites: string[];
  log: unknown[];
}

/** One wrapped team key for this device, as GET /v1/teams/:id/keys returns it. */
export interface WrapEntry {
  sealed: string;
  by: string;
  sig: string;
  commit: { hash: string; by: string; sig: string } | null;
}

/** Team keys that passed verification, by epoch, plus why any others were dropped. */
export interface VerifiedKeys {
  /** The team's current epoch per the relay (its key may be missing if it failed verification). */
  epoch: number;
  keys: Map<number, Uint8Array>;
  /** One line per dropped epoch, e.g. "team key for epoch 3 failed verification (bad wrap signature)". */
  problems: string[];
}

const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

/** Strict Ed25519 (zip215: false) check of `sig` by `signPub` over utf8(message). */
function verifySig(signPub: string, message: string, sig: string): boolean {
  try {
    if (!HEX128.test(sig)) return false;
    return ed25519.verify(hexToBytes(sig), new TextEncoder().encode(message), hexToBytes(signPub), { zip215: false });
  } catch {
    return false;
  }
}

/** Every device in the roster, keyed by deviceId, with its owner's login and role. */
export function rosterDevices(roster: TeamRoster): Map<string, { login: string; signPub: string; role: "admin" | "member" }> {
  const out = new Map<string, { login: string; signPub: string; role: "admin" | "member" }>();
  for (const m of roster.members) for (const d of m.devices) out.set(d.deviceId, { login: m.login, signPub: d.signPub, role: m.role });
  return out;
}

/** Why `w` (the wrap for epoch `epoch`) must be dropped, or the unwrapped key if it is sound. */
function checkWrap(teamId: string, id: DeviceIdentity, devices: ReturnType<typeof rosterDevices>, epoch: number, w: WrapEntry): Uint8Array | string {
  if (!w || typeof w.sealed !== "string" || typeof w.by !== "string" || typeof w.sig !== "string") return "malformed wrap";
  const writer = HEX16.test(w.by) ? devices.get(w.by) : undefined;
  if (!writer) return "wrap written by a device not in the team";
  if (!verifySig(writer.signPub, `mm-wrap|v1|${teamId}|${epoch}|${id.deviceId}|${w.sealed}`, w.sig)) return "bad wrap signature";
  const c = w.commit;
  if (!c || typeof c.hash !== "string" || typeof c.by !== "string" || typeof c.sig !== "string" || !HEX64.test(c.hash)) return "no epoch commit";
  // Any current roster device: the relay only accepts a rotation from an admin, and checking the role
  // now would break every epoch committed by an admin who has since been demoted.
  const committer = HEX16.test(c.by) ? devices.get(c.by) : undefined;
  if (!committer) return "commit signed by a device not in the team";
  if (!verifySig(committer.signPub, `mm-epoch|v1|${teamId}|${epoch}|${c.hash}`, c.sig)) return "bad commit signature";
  const key = openFromDevice(id, w.sealed);
  if (!key || key.length !== 32) return "cannot unwrap the key for this device";
  if (createHash("sha256").update(key).digest("hex") !== c.hash) return "key does not match the commit hash";
  return key;
}

/**
 * Verify the wrapped keys from GET /v1/teams/:id/keys against `roster`. For each epoch: the wrap's
 * signature (utf8 "mm-wrap|v1|teamId|epoch|myDeviceId|sealed") must be by its writer `by`, a current
 * member device; the commit signature (utf8 "mm-epoch|v1|teamId|epoch|hash") must be by a current
 * roster device (any role; the relay enforces admin-only rotation when it is written); the key must unwrap with this device's box key and hash (hex sha256) to commit.hash.
 * Epochs failing any check are dropped and listed in `problems`. Never throws.
 */
export function verifyTeamKeys(
  teamId: string,
  id: DeviceIdentity,
  roster: TeamRoster,
  body: { epoch: number; epochs: Record<string, WrapEntry> },
): VerifiedKeys {
  const devices = rosterDevices(roster);
  const keys = new Map<number, Uint8Array>();
  const problems: string[] = [];
  const entries = body && typeof body.epochs === "object" && body.epochs ? Object.entries(body.epochs) : [];
  for (const [k, w] of entries.sort(([a], [b]) => Number(a) - Number(b))) {
    const epoch = Number(k);
    if (!Number.isSafeInteger(epoch) || epoch < 1) continue;
    const r = checkWrap(teamId, id, devices, epoch, w);
    if (typeof r === "string") problems.push(`team key for epoch ${epoch} failed verification (${r})`);
    else keys.set(epoch, r);
  }
  return { epoch: typeof body?.epoch === "number" ? body.epoch : 0, keys, problems };
}

export { httpBase };

/** GET `path` on the relay as `session` (only the relay that issued the session). */
async function getJson(relayHttp: string, path: string, session: Session): Promise<unknown> {
  assertSessionRelay(relayHttp, session);
  const res = await fetch(`${httpBase(relayHttp)}${path}`, { headers: { authorization: `Bearer ${session.token}` } });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    const msg = body && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${res.status}`;
    throw Object.assign(new Error(`relay: ${msg}`), { status: res.status });
  }
  return body;
}

/** GET /v1/teams/:id: the team roster (members only). Throws on an HTTP error (`status` on the error). */
export async function fetchRoster(relayHttp: string, teamId: string, session: Session): Promise<TeamRoster> {
  const r = (await getJson(relayHttp, `/v1/teams/${teamId}`, session)) as TeamRoster;
  if (!r || !Array.isArray(r.members) || typeof r.epoch !== "number") throw new Error("relay: unexpected roster response");
  return r;
}

/**
 * GET /v1/teams/:id/keys for this device, verified against `roster` (see `verifyTeamKeys`).
 * Throws on an HTTP error; verification failures are reported in `problems`, not thrown.
 */
export async function fetchTeamKeys(relayHttp: string, teamId: string, session: Session, id: DeviceIdentity, roster: TeamRoster): Promise<VerifiedKeys> {
  const body = (await getJson(relayHttp, `/v1/teams/${teamId}/keys`, session)) as { epoch: number; epochs: Record<string, WrapEntry> };
  return verifyTeamKeys(teamId, id, roster, body);
}

/** Status text for a device that is in the team but has not been given the current team key yet. */
export const WAITING_FOR_KEY = "waiting for a teammate to come online to give this device the team key";

/** Where and as whom to talk to the relay about one team's keys. */
export interface TeamKeyOptions {
  /** Relay base URL (http(s):// or ws(s)://). */
  relayHttp: string;
  teamId: string;
  session: Session;
  id: DeviceIdentity;
}

/** A device a wrap is addressed to. */
export interface Recipient {
  deviceId: string;
  boxPub: string;
}

/** A fresh random 32-byte team key. */
export const newTeamKey = (): Uint8Array => new Uint8Array(randomBytes(32));

const signUtf8 = (signer: DeviceIdentity, msg: string) => bytesToHex(ed25519.sign(new TextEncoder().encode(msg), hexToBytes(signer.signPriv)));

/** Ed25519 signature `signer` puts on a wrap: utf8("mm-wrap|v1|" + teamId + "|" + epoch + "|" + recipient + "|" + sealed). */
export const wrapSig = (signer: DeviceIdentity, teamId: string, epoch: number, recipientId: string, sealed: string): string =>
  signUtf8(signer, `mm-wrap|v1|${teamId}|${epoch}|${recipientId}|${sealed}`);

/** Seal `teamKey` to `to` and sign the wrap as `signer`. */
export function signedWrap(signer: DeviceIdentity, teamId: string, epoch: number, to: Recipient, teamKey: Uint8Array): { sealed: string; sig: string } {
  const sealed = sealToDevice(to.boxPub, teamKey);
  return { sealed, sig: wrapSig(signer, teamId, epoch, to.deviceId, sealed) };
}

/** An epoch commitment: hash = hex sha256(teamKey), sig by `signer` over utf8("mm-epoch|v1|" + teamId + "|" + epoch + "|" + hash). */
export function epochCommit(signer: DeviceIdentity, teamId: string, epoch: number, teamKey: Uint8Array): { hash: string; sig: string } {
  const hash = createHash("sha256").update(teamKey).digest("hex");
  return { hash, sig: signUtf8(signer, `mm-epoch|v1|${teamId}|${epoch}|${hash}`) };
}

/** PUT /v1/teams/:id/keys. Throws on an HTTP error (`status` on the error). */
async function putKeys(o: TeamKeyOptions, body: { epoch: number; wrapped: Record<string, { sealed: string; sig: string }>; commit?: { hash: string; sig: string } }): Promise<void> {
  assertSessionRelay(o.relayHttp, o.session);
  const res = await fetch(`${httpBase(o.relayHttp)}/v1/teams/${o.teamId}/keys`, {
    method: "PUT",
    headers: { authorization: `Bearer ${o.session.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) {
    const msg = json && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : `HTTP ${res.status}`;
    throw Object.assign(new Error(`relay: ${msg}`), { status: res.status });
  }
}

const statusOf = (e: unknown) => (e as { status?: number })?.status;
const roleOf = (roster: TeamRoster, login: string) => roster.members.find((m) => m.login === login.toLowerCase())?.role;
const allDevices = (roster: TeamRoster) => roster.members.flatMap((m) => m.devices);

/** Seal `key` to each of `to`, signed by this device, as a PUT /keys `wrapped` map. */
const wrapsFor = (o: TeamKeyOptions, epoch: number, key: Uint8Array, to: Recipient[]) =>
  Object.fromEntries(to.map((d) => [d.deviceId, signedWrap(o.id, o.teamId, epoch, d, key)]));

/**
 * One key-distribution pass over an already fetched `roster` and this device's `verified` keys:
 * - epoch 0 (no key yet) and the caller is an admin: create the first key (epoch 1, with commit) for every device;
 * - this device holds the verified current key: seal it to every roster device with `hasKey: false`
 *   (a 409 means another member got there first, which is fine);
 * - otherwise this device is waiting for a teammate to deliver its key.
 * `wrote` is true when something was PUT (the caller should refetch). Throws on relay errors other
 * than a delivery 409, including a 400/409 when creating epoch 1 races another device.
 * Never logs key material.
 */
export async function distributeKeys(
  o: TeamKeyOptions,
  roster: TeamRoster,
  verified: VerifiedKeys,
): Promise<{ result: "ok" | { waiting: string }; wrote: boolean }> {
  const waiting = { waiting: WAITING_FOR_KEY };
  if (roster.epoch === 0 && verified.epoch === 0) {
    if (roleOf(roster, o.session.login) !== "admin") return { result: waiting, wrote: false };
    const key = newTeamKey();
    await putKeys(o, { epoch: 1, wrapped: wrapsFor(o, 1, key, allDevices(roster)), commit: epochCommit(o.id, o.teamId, 1, key) });
    return { result: "ok", wrote: true };
  }
  // Keys fetched across a rotation: nothing to deliver from this snapshot; refetch.
  if (verified.epoch !== roster.epoch) return { result: verified.keys.has(verified.epoch) ? "ok" : waiting, wrote: true };
  const key = verified.keys.get(roster.epoch);
  if (!key) return { result: waiting, wrote: false };
  const pending = allDevices(roster).filter((d) => d.hasKey === false && d.deviceId !== o.id.deviceId);
  if (pending.length === 0) return { result: "ok", wrote: false };
  try {
    await putKeys(o, { epoch: roster.epoch, wrapped: wrapsFor(o, roster.epoch, key, pending) });
  } catch (e) {
    // Another member already delivered (or the team rotated meanwhile): the device is covered.
    if (statusOf(e) !== 409) throw e;
  }
  return { result: "ok", wrote: true };
}

/**
 * Make sure the team's current key exists and has reached every device this device can help:
 * creates epoch 1 when the team has no key and the caller is an admin, and seals the current key to
 * roster devices that lack it. Returns `{ waiting }` (WAITING_FOR_KEY) when this device has no
 * usable current key. A 400/409 from a race with another device is retried once after a refetch.
 */
export async function ensureTeamKeys(opts: TeamKeyOptions): Promise<"ok" | { waiting: string }> {
  for (let attempt = 0; ; attempt++) {
    const roster = await fetchRoster(opts.relayHttp, opts.teamId, opts.session);
    const verified = await fetchTeamKeys(opts.relayHttp, opts.teamId, opts.session, opts.id, roster);
    try {
      return (await distributeKeys(opts, roster, verified)).result;
    } catch (e) {
      const s = statusOf(e);
      if (attempt === 0 && (s === 400 || s === 409)) continue;
      throw e;
    }
  }
}

/**
 * Rotate the team key (admin only), e.g. right after removing a member: a fresh 32-byte key sealed
 * to every current roster device (this one included), PUT with a signed commit at epoch + 1.
 * Returns the new epoch. If another rotation landed first (relay 400/409 and the refetched roster is
 * already at that epoch or later), an error naming the team's epoch now is thrown (`status` 409,
 * `epoch`), without retrying. If a device joined between the roster read and the PUT (relay 400
 * "rotation must cover every current device"), the rotation is redone once over a fresh roster.
 */
export async function rotate(opts: TeamKeyOptions & { reason: "removed" }): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const roster = await fetchRoster(opts.relayHttp, opts.teamId, opts.session);
    if (roleOf(roster, opts.session.login) !== "admin") throw Object.assign(new Error("only admins rotate the team key"), { status: 403 });
    const epoch = roster.epoch + 1;
    const key = newTeamKey();
    try {
      await putKeys(opts, { epoch, wrapped: wrapsFor(opts, epoch, key, allDevices(roster)), commit: epochCommit(opts.id, opts.teamId, epoch, key) });
      return epoch;
    } catch (e) {
      // A rotation that landed first shows up as 400 ("commit is only for a rotation", same epoch) or 409.
      const s = statusOf(e);
      if (s !== 400 && s !== 409) throw e;
      const now = (await fetchRoster(opts.relayHttp, opts.teamId, opts.session)).epoch;
      if (now >= epoch) throw Object.assign(new Error(`team key was rotated concurrently; the team is now at epoch ${now}`), { status: 409, epoch: now });
      // A device joined between the roster read and the PUT: rotate once more over the new roster.
      if (s === 400 && /cover every current device/.test((e as Error).message)) {
        if (attempt === 0) continue;
        throw Object.assign(new Error("team key rotation failed: the team's devices kept changing; try again"), { status: 400 });
      }
      throw e;
    }
  }
}
