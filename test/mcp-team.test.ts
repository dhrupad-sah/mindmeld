import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { exchange } from "../src/auth/session.js";
import { fingerprint, loadOrCreateIdentity, type DeviceIdentity } from "../src/identity.js";
import { removeAndRotate } from "../src/teamapi.js";
import { WAITING_FOR_KEY } from "../src/teamkeys.js";
import { startServer } from "./helpers/mcpserver.js";
import { startTestRelay, type TestRelay } from "./helpers/worker.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("team tools over MCP", () => {
  let relay: TestRelay;
  beforeAll(async () => {
    relay = await startTestRelay();
  }, 60_000);
  afterAll(async () => {
    await relay?.stop();
  }, 30_000);

  const stops: (() => void)[] = [];
  afterEach(() => {
    for (const s of stops.splice(0)) s();
  });

  let n = 0;
  const unique = (base: string) => `${base}${++n}`;

  /** A fresh mindmeld home; signed in as `login` against the test relay when given. */
  async function home(login?: string): Promise<{ dir: string; id?: DeviceIdentity }> {
    const dir = mkdtempSync(join(tmpdir(), "mindmeld-team-home-"));
    if (!login) return { dir };
    const prev = process.env.MINDMELD_HOME;
    process.env.MINDMELD_HOME = dir;
    try {
      const id = loadOrCreateIdentity();
      await exchange(relay.url, relay.github.addUser(login), id);
      return { dir, id };
    } finally {
      if (prev === undefined) delete process.env.MINDMELD_HOME;
      else process.env.MINDMELD_HOME = prev;
    }
  }
  function server(dir: string) {
    const s = startServer(dir, { MINDMELD_RELAY: relay.url, MINDMELD_GITHUB_BASE: relay.github.url });
    stops.push(s.stop);
    return s;
  }
  async function until(s: ReturnType<typeof server>, tool: string, want: string, ms = 15_000) {
    const end = Date.now() + ms;
    let last = "";
    while (Date.now() < end) {
      last = await s.call(tool);
      if (last.includes(want)) return last;
      await sleep(200);
    }
    throw new Error(`${tool} never showed "${want}"; last:\n${last}`);
  }

  it("status says how to sign in when not signed in, and team tools give the same guidance", async () => {
    const { dir } = await home();
    const s = server(dir);
    expect(await s.call("status")).toContain("Not signed in: run /mindmeld:login");
    for (const [tool, args] of [["create_team", { name: "x" }], ["invite_member", { login: "x" }], ["accept_invite", {}], ["team", {}], ["set_role", { login: "x", role: "admin" }]] as const) {
      expect(await s.call(tool, args), tool).toContain("Not signed in: run /mindmeld:login");
    }
  });

  it("login returns the code at once and finishes in the background", async () => {
    const login = unique("dana");
    relay.github.setDeviceFlow({ interval: 0, userCode: "WXYZ-1234", steps: ["authorization_pending", { token: relay.github.addUser(login) }] });
    const { dir } = await home();
    const s = server(dir);
    expect(await s.call("login")).toContain("Open https://github.com/login/device and enter WXYZ-1234");
    await until(s, "status", `Signed in: @${login}`);
  });

  it("a signed-in team shows sign-in, team and role; a member without the key shows the waiting text", async () => {
    const alice = unique("alice");
    const bob = unique("bob");
    const a = await home(alice);
    const b = await home(bob);

    const sa = server(a.dir);
    expect(await sa.call("create_team", { name: "core" })).toContain('Created team "core"');
    let st = await until(sa, "status", "Connection: connected");
    expect(st).toContain(`Signed in: @${alice}`);
    expect(st).toContain("Team: core (you're admin)");

    const inv = await sa.call("invite_member", { login: bob.toUpperCase() });
    expect(inv).toContain(`@${bob}`);
    expect(inv).toContain("claude plugin install mindmeld --marketplace dhrupad-sah/mindmeld");
    expect(inv).toContain("/mindmeld:login");
    expect(inv).toContain("after signing in");

    // Nobody holding the key is online, so bob waits for it.
    sa.stop();
    const sb = server(b.dir);
    expect(await sb.call("accept_invite")).toContain('Joined team "core"');
    st = await until(sb, "status", WAITING_FOR_KEY);
    expect(st).toContain(`Signed in: @${bob}`);
    expect(st).toContain("Team: core (you're member)");
    expect(await sb.call("list_peers")).toContain(WAITING_FOR_KEY);

    // Alice comes back online and her mindmeld delivers the key.
    const sa2 = server(a.dir);
    await until(sb, "status", "Connection: connected", 30_000);

    const t = await sa2.call("team");
    expect(t).toContain(`@${alice} (admin)`);
    expect(t).toContain(`@${bob} (member)`);
    expect(t).toContain(fingerprint(a.id!.signPub));
    expect(t).toContain("this device");
    expect(t).toContain("has the team key");
    expect(t).toContain(`${alice} invited ${bob}`);

    expect(await sa2.call("set_role", { login: bob, role: "admin" })).toContain(`@${bob} is now admin`);
    expect(await sa2.call("set_role", { login: bob, role: "member" })).toContain(`@${bob} is now member`);

    const refused = await sa2.reply("remove_member", { login: bob });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("confirm");
    const removed = await sa2.call("remove_member", { login: bob, confirmed: true });
    expect(removed).toContain(`Removed @${bob}`);
    expect(removed).toContain("rotated");
    await until(sb, "status", "removed from team");
  }, 120_000);

  it("an expired sign-in says so in status and in other tools", async () => {
    const { dir } = await home();
    writeFileSync(join(dir, "session.json"), JSON.stringify({ login: "erin", token: "t", expiresAt: Math.floor(Date.now() / 1000) - 60 }));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ relay: relay.url, name: "erin", team: { teamId: "0123456789abcdef", name: "core" } }));
    const s = server(dir);
    const st = await s.call("status");
    expect(st).toContain("Sign-in expired: run /mindmeld:login");
    expect(st).toContain("Team: core");
    expect(await s.call("list_peers")).toContain("Sign-in expired: run /mindmeld:login");
    expect(await s.call("team")).toContain("Sign-in expired: run /mindmeld:login");
  });
});

describe("removeAndRotate", () => {
  it("says clearly when the member was removed but the key could not be rotated", async () => {
    const r = await removeAndRotate("bob", {
      remove: async () => {},
      rotate: async () => {
        throw new Error("relay: boom");
      },
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Removed @bob, but the team key could not be rotated: relay: boom; run remove again or ask another admin");
  });

  it("does not rotate when the removal itself fails", async () => {
    let rotated = false;
    const r = await removeAndRotate("bob", {
      remove: async () => {
        throw new Error("relay: admins only");
      },
      rotate: async () => {
        rotated = true;
        return 2;
      },
    });
    expect(rotated).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Could not remove @bob: relay: admins only");
  });
});
