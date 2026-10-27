import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface Config {
  /** 256-bit group secret (hex), handed out during pairing. */
  secret: string;
  relay: string;
  name: string;
}

export interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
}

export function homeDir(): string {
  return process.env.CLAUDE_SHARE_HOME ?? join(homedir(), ".claude-share");
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
  if (!c.secret) {
    throw new Error("this config is from claude-share 0.1 (code-based pairing). Pair again: `claude-share pair --new-group` or `claude-share join <code>`");
  }
  return c as Config;
}
export const saveConfig = (c: Config) => writeJson("config.json", c);
export const loadDaemonInfo = () => readJson<DaemonInfo>("daemon.json");
export const saveDaemonInfo = (d: DaemonInfo) => writeJson("daemon.json", d);

/** Hosted relay (Cloudflare Worker, relay-worker/). It only ever sees ciphertext. Override with --relay or CLAUDE_SHARE_RELAY. */
export const DEFAULT_RELAY = process.env.CLAUDE_SHARE_RELAY ?? "wss://claude-share-relay.thedhrupad.workers.dev";
export const defaultName = () => userInfo().username;
