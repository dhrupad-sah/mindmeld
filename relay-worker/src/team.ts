import { DurableObject } from "cloudflare:workers";
import { ed25519 } from "@noble/curves/ed25519.js";
import { invitesByLogin, usersByUid, verifyToken, type AuthEnv, type DeviceRecord, type TeamIndexEntry, type TeamIndexRole } from "./auth.js";
import { CLOSE_NO_KEY, CLOSE_NO_TEAM, CLOSE_REMOVED, socketCaller, TeamSockets, upgradeRequest, type Admission } from "./teamsocket.js";

/**
 * Teams on the relay: roster, invites, roles, device records, wrapped team keys per epoch and an
 * append-only membership log. One Team Durable Object per team (keyed by its 16-hex teamId).
 * Every route needs `Authorization: Bearer <token>` (401 without a valid one).
 * - POST /v1/teams { name } -> { teamId }; the caller becomes admin.
 * - GET /v1/teams -> [{ teamId, name, role | "invited" }]: memberships from the caller's account
 *   index plus pending invites addressed to the caller's current login.
 * - GET /v1/teams/:id -> { name, epoch, members: [{ uid, login, role, devices }], invites, log } (members only).
 * - POST /v1/teams/:id/invites { login } (admin); POST /v1/teams/:id/accept (invited caller).
 *   Invites name a login (what admins type); accepting binds the membership to the accepting
 *   caller's GitHub id, so only the account holding that login at accept time gets in.
 * - POST /v1/teams/:id/devices (member): add the caller's current device.
 * - PUT /v1/teams/:id/keys { epoch, wrapped: { [deviceId]: { sealed, sig } }, commit?: { hash, sig } } (member).
 *   Each wrap's `sig` is Ed25519 by the caller's device over
 *   utf8("mm-wrap|v1|" + teamId + "|" + epoch + "|" + recipientDeviceId + "|" + sealed). A rotation
 *   (epoch = current + 1, admin only) needs `commit`: hash = hex sha256 of the raw 32-byte team key,
 *   sig = Ed25519 by the admin's device over utf8("mm-epoch|v1|" + teamId + "|" + epoch + "|" + hash).
 *   Any bad signature rejects the whole request (400). The relay stores who wrote each wrap.
 * - GET /v1/teams/:id/keys (member) -> { epoch, wrapped: Wrap | null, epochs: { [n]: Wrap } } for the
 *   caller's device (current plus up to 2 previous epochs), where
 *   Wrap = { sealed, by, sig, commit: { hash, by, sig } | null } and `by` is the writer's deviceId.
 * - DELETE /v1/teams/:id/members/:login (admin) -> { needsRotation: true }.
 * - POST /v1/teams/:id/roles { login, role } (admin).
 * - GET /v1/teams/:id/ws (WebSocket upgrade): the team socket, see src/teamsocket.ts.
 * Errors: 404 for an unknown team (or malformed teamId), 403 for a non-member or a role that is not
 * enough, on every route. TeamIds are 64 random bits, so 403 only confirms an id the caller already has.
 * Members, devices and keys are keyed by GitHub's numeric user id (`uid`), which can't be renamed or
 * re-registered; the login is kept for display (refreshed whenever the member uses the team or signs
 * in) and routes that take a login resolve it to the member that currently shows it.
 * Logins are lowercased everywhere. The caller's device keys come from its Users record, never the body.
 * Wrapped keys are opaque sealed blobs; they are only ever returned to the device they are sealed to.
 * The Users index behind GET /v1/teams is updated after each Team change; if they ever disagree,
 * the Team object wins (it alone decides access).
 */

export interface TeamEnv extends AuthEnv {
  TEAMS: DurableObjectNamespace<Team>;
  LATEST_VERSION: string;
  MIN_VERSION: string;
}

type Role = "admin" | "member";

/** The authenticated caller: lowercased login and its current device, from the Users record. */
export interface Caller {
  uid: number;
  login: string;
  device: DeviceRecord;
}

/** What a Team operation hands back to the Worker: the HTTP reply, plus Users index updates to apply. */
export interface TeamResult {
  status: number;
  body: unknown;
  name?: string;
  /** `uid`: an account's membership index; `login`: the pending-invite index for that login. */
  index?: ({ uid: number; role: TeamIndexRole | null } | { login: string; role: TeamIndexRole | null })[];
}

const HEX16 = /^[0-9a-f]{16}$/;
const LOGIN = /^[a-z0-9-]{1,39}$/;
const SEALED = /^[A-Za-z0-9+/]{1,2048}={0,2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
/** Signature domains: a wrap written by a device, and an admin's commitment to an epoch's key. */
const WRAP_DOMAIN = "mm-wrap|v1|";
const EPOCH_DOMAIN = "mm-epoch|v1|";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_WRAPS = 512;
/** Wrapped keys kept per device: the current epoch plus this many before it. */
const PREVIOUS_EPOCHS = 2;

const ok = (body: unknown = {}): TeamResult => ({ status: 200, body });
const AMBIGUOUS = "two members are shown with that login (one renamed their GitHub account); ask them to sign in to mindmeld again";
const fail = (status: number, error: string): TeamResult => ({ status, body: { error } });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const parseLogin = (v: unknown): string | null => (typeof v === "string" && LOGIN.test(v.toLowerCase()) ? v.toLowerCase() : null);

/** A wrapped team key as sent by its writer: the sealed blob and the writer's signature. */
export interface SignedWrap {
  sealed: string;
  sig: string;
}

/** An admin's signed commitment to an epoch's team key (hex sha256 of the raw key). */
export interface EpochCommit {
  hash: string;
  sig: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseWrapped(v: unknown): Record<string, SignedWrap> | null {
  if (!isObj(v)) return null;
  const entries = Object.entries(v);
  if (entries.length === 0 || entries.length > MAX_WRAPS) return null;
  const out: Record<string, SignedWrap> = {};
  for (const [id, w] of entries) {
    if (!HEX16.test(id) || !isObj(w)) return null;
    if (typeof w.sealed !== "string" || !SEALED.test(w.sealed) || typeof w.sig !== "string" || !HEX128.test(w.sig)) return null;
    out[id] = { sealed: w.sealed, sig: w.sig };
  }
  return out;
}

function parseCommit(v: unknown): EpochCommit | null {
  if (!isObj(v) || typeof v.hash !== "string" || !HEX64.test(v.hash) || typeof v.sig !== "string" || !HEX128.test(v.sig)) return null;
  return { hash: v.hash, sig: v.sig };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Strict Ed25519 check (zip215: false) of `sig` by `signPub` over utf8(message). */
function verifySig(signPub: string, message: string, sig: string): boolean {
  try {
    return ed25519.verify(hexToBytes(sig), new TextEncoder().encode(message), hexToBytes(signPub), { zip215: false });
  } catch {
    return false;
  }
}

/** Verify the bearer token and load the caller's device from its Users record (null: 401). */
async function authenticate(req: Request, env: TeamEnv): Promise<Caller | null> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  const who = m ? await verifyToken(m[1], env) : null;
  if (!who) return null;
  const devices = await usersByUid(env, who.uid).devices();
  const device = devices.find((d) => d.deviceId === who.deviceId);
  return device ? { uid: who.uid, login: who.login.toLowerCase(), device } : null;
}

const TEAM_PATH = /^\/v1\/teams\/([0-9a-f]{16})(?:\/(invites|accept|devices|keys|roles|ws|members\/([^/]+)))?$/;

/** Handle /v1/teams and /v1/teams/*; null for any other path. */
export async function handleTeams(req: Request, env: TeamEnv, pathname: string): Promise<Response | null> {
  if (pathname !== "/v1/teams" && !pathname.startsWith("/v1/teams/")) return null;
  const caller = await authenticate(req, env);
  if (!caller) return json(401, { error: "sign-in required" });

  let teamId: string;
  let r: TeamResult;
  if (pathname === "/v1/teams") {
    if (req.method === "GET") {
      const mine = await usersByUid(env, caller.uid).teams();
      const invited = (await invitesByLogin(env, caller.login).teams()).filter((t) => !mine.some((m) => m.teamId === t.teamId));
      return json(200, [...mine, ...invited] satisfies TeamIndexEntry[]);
    }
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    const body = await readBody(req);
    const name = body?.name;
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 60) return json(400, { error: "name must be 1-60 characters" });
    // A 64-bit id collision is vanishingly rare; retry a couple of times, then give up.
    let tries = 0;
    do {
      teamId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
      r = await env.TEAMS.get(env.TEAMS.idFromName(teamId)).create(name, caller);
    } while (r.status === 409 && ++tries < 3);
    if (r.status === 200) r = { ...r, body: { teamId } };
  } else {
    const m = TEAM_PATH.exec(pathname);
    if (!m) return json(404, { error: "not found" });
    teamId = m[1];
    const team = env.TEAMS.get(env.TEAMS.idFromName(teamId));
    const route = `${req.method} ${m[3] !== undefined ? "members" : (m[2] ?? "")}`;
    const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : null;
    switch (route) {
      case "GET ":
        r = await team.roster(caller);
        break;
      case "POST invites": {
        const login = parseLogin(body?.login);
        if (!login) return json(400, { error: "bad login" });
        r = await team.invite(caller, login);
        break;
      }
      case "POST accept":
        r = await team.accept(caller);
        break;
      case "POST devices":
        r = await team.addDevice(caller);
        break;
      case "PUT keys": {
        const epoch = body?.epoch;
        const wrapped = parseWrapped(body?.wrapped);
        const commit = body?.commit === undefined ? undefined : parseCommit(body.commit);
        if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) return json(400, { error: "epoch must be an integer >= 1" });
        if (!wrapped) return json(400, { error: "wrapped must map 16-hex device ids to { sealed, sig }" });
        if (commit === null) return json(400, { error: "commit must be { hash, sig }" });
        // Every signature is by the caller's own device (keys from its Users record), checked before anything is stored.
        const pub = caller.device.signPub;
        for (const [id, w] of Object.entries(wrapped)) {
          if (!verifySig(pub, `${WRAP_DOMAIN}${teamId}|${epoch}|${id}|${w.sealed}`, w.sig)) return json(400, { error: "bad wrap signature" });
        }
        if (commit && !verifySig(pub, `${EPOCH_DOMAIN}${teamId}|${epoch}|${commit.hash}`, commit.sig)) return json(400, { error: "bad epoch commit signature" });
        r = await team.putKeys(caller, epoch, wrapped, commit);
        break;
      }
      case "GET keys":
        r = await team.getKeys(caller);
        break;
      case "GET ws":
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json(426, { error: "expected a websocket" });
        return team.fetch(upgradeRequest(caller.uid, caller.login, caller.device.deviceId));
      case "DELETE members": {
        let raw: string;
        try {
          raw = decodeURIComponent(m[3]);
        } catch {
          return json(400, { error: "bad login" });
        }
        const login = parseLogin(raw);
        if (!login) return json(400, { error: "bad login" });
        r = await team.remove(caller, login);
        break;
      }
      case "POST roles": {
        const login = parseLogin(body?.login);
        const role = body?.role;
        if (!login || (role !== "admin" && role !== "member")) return json(400, { error: "need login and role admin|member" });
        r = await team.setRole(caller, login, role);
        break;
      }
      default:
        return json(405, { error: "method not allowed" });
    }
  }
  // Best effort: the Team object has already changed and stays the source of truth.
  for (const u of r.index ?? []) {
    try {
      const stub = "uid" in u ? usersByUid(env, u.uid) : invitesByLogin(env, u.login);
      await stub.setTeam(teamId, r.name ?? "", u.role);
    } catch {}
  }
  return json(r.status, r.body);
}

/** One team: its roster, devices, wrapped keys and membership log, in Durable Object SQLite. */
export class Team extends DurableObject<TeamEnv> {
  private readonly sockets: TeamSockets;

  constructor(ctx: DurableObjectState, env: TeamEnv) {
    super(ctx, env);
    this.sockets = new TeamSockets(ctx, () => ({ latest: env.LATEST_VERSION, minimum: env.MIN_VERSION }));
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, epoch INTEGER NOT NULL)");
    // uid = GitHub's numeric user id (the identity); login = the current login, for display.
    sql.exec("CREATE TABLE IF NOT EXISTS members (uid INTEGER PRIMARY KEY, login TEXT NOT NULL, role TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS devices (deviceId TEXT PRIMARY KEY, uid INTEGER NOT NULL, signPub TEXT NOT NULL, boxPub TEXT NOT NULL)");
    // Invites name a login (what the admin typed); they bind to a uid when accepted.
    // by = deviceId that wrote the wrap (or the commit); sig = its signature, see the module notes.
    sql.exec("CREATE TABLE IF NOT EXISTS keys (epoch INTEGER NOT NULL, deviceId TEXT NOT NULL, sealed TEXT NOT NULL, by TEXT NOT NULL, sig TEXT NOT NULL, PRIMARY KEY (epoch, deviceId))");
    sql.exec("CREATE TABLE IF NOT EXISTS commits (epoch INTEGER PRIMARY KEY, hash TEXT NOT NULL, by TEXT NOT NULL, sig TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS invites (login TEXT PRIMARY KEY)");
    sql.exec("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL, event TEXT NOT NULL, subject TEXT NOT NULL)");
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  private meta(): { name: string; epoch: number } | null {
    return this.sql.exec<{ name: string; epoch: number }>("SELECT name, epoch FROM meta WHERE id = 1").toArray()[0] ?? null;
  }

  private roleOf(uid: number): Role | null {
    return (this.sql.exec<{ role: Role }>("SELECT role FROM members WHERE uid = ?", uid).toArray()[0]?.role) ?? null;
  }

  /**
   * The member currently shown as `login`: their uid and role, null if none, or "ambiguous" when two
   * members show it (one renamed away and hasn't been seen since, and another took the login).
   */
  private memberByLogin(login: string): { uid: number; role: Role } | null | "ambiguous" {
    const rows = this.sql.exec<{ uid: number; role: Role }>("SELECT uid, role FROM members WHERE login = ?", login).toArray();
    return rows.length > 1 ? "ambiguous" : (rows[0] ?? null);
  }

  /** Show `login` for member `uid` from now on (they signed in with a renamed account). True if it changed. */
  private noteLogin(uid: number, login: string): boolean {
    const row = this.sql.exec<{ login: string }>("SELECT login FROM members WHERE uid = ?", uid).toArray()[0];
    if (!row || row.login === login) return false;
    this.sql.exec("UPDATE members SET login = ? WHERE uid = ?", login, uid);
    return true;
  }

  /** Called at sign-in: refresh the login a member is shown as. */
  refreshLogin(uid: number, login: string): void {
    if (this.meta() && this.noteLogin(uid, login)) this.changed();
  }

  private admins(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE role = 'admin'").one().n;
  }

  private log(by: string, event: string, subject: string): void {
    this.sql.exec("INSERT INTO log (at, by, event, subject) VALUES (?, ?, ?, ?)", Date.now(), by, event, subject);
  }

  /** Device owner's uid, or null if the device is not in this team. */
  private deviceOwner(deviceId: string): number | null {
    return this.sql.exec<{ uid: number }>("SELECT uid FROM devices WHERE deviceId = ?", deviceId).toArray()[0]?.uid ?? null;
  }

  private insertDevice(uid: number, d: DeviceRecord): void {
    this.sql.exec("INSERT INTO devices (deviceId, uid, signPub, boxPub) VALUES (?, ?, ?, ?)", d.deviceId, uid, d.signPub, d.boxPub);
  }

  /**
   * Shared guard: 404 for an unknown team, 403 unless the caller is a member (and an admin when
   * `admin` is set). Returns the team's meta and the caller's role when allowed.
   */
  private guard(caller: Caller, admin = false): TeamResult | { name: string; epoch: number; role: Role } {
    const meta = this.meta();
    if (!meta) return fail(404, "no such team");
    const role = this.roleOf(caller.uid);
    if (!role) return fail(403, "not a member of this team");
    if (admin && role !== "admin") return fail(403, "admins only");
    if (this.noteLogin(caller.uid, caller.login)) this.changed();
    return { ...meta, role };
  }

  private hasKey(deviceId: string, epoch: number): boolean {
    return this.sql.exec("SELECT 1 FROM keys WHERE deviceId = ? AND epoch = ?", deviceId, epoch).toArray().length > 0;
  }

  /** Tell team sockets the roster changed; sockets of devices without the current key are closed. */
  private changed(): void {
    const epoch = this.meta()?.epoch ?? 0;
    this.sockets.rosterChanged((id) => this.hasKey(id, epoch));
  }

  /** Team socket upgrade, reached only from handleTeams with the verified caller in internal headers. */
  async fetch(req: Request): Promise<Response> {
    const { uid, login, deviceId } = socketCaller(req);
    const meta = this.meta();
    const owner = this.deviceOwner(deviceId);
    let admit: Admission;
    if (!meta) admit = { ok: false, code: CLOSE_NO_TEAM, reason: "no such team" };
    else if (!this.roleOf(uid) || (owner !== null && owner !== uid)) admit = { ok: false, code: CLOSE_REMOVED, reason: "not a member of this team" };
    else if (owner === null || !this.hasKey(deviceId, meta.epoch)) admit = { ok: false, code: CLOSE_NO_KEY, reason: "no team key yet" };
    else admit = { ok: true, epoch: meta.epoch };
    return this.sockets.accept(uid, login, deviceId, admit);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> { this.sockets.message(ws, message); }
  async webSocketClose(ws: WebSocket): Promise<void> { this.sockets.closed(ws); }
  async webSocketError(ws: WebSocket): Promise<void> { this.sockets.closed(ws); }

  /** Set up a new team with `caller` as its admin. 409 if this teamId is already taken. */
  create(name: string, caller: Caller): TeamResult {
    if (this.meta()) return fail(409, "team id taken");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO meta (id, name, epoch) VALUES (1, ?, 0)", name);
      this.sql.exec("INSERT INTO members (uid, login, role) VALUES (?, ?, 'admin')", caller.uid, caller.login);
      this.insertDevice(caller.uid, caller.device);
      this.log(caller.login, "created", caller.login);
    });
    return { ...ok(), name, index: [{ uid: caller.uid, role: "admin" }] };
  }

  /** The full roster (members only). `hasKey` is whether the device has a wrap at the current epoch. */
  roster(caller: Caller): TeamResult {
    const g = this.guard(caller);
    if ("status" in g) return g;
    const devices = this.sql
      .exec<{ deviceId: string; uid: number; signPub: string; boxPub: string; hasKey: number }>(
        "SELECT d.deviceId, d.uid, d.signPub, d.boxPub, EXISTS (SELECT 1 FROM keys k WHERE k.deviceId = d.deviceId AND k.epoch = ?) AS hasKey FROM devices d ORDER BY d.rowid",
        g.epoch,
      )
      .toArray();
    const members = this.sql.exec<{ uid: number; login: string; role: Role }>("SELECT uid, login, role FROM members ORDER BY rowid").toArray().map((m) => ({
      uid: m.uid,
      login: m.login,
      role: m.role,
      devices: devices.filter((d) => d.uid === m.uid).map((d) => ({ deviceId: d.deviceId, signPub: d.signPub, boxPub: d.boxPub, hasKey: d.hasKey === 1 })),
    }));
    const invites = this.sql.exec<{ login: string }>("SELECT login FROM invites ORDER BY rowid").toArray().map((i) => i.login);
    const log = this.sql.exec("SELECT at, by, event, subject FROM log ORDER BY id").toArray();
    return ok({ name: g.name, epoch: g.epoch, members, invites, log });
  }

  /** Admin invites `login`. Idempotent for an existing invite; 409 if a member is shown as that login. */
  invite(caller: Caller, login: string): TeamResult {
    const g = this.guard(caller, true);
    if ("status" in g) return g;
    if (this.memberByLogin(login)) return fail(409, "already a member");
    if (this.sql.exec("SELECT 1 FROM invites WHERE login = ?", login).toArray().length) return ok();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO invites (login) VALUES (?)", login);
      this.log(caller.login, "invited", login);
    });
    this.changed();
    return { ...ok(), name: g.name, index: [{ login, role: "invited" }] };
  }

  /**
   * An invited caller joins as a member, with its current device. The invite names a login; the
   * membership binds to the caller's verified GitHub id, whose current login must be the invited one.
   */
  accept(caller: Caller): TeamResult {
    const meta = this.meta();
    if (!meta) return fail(404, "no such team");
    if (this.roleOf(caller.uid)) return ok();
    if (!this.sql.exec("SELECT 1 FROM invites WHERE login = ?", caller.login).toArray().length) return fail(403, "not invited");
    const owner = this.deviceOwner(caller.device.deviceId);
    if (owner !== null && owner !== caller.uid) return fail(409, "device belongs to another member");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM invites WHERE login = ?", caller.login);
      this.sql.exec("INSERT INTO members (uid, login, role) VALUES (?, ?, 'member')", caller.uid, caller.login);
      if (owner === null) this.insertDevice(caller.uid, caller.device);
      this.log(caller.login, "joined", caller.login);
    });
    this.changed();
    return { ...ok(), name: meta.name, index: [{ login: caller.login, role: null }, { uid: caller.uid, role: "member" }] };
  }

  /** A member adds its current device if the team does not have it yet. */
  addDevice(caller: Caller): TeamResult {
    const g = this.guard(caller);
    if ("status" in g) return g;
    const owner = this.deviceOwner(caller.device.deviceId);
    if (owner === caller.uid) return ok({ added: false });
    if (owner !== null) return fail(409, "device belongs to another member");
    this.ctx.storage.transactionSync(() => {
      this.insertDevice(caller.uid, caller.device);
      this.log(caller.login, "device-added", caller.device.deviceId);
    });
    this.changed();
    return ok({ added: true });
  }

  /**
   * Store wrapped team keys (signatures already verified by the Worker against the caller's device).
   * Lower epoch: 409. Same epoch (any member, no commit): adds wraps for devices that lack one,
   * never replaces one (409). Higher epoch (admin only): a rotation to exactly current + 1 (else 409)
   * with a commit, covering exactly the current devices; older than the two previous epochs is dropped.
   */
  putKeys(caller: Caller, epoch: number, wrapped: Record<string, SignedWrap>, commit?: EpochCommit): TeamResult {
    const g = this.guard(caller);
    if ("status" in g) return g;
    if (epoch < g.epoch) return fail(409, "epoch is older than the current one");
    if (epoch > g.epoch && g.role !== "admin") return fail(403, "only admins rotate the team key");
    if (epoch > g.epoch + 1) return fail(409, "a rotation must be to the next epoch");
    if (epoch > g.epoch && !commit) return fail(400, "a rotation needs a signed epoch commit");
    if (epoch === g.epoch && commit) return fail(400, "commit is only for a rotation");
    const by = caller.device.deviceId;
    const insert = (id: string) =>
      this.sql.exec("INSERT INTO keys (epoch, deviceId, sealed, by, sig) VALUES (?, ?, ?, ?, ?)", epoch, id, wrapped[id].sealed, by, wrapped[id].sig);
    const current = new Set(this.sql.exec<{ deviceId: string }>("SELECT deviceId FROM devices").toArray().map((d) => d.deviceId));
    const ids = Object.keys(wrapped);
    if (ids.some((id) => !current.has(id))) return fail(400, "wrapped key for a device not in the team");
    if (epoch > g.epoch) {
      if (ids.length !== current.size) return fail(400, "rotation must cover every current device");
      this.ctx.storage.transactionSync(() => {
        for (const id of ids) insert(id);
        this.sql.exec("INSERT INTO commits (epoch, hash, by, sig) VALUES (?, ?, ?, ?)", epoch, commit!.hash, by, commit!.sig);
        this.sql.exec("UPDATE meta SET epoch = ? WHERE id = 1", epoch);
        this.sql.exec("DELETE FROM keys WHERE epoch < ?", epoch - PREVIOUS_EPOCHS);
        this.sql.exec("DELETE FROM commits WHERE epoch < ?", epoch - PREVIOUS_EPOCHS);
        this.log(caller.login, "rotated", String(epoch));
      });
      this.changed();
      return ok({ epoch });
    }
    const fresh: string[] = [];
    for (const id of ids) {
      const have = this.sql.exec<{ sealed: string }>("SELECT sealed FROM keys WHERE epoch = ? AND deviceId = ?", epoch, id).toArray()[0];
      if (have && have.sealed !== wrapped[id].sealed) return fail(409, "device already has a key for this epoch");
      if (!have) fresh.push(id);
    }
    this.ctx.storage.transactionSync(() => {
      for (const id of fresh) insert(id);
    });
    if (fresh.length) this.changed();
    return ok({ epoch, added: fresh.length });
  }

  /**
   * The caller's device's wraps: current epoch in `wrapped`, and current plus up to two previous
   * ones in `epochs`, each as { sealed, by, sig, commit: { hash, by, sig } | null }.
   */
  getKeys(caller: Caller): TeamResult {
    const g = this.guard(caller);
    if ("status" in g) return g;
    const rows = this.sql
      .exec<{ epoch: number; sealed: string; by: string; sig: string; chash: string | null; cby: string | null; csig: string | null }>(
        "SELECT k.epoch, k.sealed, k.by, k.sig, c.hash AS chash, c.by AS cby, c.sig AS csig FROM keys k LEFT JOIN commits c ON c.epoch = k.epoch WHERE k.deviceId = ? AND k.epoch >= ? AND k.epoch <= ? ORDER BY k.epoch",
        caller.device.deviceId,
        g.epoch - PREVIOUS_EPOCHS,
        g.epoch,
      )
      .toArray();
    type Wrap = { sealed: string; by: string; sig: string; commit: { hash: string; by: string; sig: string } | null };
    const epochs: Record<number, Wrap> = {};
    for (const r of rows) {
      epochs[r.epoch] = { sealed: r.sealed, by: r.by, sig: r.sig, commit: r.chash ? { hash: r.chash, by: r.cby!, sig: r.csig! } : null };
    }
    return ok({ epoch: g.epoch, wrapped: epochs[g.epoch] ?? null, epochs });
  }

  /** Admin removes a member with all their devices and wrapped keys. The last admin cannot be removed. */
  remove(caller: Caller, login: string): TeamResult {
    const g = this.guard(caller, true);
    if ("status" in g) return g;
    const m = this.memberByLogin(login);
    if (!m) return fail(404, "not a member");
    if (m === "ambiguous") return fail(409, AMBIGUOUS);
    if (m.role === "admin" && this.admins() <= 1) return fail(409, "cannot remove the last admin");
    const deviceIds = this.sql.exec<{ deviceId: string }>("SELECT deviceId FROM devices WHERE uid = ?", m.uid).toArray().map((d) => d.deviceId);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM keys WHERE deviceId IN (SELECT deviceId FROM devices WHERE uid = ?)", m.uid);
      this.sql.exec("DELETE FROM devices WHERE uid = ?", m.uid);
      this.sql.exec("DELETE FROM members WHERE uid = ?", m.uid);
      this.log(caller.login, "removed", login);
    });
    this.closeMemberSockets(deviceIds);
    this.changed();
    return { ...ok({ needsRotation: true }), name: g.name, index: [{ uid: m.uid, role: null }] };
  }

  /** Admin sets a member's role. Demoting the last admin is refused (409). */
  setRole(caller: Caller, login: string, role: Role): TeamResult {
    const g = this.guard(caller, true);
    if ("status" in g) return g;
    const m = this.memberByLogin(login);
    if (!m) return fail(404, "not a member");
    if (m === "ambiguous") return fail(409, AMBIGUOUS);
    if (m.role === role) return ok();
    if (m.role === "admin" && this.admins() <= 1) return fail(409, "cannot demote the last admin");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE members SET role = ? WHERE uid = ?", role, m.uid);
      this.log(caller.login, "role", login);
    });
    this.changed();
    return { ...ok(), name: g.name, index: [{ uid: m.uid, role }] };
  }

  /** Close the team sockets of a removed member's devices (4001 "removed from team"). */
  closeMemberSockets(deviceIds: string[]): void {
    this.sockets.closeDevices(deviceIds, CLOSE_REMOVED, "removed from team");
  }
}
