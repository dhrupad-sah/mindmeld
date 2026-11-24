import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchange } from "../../src/auth/session.js";
import { loadOrCreateIdentity, type DeviceIdentity } from "../../src/identity.js";
import type { TestRelay } from "./worker.js";

/** A signed-in test device: its relay token, its identity and the login it signed in as. */
export interface TestUser {
  login: string;
  token: string;
  id: DeviceIdentity;
}

/**
 * Sign `login` in end to end on a fresh device (challenge, proof, POST /v1/auth/github) against
 * the test relay. Each call creates a new device identity in its own throwaway MINDMELD_HOME, so
 * calling it twice with one login gives that login two devices.
 */
export async function signInTestUser(relay: TestRelay, login: string): Promise<TestUser> {
  const dir = mkdtempSync(join(tmpdir(), "mindmeld-signin-"));
  const prev = process.env.MINDMELD_HOME;
  process.env.MINDMELD_HOME = dir;
  try {
    const id = loadOrCreateIdentity();
    const session = await exchange(relay.url, relay.github.addUser(login), id);
    return { login: session.login, token: session.token, id };
  } finally {
    if (prev === undefined) delete process.env.MINDMELD_HOME;
    else process.env.MINDMELD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}
