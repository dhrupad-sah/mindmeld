import { DurableObject } from "cloudflare:workers";

/**
 * Test fixture: writes team data with the 0.6.0 relay's exact table definitions (no invited_by
 * columns), so test/team-upgrade.test.ts can start the current relay on that storage.
 * POST /seed { teamId, name, adminUid, adminLogin, invitee }.
 */

export class Room extends DurableObject {}

export class Users extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, sign_pub TEXT NOT NULL, box_pub TEXT NOT NULL, added_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS teams (team_id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL)");
  }
  setTeam(teamId, name, role) {
    this.ctx.storage.sql.exec("INSERT INTO teams (team_id, name, role) VALUES (?, ?, ?)", teamId, name, role);
  }
  columns() {
    return this.ctx.storage.sql.exec("PRAGMA table_info(teams)").toArray().map((c) => c.name);
  }
}

export class Team extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, epoch INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS members (uid INTEGER PRIMARY KEY, login TEXT NOT NULL, role TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS devices (deviceId TEXT PRIMARY KEY, uid INTEGER NOT NULL, signPub TEXT NOT NULL, boxPub TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS keys (epoch INTEGER NOT NULL, deviceId TEXT NOT NULL, sealed TEXT NOT NULL, by TEXT NOT NULL, sig TEXT NOT NULL, PRIMARY KEY (epoch, deviceId))");
    sql.exec("CREATE TABLE IF NOT EXISTS commits (epoch INTEGER PRIMARY KEY, hash TEXT NOT NULL, by TEXT NOT NULL, sig TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS invites (login TEXT PRIMARY KEY)");
    sql.exec("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL, event TEXT NOT NULL, subject TEXT NOT NULL)");
  }
  seed(name, adminUid, adminLogin, invitee) {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO meta (id, name, epoch) VALUES (1, ?, 0)", name);
    sql.exec("INSERT INTO members (uid, login, role) VALUES (?, ?, 'admin')", adminUid, adminLogin);
    sql.exec("INSERT INTO invites (login) VALUES (?)", invitee);
    sql.exec("INSERT INTO log (at, by, event, subject) VALUES (?, ?, 'created', ?)", Date.now(), adminLogin, adminLogin);
    sql.exec("INSERT INTO log (at, by, event, subject) VALUES (?, ?, 'invited', ?)", Date.now(), adminLogin, invitee);
  }
  columns() {
    return this.ctx.storage.sql.exec("PRAGMA table_info(invites)").toArray().map((c) => c.name);
  }
}

export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname !== "/seed" || req.method !== "POST") return new Response("not found", { status: 404 });
    const { teamId, name, adminUid, adminLogin, invitee } = await req.json();
    const team = env.TEAMS.get(env.TEAMS.idFromName(teamId));
    await team.seed(name, adminUid, adminLogin, invitee);
    await env.USERS.get(env.USERS.idFromName(`uid:${adminUid}`)).setTeam(teamId, name, "admin");
    const index = env.USERS.get(env.USERS.idFromName(`login:${invitee}`));
    await index.setTeam(teamId, name, "invited");
    return Response.json({ invites: await team.columns(), teams: await index.columns() });
  },
};
