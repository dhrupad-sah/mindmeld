import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface Config {
  code: string;
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

export const loadConfig = () => readJson<Config>("config.json");
export const saveConfig = (c: Config) => writeJson("config.json", c);
export const loadDaemonInfo = () => readJson<DaemonInfo>("daemon.json");
export const saveDaemonInfo = (d: DaemonInfo) => writeJson("daemon.json", d);

export const DEFAULT_RELAY = "ws://localhost:8787";
export const defaultName = () => userInfo().username;
