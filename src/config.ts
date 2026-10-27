import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface Config {
  /** 256-bit group secret (hex), handed out during pairing. */
  secret: string;
  relay: string;
  name: string;
  /** Peers whose questions are answered without asking (lowercased names). */
  trusted?: string[];
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
  if (!c.secret) {
    throw new Error("this config is from claude-share 0.1 (code-based pairing). Pair again: `mindmeld pair --new-group` or `mindmeld join <code>`");
  }
  return c as Config;
}
export const saveConfig = (c: Config) => writeJson("config.json", c);

/** Hosted relay (Cloudflare Worker, relay-worker/). It only ever sees ciphertext. Override with --relay or MINDMELD_RELAY. */
export const DEFAULT_RELAY = process.env.MINDMELD_RELAY ?? process.env.CLAUDE_SHARE_RELAY ?? "wss://claude-share-relay.thedhrupad.workers.dev";
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
