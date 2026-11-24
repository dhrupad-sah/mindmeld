import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import type { Session } from "./auth/session.js";
import type { DeviceIdentity } from "./identity.js";
import { openFromDevice } from "./teamcrypto.js";

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

/** http(s) base URL of the relay, no trailing slash; ws(s):// is mapped to http(s)://. */
export const httpBase = (relay: string) => relay.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");

async function getJson(url: string, session: Session): Promise<unknown> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${session.token}` } });
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
  const r = (await getJson(`${httpBase(relayHttp)}/v1/teams/${teamId}`, session)) as TeamRoster;
  if (!r || !Array.isArray(r.members) || typeof r.epoch !== "number") throw new Error("relay: unexpected roster response");
  return r;
}

/**
 * GET /v1/teams/:id/keys for this device, verified against `roster` (see `verifyTeamKeys`).
 * Throws on an HTTP error; verification failures are reported in `problems`, not thrown.
 */
export async function fetchTeamKeys(relayHttp: string, teamId: string, session: Session, id: DeviceIdentity, roster: TeamRoster): Promise<VerifiedKeys> {
  const body = (await getJson(`${httpBase(relayHttp)}/v1/teams/${teamId}/keys`, session)) as { epoch: number; epochs: Record<string, WrapEntry> };
  return verifyTeamKeys(teamId, id, roster, body);
}
