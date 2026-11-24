import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceFlowLogin } from "../src/auth/github.js";
import { exchange, loadSession } from "../src/auth/session.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { startTestRelay, TEST_TOKEN_SIGNING_KEY } from "./helpers/worker.js";

/** Build a relay token exactly as the Worker does, signed with the test key. */
function forgeToken(payload: unknown, key = TEST_TOKEN_SIGNING_KEY): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", Buffer.from(key, "hex")).update(body).digest("base64url");
  return `${body}.${sig}`;
}

describe("sign-in", () => {
  let relay: Awaited<ReturnType<typeof startTestRelay>>;
  let dir: string;
  beforeAll(async () => {
    relay = await startTestRelay();
  }, 60_000);
  afterAll(async () => {
    await relay?.stop();
  }, 30_000);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mindmeld-auth-"));
    process.env.MINDMELD_HOME = dir;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MINDMELD_HOME;
    rmSync(dir, { recursive: true, force: true });
  });

  const me = (token: string) => fetch(`${relay.url}/v1/me`, { headers: { authorization: `Bearer ${token}` } });

  it("exchange returns login and a token the relay accepts", async () => {
    const id = loadOrCreateIdentity();
    const gh = relay.github.addUser("octocat");
    const session = await exchange(relay.url, gh, id);
    expect(session.login).toBe("octocat");
    expect(session.expiresAt).toBeGreaterThan(Date.now() / 1000 + 6 * 86400);
    const res = await me(session.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: "octocat", deviceId: id.deviceId });
    // Stored, mode 600, and loadable; the GitHub token is not kept.
    expect(loadSession()).toEqual(session);
    const file = join(dir, "session.json");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(loadSession())).not.toContain(gh);
  });

  it("bad github token is rejected with 401", async () => {
    const id = loadOrCreateIdentity();
    const res = await fetch(`${relay.url}/v1/auth/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubToken: "gho_nope", device: { deviceId: id.deviceId, signPub: id.signPub, boxPub: id.boxPub } }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "github sign-in failed" });
    await expect(exchange(relay.url, "gho_nope", id)).rejects.toThrow(/github sign-in failed/);
    expect(loadSession()).toBeNull();
  });

  it("expired token is refused", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect((await me(forgeToken({ login: "octocat", deviceId: "0123456789abcdef", exp: past }))).status).toBe(401);
    // Control: the same forge with a future exp is accepted, so the 401 above is about exp.
    const future = Math.floor(Date.now() / 1000) + 600;
    expect((await me(forgeToken({ login: "octocat", deviceId: "0123456789abcdef", exp: future }))).status).toBe(200);
  });

  it("tampered, wrongly signed or malformed tokens are refused", async () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    const good = forgeToken({ login: "octocat", deviceId: "0123456789abcdef", exp: future });
    const [body, sig] = good.split(".");
    const otherBody = Buffer.from(JSON.stringify({ login: "mallory", deviceId: "0123456789abcdef", exp: future })).toString("base64url");
    for (const t of [
      `${otherBody}.${sig}`,
      forgeToken({ login: "octocat", deviceId: "0123456789abcdef", exp: future }, "11".repeat(32)),
      body,
      `${body}.`,
      `${body}.${sig}.x`,
      "not a token",
      forgeToken({ login: "octocat", deviceId: "xyz", exp: future }),
      forgeToken({ login: "octocat", deviceId: "0123456789abcdef", exp: "soon" }),
    ]) {
      expect((await me(t)).status, t).toBe(401);
    }
    expect((await fetch(`${relay.url}/v1/me`)).status).toBe(401);
  });

  it("device fields are validated and login comes from GitHub only", async () => {
    const id = loadOrCreateIdentity();
    const gh = relay.github.addUser("alice");
    const post = (body: unknown) =>
      fetch(`${relay.url}/v1/auth/github`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const dev = { deviceId: id.deviceId, signPub: id.signPub, boxPub: id.boxPub };
    for (const device of [
      { ...dev, deviceId: "abc" },
      { ...dev, signPub: "zz".repeat(32) },
      { ...dev, boxPub: id.boxPub.slice(2) },
      { ...dev, deviceId: "0".repeat(16) }, // not derived from signPub
      undefined,
    ]) {
      expect((await post({ githubToken: gh, device })).status).toBe(400);
    }
    expect((await post("nope")).status).toBe(400);
    const res = await post({ githubToken: gh, device: dev, login: "mallory" });
    expect(res.status).toBe(200);
    expect((await res.json()).login).toBe("alice");
  });

  it("deviceFlowLogin polls until granted", async () => {
    const token = relay.github.addUser("octocat");
    relay.github.setDeviceFlow({ interval: 5, userCode: "ABCD-1234", steps: ["authorization_pending", "slow_down", { token }] });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pollTimes: number[] = [];
    let inflight = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/login/oauth/access_token")) pollTimes.push(Date.now());
      inflight++;
      try {
        return await fetch(input, init);
      } finally {
        inflight--;
      }
    }) as typeof fetch;
    let code: [string, string] | undefined;
    let done = false;
    const p = deviceFlowLogin({ clientId: "Iv-test", githubBase: relay.github.url, fetchImpl, onCode: (u, v) => (code = [u, v]) })
      .finally(() => (done = true));
    const start = Date.now();
    // Advance fake time only while no request is in flight, so waits are measured exactly.
    while (!done) {
      if (inflight > 0) await new Promise((r) => setImmediate(r));
      else await vi.advanceTimersByTimeAsync(250);
    }
    expect(await p).toBe(token);
    expect(code).toEqual(["ABCD-1234", "https://github.com/login/device"]);
    expect(relay.github.devicePolls()).toBe(3);
    const waits = pollTimes.map((t, i) => t - (i === 0 ? start : pollTimes[i - 1]));
    expect(waits).toEqual([5000, 5000, 10000]);
  });

  it("deviceFlowLogin fails on access_denied", async () => {
    relay.github.setDeviceFlow({ interval: 0, steps: ["access_denied"] });
    await expect(deviceFlowLogin({ clientId: "Iv-test", githubBase: relay.github.url, onCode: () => {} })).rejects.toThrow(/denied/);
  });

  it("loadSession returns null when expired", async () => {
    const id = loadOrCreateIdentity();
    await exchange(relay.url, relay.github.addUser("octocat"), id);
    expect(loadSession()).not.toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 8 * 86400 * 1000);
    expect(loadSession()).toBeNull();
  });
});
