import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestRelay } from "./helpers/worker.js";

describe("relay test harness (real Worker)", () => {
  let relay: Awaited<ReturnType<typeof startTestRelay>>;
  beforeAll(async () => {
    relay = await startTestRelay();
  }, 60_000);
  afterAll(async () => {
    await relay?.stop();
  }, 30_000);

  it("harness serves the relay", async () => {
    const res = await fetch(relay.url);
    expect(await res.text()).toContain("mindmeld relay");
    expect(relay.wsUrl.startsWith("ws://")).toBe(true);
  });

  it("github mock: 401 for unknown token, { login } for a known one", async () => {
    const bad = await fetch(`${relay.github.url}/user`, { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
    const token = relay.github.addUser("octocat");
    const ok = await fetch(`${relay.github.url}/user`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ login: "octocat" });
    expect((await fetch(`${relay.github.url}/user`)).status).toBe(401);
  });
});
