import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface Config {
  /** 256-bit group secret (hex), handed out during pairing. Absent on a team-only machine. */
  secret?: string;
  /** Relay for the legacy group. May come from MINDMELD_RELAY at pairing time, so it never carries credentials. */
  relay: string;
  /**
   * Relay for teams: where the GitHub token and the session token go. Only set by
   * `mindmeld login --relay` or by hand; never from the environment. Default: the hosted relay.
   */
  teamRelay?: string;
  name: string;
  /** Peers whose questions are answered without asking (lowercased names). */
  trusted?: string[];
  /** The team this machine is in (GitHub sign-in). When set it is used instead of the legacy group. */
  team?: { teamId: string; name: string };
}

export function homeDir(): string {
  const explicit = process.env.MINDMELD_HOME ?? process.env.CLAUDE_SHARE_HOME;
  if (explicit) return explicit;
  const dir = join(homedir(), ".mindmeld");
  // Carry a pairing over from the claude-share days.
  const legacy = join(homedir(), ".claude-share", "config.json");
  if (!existsSync(join(dir, "config.json")) && existsSync(legacy)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(legacy, join(dir, "config.json"));
    chmodSync(join(dir, "config.json"), 0o600);
  }
  return dir;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(join(homeDir(), file), "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const path = join(homeDir(), file);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function loadConfig(): Config | null {
  const c = readJson<Partial<Config> & { code?: string }>("config.json");
  if (!c) return null;
  // 0.1 configs had a pairing `code` and no secret. A config with neither secret nor team is otherwise
  // fine (e.g. only a team relay chosen with `mindmeld login --relay`): it just isn't connected to anyone.
  if (c.code !== undefined && !c.secret && !c.team) {
    throw new Error("this config is from claude-share 0.1 (code-based pairing). Pair again: `mindmeld pair --new-group` or `mindmeld join <code>`");
  }
  return c as Config;
}
export const saveConfig = (c: Config) => writeJson("config.json", c);

/**
 * `prev` switched to `team` (with `base` filled in). The always-allow list is dropped when the team
 * changes, so a name trusted in a legacy group (or another team) can't match a GitHub login.
 */
export function withTeam(prev: Config | null, base: Pick<Config, "relay" | "name">, team: { teamId: string; name: string }): Config {
  const { trusted, ...rest } = prev ?? ({} as Partial<Config>);
  const same = prev?.team?.teamId === team.teamId;
  return { ...rest, ...base, team, ...(same && trusted ? { trusted } : {}) } as Config;
}

/** Leave the group: forget the group secret (and the legacy copy, so it isn't migrated back). */
export function deleteConfig(): void {
  rmSync(join(homeDir(), "config.json"), { force: true });
  if (!process.env.MINDMELD_HOME && !process.env.CLAUDE_SHARE_HOME) {
    rmSync(join(homedir(), ".claude-share", "config.json"), { force: true });
  }
}

/** Hosted relay (Cloudflare Worker, relay-worker/). It only ever sees ciphertext. */
export const HOSTED_RELAY = "wss://claude-share-relay.thedhrupad.workers.dev";
/**
 * Relay for legacy (invite-code) groups. `--relay` or MINDMELD_RELAY override it for self-hosting.
 * Never used for team sign-in or sessions: see `teamRelay`.
 */
export const DEFAULT_RELAY = process.env.MINDMELD_RELAY ?? process.env.CLAUDE_SHARE_RELAY ?? HOSTED_RELAY;

/** http(s) base URL of a relay, no trailing slash; ws(s):// is mapped to http(s)://. */
export const httpBase = (relay: string) => relay.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");

/** Two spellings of the same relay (ws vs http, trailing slash). */
export const sameRelay = (a: string, b: string) => httpBase(a) === httpBase(b);

/**
 * Where team sign-in and team calls go: `config.teamRelay` (written by the user or
 * `mindmeld login --relay`), else the hosted relay. Environment variables are ignored on purpose:
 * a project can set them, and the relay receives the user's GitHub token and session token.
 */
export function teamRelay(config: Config | null): string {
  return config?.teamRelay ?? HOSTED_RELAY;
}

/** ws(s)/http(s) on 127.0.0.1 or localhost (any port), nothing else in the authority. */
function isLoopback(relay: string): boolean {
  return /^(?:ws|wss|http|https):\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?\/?$/.test(relay);
}

/**
 * True if a GitHub token or session token may be sent to `relay`: the hosted relay, a loopback relay,
 * or the team relay the user chose (`config.teamRelay`). The legacy `relay` field never counts.
 */
export function credentialRelayAllowed(relay: string, config: Config | null): boolean {
  if (sameRelay(relay, HOSTED_RELAY) || isLoopback(relay)) return true;
  return !!config?.teamRelay && sameRelay(relay, config.teamRelay);
}

/** "Relay: <host> (not the default)" when `relay` isn't the hosted relay (self-hosting is allowed, but the user should see it). */
export function relayWarning(relay: string): string | null {
  if (sameRelay(relay, HOSTED_RELAY)) return null;
  let host = relay;
  try {
    host = new URL(relay).host || relay;
  } catch {}
  return `Relay: ${host} (not the default)`;
}
/** git's user.name if set, else the OS username. */
export function defaultName(): string {
  try {
    const name = execFileSync("git", ["config", "--global", "user.name"], { encoding: "utf8", timeout: 2000 }).trim();
    if (name) return name;
  } catch {
    // no git, or no name configured
  }
  return userInfo().username;
}
