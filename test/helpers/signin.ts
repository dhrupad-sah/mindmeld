import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchange } from "../../src/auth/session.js";
import { loadOrCreateIdentity, type DeviceIdentity } from "../../src/identity.js";
import type { TestRelay } from "./worker.js";

/** A signed-in test device: its relay token, its identity and the login it signed in as. */
export interface TestUser {
  /** GitHub's numeric user id: the identity the relay keys membership by. */
  uid: number;
  login: string;
  token: string;
  id: DeviceIdentity;
}

/**
 * Sign `login` in end to end on a fresh device (challenge, proof, POST /v1/auth/github) against
 * the test relay. Each call creates a new device identity in its own throwaway MINDMELD_HOME, so
 * calling it twice with one `uid` gives that account two devices. Without `uid` the GitHub mock
 * assigns a fresh id (a different account, even for the same login).
 */
export async function signInTestUser(relay: TestRelay, login: string, uid?: number): Promise<TestUser> {
  const dir = mkdtempSync(join(tmpdir(), "mindmeld-signin-"));
  const prev = process.env.MINDMELD_HOME;
  process.env.MINDMELD_HOME = dir;
  try {
    const id = loadOrCreateIdentity();
    const session = await exchange(relay.url, relay.github.addUser(login, uid), id);
    return { uid: session.uid, login: session.login, token: session.token, id };
  } finally {
    if (prev === undefined) delete process.env.MINDMELD_HOME;
    else process.env.MINDMELD_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}
