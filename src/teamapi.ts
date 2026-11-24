import { deviceFlowLogin } from "./auth/github.js";
import { GITHUB_CLIENT_ID } from "./auth/config.js";
import { assertSessionRelay, exchange, loadSession, savedSessionLogin, type Session } from "./auth/session.js";
import { credentialRelayAllowed, type Config } from "./config.js";
import { fingerprint, loadOrCreateIdentity } from "./identity.js";
import { httpBase, type TeamRoster } from "./teamkeys.js";

/**
 * Team operations shared by the MCP tools (src/mcpteam.ts) and the CLI: relay calls for the team
 * routes, the sign-in state, and the text shown to the user.
 */

export const NOT_SIGNED_IN = "Not signed in: run /mindmeld:login";
export const SIGNED_IN_EXPIRED = "Sign-in expired: run /mindmeld:login";
export const INSTALL = "claude plugin install mindmeld --marketplace dhrupad-sah/mindmeld";

/** GitHub logins are case-insensitive; mindmeld compares and sends them lowercased. */
export const normLogin = (login: string) => login.trim().replace(/^@/, "").toLowerCase();

/**
 * The saved session for `relay`, or why there is none: never signed in (or signed in at another
 * relay), or signed in but expired.
 */
export type SignIn = { session: Session } | { expired: string } | { none: true };
export function signInState(relay: string): SignIn {
  const session = loadSession(relay);
  if (session) return { session };
  const login = savedSessionLogin(relay);
  return login ? { expired: login } : { none: true };
}

/** "Signed in: @x", or the guidance to sign in. */
export function signInLine(s: SignIn): string {
  if ("session" in s) return `Signed in: @${s.session.login}`;
  return "expired" in s ? SIGNED_IN_EXPIRED : NOT_SIGNED_IN;
}

/** An error from a team route, with the HTTP status. */
export class TeamApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One call to a team route as `session`. A 401 becomes the sign-in guidance. */
export async function teamCall<T = unknown>(relay: string, session: Session, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  // The session token only ever goes to the relay that issued it.
  try {
    assertSessionRelay(relay, session);
  } catch (e) {
    throw new TeamApiError((e as Error).message, 401);
  }
  const res = await fetch(`${httpBase(relay)}${path}`, {
    method,
    headers: { authorization: `Bearer ${session.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401) throw new TeamApiError(SIGNED_IN_EXPIRED, 401);
    const msg = json && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : `HTTP ${res.status}`;
    throw new TeamApiError(`relay: ${msg}`, res.status);
  }
  return json as T;
}

export interface TeamEntry {
  teamId: string;
  name: string;
  role: "admin" | "member" | "invited";
}

export const createTeam = (relay: string, s: Session, name: string) => teamCall<{ teamId: string }>(relay, s, "POST", "/v1/teams", { name });
export const listTeams = (relay: string, s: Session) => teamCall<TeamEntry[]>(relay, s, "GET", "/v1/teams");
export const getRoster = (relay: string, s: Session, teamId: string, timeoutMs?: number) =>
  teamCall<TeamRoster>(relay, s, "GET", `/v1/teams/${teamId}`, undefined, timeoutMs);
export const inviteMember = (relay: string, s: Session, teamId: string, login: string) =>
  teamCall(relay, s, "POST", `/v1/teams/${teamId}/invites`, { login: normLogin(login) });
export const acceptInvite = (relay: string, s: Session, teamId: string) => teamCall(relay, s, "POST", `/v1/teams/${teamId}/accept`);
/** Add this device to a team its login is already in (a second machine). */
export const addDevice = (relay: string, s: Session, teamId: string) => teamCall<{ added: boolean }>(relay, s, "POST", `/v1/teams/${teamId}/devices`);
export const deleteMember = (relay: string, s: Session, teamId: string, login: string) =>
  teamCall(relay, s, "DELETE", `/v1/teams/${teamId}/members/${encodeURIComponent(normLogin(login))}`);
export const setRole = (relay: string, s: Session, teamId: string, login: string, role: "admin" | "member") =>
  teamCall(relay, s, "POST", `/v1/teams/${teamId}/roles`, { login: normLogin(login), role });

/**
 * Where the device flow runs: https://github.com, unless MINDMELD_GITHUB_BASE is exactly
 * http://127.0.0.1:<port> or http://localhost:<port> (a local mock for tests). Nothing else is
 * accepted, so a project-supplied env can't send the sign-in, and the user's GitHub token, to another host.
 */
export function githubBase(env: NodeJS.ProcessEnv = process.env): string {
  const m = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})\/?$/.exec(env.MINDMELD_GITHUB_BASE ?? "");
  return m && Number(m[2]) > 0 && Number(m[2]) < 65536 ? `http://${m[1]}:${m[2]}` : "https://github.com";
}

/**
 * GitHub device-flow sign-in, then the exchange for a relay session (saved to session.json, bound
 * to `relay`). `onCode` gets the code to show the user. Refuses, before asking GitHub, a relay that
 * is not the hosted one, a loopback one, or the team relay the user chose in `config`.
 */
export async function signIn(relay: string, config: Config | null, onCode: (userCode: string, verificationUri: string) => void): Promise<Session> {
  if (!credentialRelayAllowed(relay, config)) {
    throw new Error(`refusing to sign in at ${relay}: choose it explicitly with mindmeld login --relay ${relay}`);
  }
  const token = await deviceFlowLogin({ clientId: GITHUB_CLIENT_ID, onCode, githubBase: githubBase() });
  return exchange(relay, token, loadOrCreateIdentity());
}

/** The message an admin sends to someone they invited. */
export function inviteMessage(login: string, teamName: string): string {
  const who = normLogin(login);
  return [
    `Invited @${who} to team "${teamName}".`,
    "",
    `Send @${who} this message:`,
    `  1. Install mindmeld if you don't have it yet: ${INSTALL}`,
    "  2. In Claude Code, sign in with GitHub: /mindmeld:login",
    `  3. Accept the invite: /mindmeld:team accept ${teamName}`,
    "",
    `If @${who} hasn't signed in to mindmeld yet, that's fine: they'll see the invite after signing in.`,
  ].join("\n");
}

const roleText = (roster: TeamRoster, uid: number) => roster.members.find((m) => m.uid === uid)?.role;

/** "Team: core (you're admin)". `uid` is the signed-in GitHub id. */
export function teamLine(name: string, roster: TeamRoster | null, uid: number | null): string {
  const role = roster && uid !== null ? roleText(roster, uid) : undefined;
  return role ? `Team: ${name} (you're ${role})` : `Team: ${name}`;
}

type LogEntry = { at?: number; by?: string; event?: string; subject?: string };
const EVENTS: Record<string, (by: string, subject: string) => string> = {
  created: (by) => `${by} created the team`,
  invited: (by, s) => `${by} invited ${s}`,
  joined: (by) => `${by} joined`,
  "device-added": (by, s) => `${by} added device ${s}`,
  rotated: (by, s) => `${by} rotated the team key (epoch ${s})`,
  removed: (by, s) => `${by} removed ${s}`,
  role: (by, s) => `${by} changed the role of ${s}`,
};

/** The `team` tool's text: members, roles, devices (fingerprint, key), invites and the recent log. */
export function formatTeam(roster: TeamRoster, me: { uid: number; deviceId: string }): string {
  const lines = [`Team: ${roster.name} (key epoch ${roster.epoch})`, "", "Members:"];
  for (const m of roster.members) {
    lines.push(`- @${m.login} (${m.role})${m.uid === me.uid ? " (you)" : ""}`);
    if (m.devices.length === 0) lines.push("    no devices");
    for (const d of m.devices) {
      const key = d.hasKey ? "has the team key" : "waiting for the team key";
      lines.push(`    device ${fingerprint(d.signPub)}: ${key}${d.deviceId === me.deviceId ? " (this device)" : ""}`);
    }
  }
  lines.push("", `Pending invites: ${roster.invites.length ? roster.invites.map((l) => `@${l}`).join(", ") : "none"}`);
  const log = (roster.log as LogEntry[]).slice(-20).reverse();
  lines.push("", "Recent activity:");
  if (log.length === 0) lines.push("- none");
  for (const e of log) {
    const say = EVENTS[e.event ?? ""] ?? ((by: string, s: string) => `${by} ${e.event} ${s}`);
    lines.push(`- ${e.at ? new Date(e.at).toLocaleString() : "?"} ${say(e.by ?? "?", e.subject ?? "")}`);
  }
  return lines.join("\n");
}

/**
 * Remove a member, then rotate the team key so they can't read anything sent from now on.
 * A failed rotation is reported as an error, never as success.
 */
export async function removeAndRotate(
  login: string,
  ops: { remove: () => Promise<unknown>; rotate: () => Promise<number> },
): Promise<{ text: string; isError: boolean }> {
  const who = normLogin(login);
  // Already gone (e.g. an earlier remove whose rotation failed): still rotate, so running it again finishes the job.
  let gone = false;
  try {
    await ops.remove();
  } catch (e) {
    if ((e as { status?: number }).status !== 404) return { text: `Could not remove @${who}: ${(e as Error).message}`, isError: true };
    gone = true;
  }
  try {
    const epoch = await ops.rotate();
    const did = gone ? `@${who} is not in the team. Rotated the team key anyway` : `Removed @${who} and rotated the team key`;
    return { text: `${did} (now epoch ${epoch}). They can't read anything the team sends from now on.`, isError: false };
  } catch (e) {
    return {
      text: `Removed @${who}, but the team key could not be rotated: ${(e as Error).message}; run remove again or ask another admin`,
      isError: true,
    };
  }
}
