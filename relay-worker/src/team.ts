import { DurableObject } from "cloudflare:workers";
import { verifyToken, type AuthEnv, type DeviceRecord, type TeamIndexEntry, type TeamIndexRole } from "./auth.js";

/**
 * Teams on the relay: roster, invites, roles, device records, wrapped team keys per epoch and an
 * append-only membership log. One Team Durable Object per team (keyed by its 16-hex teamId).
 * Every route needs `Authorization: Bearer <token>` (401 without a valid one).
 * - POST /v1/teams { name } -> { teamId }; the caller becomes admin.
 * - GET /v1/teams -> [{ teamId, name, role | "invited" }], from the caller's Users index.
 * - GET /v1/teams/:id -> { name, epoch, members, invites, log } (members only).
 * - POST /v1/teams/:id/invites { login } (admin); POST /v1/teams/:id/accept (invited caller).
 * - POST /v1/teams/:id/devices (member): add the caller's current device.
 * - PUT /v1/teams/:id/keys { epoch, wrapped } (member); GET /v1/teams/:id/keys (member).
 * - DELETE /v1/teams/:id/members/:login (admin) -> { needsRotation: true }.
 * - POST /v1/teams/:id/roles { login, role } (admin).
 * Errors: 404 for an unknown team (or malformed teamId), 403 for a non-member or a role that is not
 * enough, on every route. TeamIds are 64 random bits, so 403 only confirms an id the caller already has.
 * Logins are lowercased everywhere. The caller's device keys come from its Users record, never the body.
 * Wrapped keys are opaque sealed blobs; they are only ever returned to the device they are sealed to.
 * The Users index behind GET /v1/teams is updated after each Team change; if they ever disagree,
 * the Team object wins (it alone decides access).
 */

export interface TeamEnv extends AuthEnv {
  TEAMS: DurableObjectNamespace<Team>;
}

type Role = "admin" | "member";

/** The authenticated caller: lowercased login and its current device, from the Users record. */
export interface Caller {
  login: string;
  device: DeviceRecord;
}

/** What a Team operation hands back to the Worker: the HTTP reply, plus Users index updates to apply. */
export interface TeamResult {
  status: number;
  body: unknown;
  name?: string;
  index?: { login: string; role: TeamIndexRole | null }[];
}

const HEX16 = /^[0-9a-f]{16}$/;
const LOGIN = /^[a-z0-9-]{1,39}$/;
const SEALED = /^[A-Za-z0-9+/]{1,2048}={0,2}$/;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_WRAPS = 512;
/** Wrapped keys kept per device: the current epoch plus this many before it. */
const PREVIOUS_EPOCHS = 2;

const ok = (body: unknown = {}): TeamResult => ({ status: 200, body });
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

function parseWrapped(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_WRAPS) return null;
  for (const [id, s] of entries) if (!HEX16.test(id) || typeof s !== "string" || !SEALED.test(s)) return null;
  return v as Record<string, string>;
}

/** Verify the bearer token and load the caller's device from its Users record (null: 401). */
async function authenticate(req: Request, env: TeamEnv): Promise<Caller | null> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "");
  const who = m ? await verifyToken(m[1], env) : null;
  if (!who) return null;
  const login = who.login.toLowerCase();
  const devices = await env.USERS.get(env.USERS.idFromName(login)).devices();
  const device = devices.find((d) => d.deviceId === who.deviceId);
  return device ? { login, device } : null;
}

const TEAM_PATH = /^\/v1\/teams\/([0-9a-f]{16})(?:\/(invites|accept|devices|keys|roles|members\/([^/]+)))?$/;

/** Handle /v1/teams and /v1/teams/*; null for any other path. */
export async function handleTeams(req: Request, env: TeamEnv, pathname: string): Promise<Response | null> {
  if (pathname !== "/v1/teams" && !pathname.startsWith("/v1/teams/")) return null;
  const caller = await authenticate(req, env);
  if (!caller) return json(401, { error: "sign-in required" });
  const users = (login: string) => env.USERS.get(env.USERS.idFromName(login));

  let teamId: string;
  let r: TeamResult;
  if (pathname === "/v1/teams") {
    if (req.method === "GET") return json(200, (await users(caller.login).teams()) satisfies TeamIndexEntry[]);
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
        if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) return json(400, { error: "epoch must be an integer >= 1" });
        if (!wrapped) return json(400, { error: "wrapped must map 16-hex device ids to sealed keys" });
        r = await team.putKeys(caller, epoch, wrapped);
        break;
      }
      case "GET keys":
        r = await team.getKeys(caller);
        break;
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
      await users(u.login).setTeam(teamId, r.name ?? "", u.role);
    } catch {}
  }
  return json(r.status, r.body);
}

/** One team: its roster, devices, wrapped keys and membership log, in Durable Object SQLite. */
export class Team extends DurableObject<TeamEnv> {
  constructor(ctx: DurableObjectState, env: TeamEnv) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, epoch INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS members (login TEXT PRIMARY KEY, role TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS devices (deviceId TEXT PRIMARY KEY, login TEXT NOT NULL, signPub TEXT NOT NULL, boxPub TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS keys (epoch INTEGER NOT NULL, deviceId TEXT NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY (epoch, deviceId))");
    sql.exec("CREATE TABLE IF NOT EXISTS invites (login TEXT PRIMARY KEY)");
    sql.exec("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL, event TEXT NOT NULL, subject TEXT NOT NULL)");
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  private meta(): { name: string; epoch: number } | null {
    return this.sql.exec<{ name: string; epoch: number }>("SELECT name, epoch FROM meta WHERE id = 1").toArray()[0] ?? null;
  }

  private roleOf(login: string): Role | null {
    return (this.sql.exec<{ role: Role }>("SELECT role FROM members WHERE login = ?", login).toArray()[0]?.role) ?? null;
  }

  private admins(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE role = 'admin'").one().n;
  }

  private log(by: string, event: string, subject: string): void {
    this.sql.exec("INSERT INTO log (at, by, event, subject) VALUES (?, ?, ?, ?)", Date.now(), by, event, subject);
  }

  /** Device owner, or null if the device is not in this team. */
  private deviceOwner(deviceId: string): string | null {
    return this.sql.exec<{ login: string }>("SELECT login FROM devices WHERE deviceId = ?", deviceId).toArray()[0]?.login ?? null;
  }

  private insertDevice(login: string, d: DeviceRecord): void {
    this.sql.exec("INSERT INTO devices (deviceId, login, signPub, boxPub) VALUES (?, ?, ?, ?)", d.deviceId, login, d.signPub, d.boxPub);
  }

  /**
   * Shared guard: 404 for an unknown team, 403 unless the caller is a member (and an admin when
   * `admin` is set). Returns the team's meta and the caller's role when allowed.
   */
  private guard(caller: Caller, admin = false): TeamResult | { name: string; epoch: number; role: Role } {
    const meta = this.meta();
    if (!meta) return fail(404, "no such team");
    const role = this.roleOf(caller.login);
    if (!role) return fail(403, "not a member of this team");
    if (admin && role !== "admin") return fail(403, "admins only");
    return { ...meta, role };
  }

  /** Set up a new team with `caller` as its admin. 409 if this teamId is already taken. */
  create(name: string, caller: Caller): TeamResult {
    if (this.meta()) return fail(409, "team id taken");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO meta (id, name, epoch) VALUES (1, ?, 0)", name);
      this.sql.exec("INSERT INTO members (login, role) VALUES (?, 'admin')", caller.login);
      this.insertDevice(caller.login, caller.device);
      this.log(caller.login, "created", caller.login);
    });
    return { ...ok(), name, index: [{ login: caller.login, role: "admin" }] };
  }

  /** The full roster (members only). `hasKey` is whether the device has a wrap at the current epoch. */
  roster(caller: Caller): TeamResult {
    const g = this.guard(caller);
    if ("status" in g) return g;
    const devices = this.sql
      .exec<{ deviceId: string; login: string; signPub: string; boxPub: string; hasKey: number }>(
        "SELECT d.deviceId, d.login, d.signPub, d.boxPub, EXISTS (SELECT 1 FROM keys k WHERE k.deviceId = d.deviceId AND k.epoch = ?) AS hasKey FROM devices d ORDER BY d.rowid",
        g.epoch,
      )
      .toArray();
    const members = this.sql.exec<{ login: string; role: Role }>("SELECT login, role FROM members ORDER BY rowid").toArray().map((m) => ({
      login: m.login,
      role: m.role,
      devices: devices.filter((d) => d.login === m.login).map((d) => ({ deviceId: d.deviceId, signPub: d.signPub, boxPub: d.boxPub, hasKey: d.hasKey === 1 })),
    }));
    const invites = this.sql.exec<{ login: string }>("SELECT login FROM invites ORDER BY rowid").toArray().map((i) => i.login);
    const log = this.sql.exec("SELECT at, by, event, subject FROM log ORDER BY id").toArray();
    return ok({ name: g.name, epoch: g.epoch, members, invites, log });
  }

  /** Admin invites `login`. Idempotent for an existing invite; 409 if already a member. */
  invite(caller: Caller, login: string): TeamResult {
    const g = this.guard(caller, true);
    if ("status" in g) return g;
    if (this.roleOf(login)) return fail(409, "already a member");
    if (this.sql.exec("SELECT 1 FROM invites WHERE login = ?", login).toArray().length) return ok();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO invites (login) VALUES (?)", login);
      this.log(caller.login, "invited", login);
    });
    return { ...ok(), name: g.name, index: [{ login, role: "invited" }] };
  }

  /** An invited caller joins as a member, with its current device. */
  accept(caller: Caller): TeamResult {
    const meta = this.meta();
    if (!meta) return fail(404, "no such team");
    if (this.roleOf(caller.login)) return ok();
    if (!this.sql.exec("SELECT 1 FROM invites WHERE login = ?", caller.login).toArray().length) return fail(403, "not invited");
    const owner = this.deviceOwner(caller.device.deviceId);
    if (owner && owner !== caller.login) return fail(409, "device belongs to another member");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM invites WHERE login = ?", caller.login);
      this.sql.exec("INSERT INTO members (login, role) VALUES (?, 'member')", caller.login);
      if (!owner) this.insertDevice(caller.login, caller.device);
      this.log(caller.login, "joined", caller.login);
    });
    return { ...ok(), name: meta.name, index: [{ login: caller.login, role: "member" }] };
  }

  /** A member adds its current device if the team does not have it yet. */
  addDevice(caller: Caller): TeamResult {
    const g = this.guard(caller);
    if ("status" in g) return g;
    const owner = this.deviceOwner(caller.device.deviceId);
    if (owner === caller.login) return ok({ added: false });
    if (owner) return fail(409, "device belongs to another member");
    this.ctx.storage.transactionSync(() => {
      this.insertDevice(caller.login, caller.device);
      this.log(caller.login, "device-added", caller.device.deviceId);
    });
    return ok({ added: true });
  }

  /**
   * Store wrapped team keys. Lower epoch: 409. Same epoch (any member): adds wraps for devices
   * that lack one, never replaces one (409). Higher epoch (admin only): a rotation, which must
   * cover exactly the current devices; keys older than the two previous epochs are dropped.
   */
  putKeys(caller: Caller, epoch: number, wrapped: Record<string, string>): TeamResult {
    const g = this.guard(caller);
    if ("status" in g) return g;
    if (epoch < g.epoch) return fail(409, "epoch is older than the current one");
    if (epoch > g.epoch && g.role !== "admin") return fail(403, "only admins rotate the team key");
    const current = new Set(this.sql.exec<{ deviceId: string }>("SELECT deviceId FROM devices").toArray().map((d) => d.deviceId));
    const ids = Object.keys(wrapped);
    if (ids.some((id) => !current.has(id))) return fail(400, "wrapped key for a device not in the team");
    if (epoch > g.epoch) {
      if (ids.length !== current.size) return fail(400, "rotation must cover every current device");
      this.ctx.storage.transactionSync(() => {
        for (const id of ids) this.sql.exec("INSERT INTO keys (epoch, deviceId, sealed) VALUES (?, ?, ?)", epoch, id, wrapped[id]);
        this.sql.exec("UPDATE meta SET epoch = ? WHERE id = 1", epoch);
        this.sql.exec("DELETE FROM keys WHERE epoch < ?", epoch - PREVIOUS_EPOCHS);
        this.log(caller.login, "rotated", String(epoch));
      });
      return ok({ epoch });
    }
    const fresh: string[] = [];
    for (const id of ids) {
      const have = this.sql.exec<{ sealed: string }>("SELECT sealed FROM keys WHERE epoch = ? AND deviceId = ?", epoch, id).toArray()[0];
      if (have && have.sealed !== wrapped[id]) return fail(409, "device already has a key for this epoch");
      if (!have) fresh.push(id);
    }
    this.ctx.storage.transactionSync(() => {
      for (const id of fresh) this.sql.exec("INSERT INTO keys (epoch, deviceId, sealed) VALUES (?, ?, ?)", epoch, id, wrapped[id]);
    });
    return ok({ epoch, added: fresh.length });
  }

  /** The caller's device's wrapped keys: current epoch, plus up to two previous ones in `epochs`. */
  getKeys(caller: Caller): TeamResult {
    const g = this.guard(caller);
    if ("status" in g) return g;
    const rows = this.sql
      .exec<{ epoch: number; sealed: string }>("SELECT epoch, sealed FROM keys WHERE deviceId = ? AND epoch >= ? AND epoch <= ? ORDER BY epoch", caller.device.deviceId, g.epoch - PREVIOUS_EPOCHS, g.epoch)
      .toArray();
    const epochs: Record<number, string> = {};
    for (const r of rows) epochs[r.epoch] = r.sealed;
    return ok({ epoch: g.epoch, wrapped: epochs[g.epoch] ?? null, epochs });
  }

  /** Admin removes a member with all their devices and wrapped keys. The last admin cannot be removed. */
  remove(caller: Caller, login: string): TeamResult {
    const g = this.guard(caller, true);
    if ("status" in g) return g;
    const role = this.roleOf(login);
    if (!role) return fail(404, "not a member");
    if (role === "admin" && this.admins() <= 1) return fail(409, "cannot remove the last admin");
    const deviceIds = this.sql.exec<{ deviceId: string }>("SELECT deviceId FROM devices WHERE login = ?", login).toArray().map((d) => d.deviceId);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM keys WHERE deviceId IN (SELECT deviceId FROM devices WHERE login = ?)", login);
      this.sql.exec("DELETE FROM devices WHERE login = ?", login);
      this.sql.exec("DELETE FROM members WHERE login = ?", login);
      this.log(caller.login, "removed", login);
    });
    this.closeMemberSockets(login, deviceIds);
    return { ...ok({ needsRotation: true }), name: g.name, index: [{ login, role: null }] };
  }

  /** Admin sets a member's role. Demoting the last admin is refused (409). */
  setRole(caller: Caller, login: string, role: Role): TeamResult {
    const g = this.guard(caller, true);
    if ("status" in g) return g;
    const now = this.roleOf(login);
    if (!now) return fail(404, "not a member");
    if (now === role) return ok();
    if (now === "admin" && this.admins() <= 1) return fail(409, "cannot demote the last admin");
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE members SET role = ? WHERE login = ?", role, login);
      this.log(caller.login, "role", login);
    });
    return { ...ok(), name: g.name, index: [{ login, role }] };
  }

  /**
   * Close the team sockets of a removed member's devices. Hook for Task 7 (team sockets); a no-op
   * until sockets live here.
   */
  closeMemberSockets(_login: string, _deviceIds: string[]): void {}
}
