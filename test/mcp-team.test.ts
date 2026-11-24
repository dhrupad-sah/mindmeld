import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { exchange } from "../src/auth/session.js";
import { fingerprint, loadOrCreateIdentity, type DeviceIdentity } from "../src/identity.js";
import { githubBase, removeAndRotate } from "../src/teamapi.js";
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
    // Team sign-in goes only to a relay the user chose, never one from the environment.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ relay: relay.wsUrl, name: "x", teamRelay: relay.url }));
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
  function server(dir: string, opts: Parameters<typeof startServer>[2] = {}) {
    const s = startServer(dir, { MINDMELD_GITHUB_BASE: relay.github.url }, opts);
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
    expect(st).toContain(`Relay: ${new URL(relay.url).host} (not the default)`);
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

  it("remove_member always asks in a dialog when it can, even with confirmed: true", async () => {
    const alice = unique("alice");
    const bob = unique("bob");
    const a = await home(alice);
    const b = await home(bob);
    const sa = server(a.dir, { elicit: "decline" });
    expect(await sa.call("create_team", { name: "core" })).toContain("Created team");
    await sa.call("invite_member", { login: bob });
    const sb = server(b.dir);
    expect(await sb.call("accept_invite")).toContain("Joined team");

    expect(await sa.call("remove_member", { login: bob, confirmed: true })).toContain(`@${bob} stays in the team`);
    expect(sa.dialogs).toHaveLength(1);
    expect(sa.dialogs[0]).toContain(`Remove @${bob}`);
    expect(await sa.call("team")).toContain(`@${bob} (member)`); // no DELETE was sent
  }, 60_000);

  it("leaving keeps the team, and a member whose config lost the team can pick it again", async () => {
    const alice = unique("alice");
    const bob = unique("bob");
    const a = await home(alice);
    const b = await home(bob);
    const sa = server(a.dir);
    await sa.call("create_team", { name: "core" });
    await sa.call("invite_member", { login: bob });
    const sb = server(b.dir);
    await sb.call("accept_invite");

    const configPath = join(b.dir, "config.json");
    expect(await sb.call("leave_group", { confirmed: true })).toContain("leaving a team isn't supported yet");
    expect(JSON.parse(readFileSync(configPath, "utf8")).team.name).toBe("core");

    // A legacy group next to the team: leaving drops only the group secret.
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), secret: "ab".repeat(32) }));
    expect(await sb.call("leave_group", { confirmed: true })).toContain("Left the old invite-code group");
    const left = JSON.parse(readFileSync(configPath, "utf8"));
    expect(left.secret).toBeUndefined();
    expect(left.team.name).toBe("core");

    // Config without the team (e.g. from an older build): the member selects it again.
    const { team: _t, ...rest } = left;
    writeFileSync(configPath, JSON.stringify(rest));
    await sleep(3500); // the watcher follows the change
    expect(await sb.call("team")).toContain('team "core" (member)');
    expect(await sb.call("accept_invite", { team: "core" })).toContain('now uses team "core"');
    await until(sb, "status", "Team: core (you're member)");
  }, 60_000);

  it("leave_group always asks in a dialog when it can, even with confirmed: true", async () => {
    const { dir } = await home();
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ secret: "cd".repeat(32), relay: relay.wsUrl, name: "erin", teamRelay: relay.url }));
    const s = server(dir, { elicit: "decline" });
    expect(await s.call("leave_group", { confirmed: true })).toContain("staying in the group");
    expect(s.dialogs).toHaveLength(1);
    expect(s.dialogs[0]).toContain("Leave your mindmeld group?");
    expect(JSON.parse(readFileSync(configPath, "utf8")).secret).toBe("cd".repeat(32));
  });

  it("creating or joining a team clears the always-allow list", async () => {
    const alice = unique("alice");
    const bob = unique("bob");
    const a = await home(alice);
    const b = await home(bob);
    // Names trusted in a legacy group must not carry over to GitHub logins.
    for (const h of [a, b]) {
      writeFileSync(join(h.dir, "config.json"), JSON.stringify({ secret: "ef".repeat(32), relay: relay.wsUrl, name: "x", teamRelay: relay.url, trusted: [bob, alice, "mallory"] }));
    }
    const sa = server(a.dir);
    expect(await sa.call("create_team", { name: "core" })).toContain("Created team");
    expect(JSON.parse(readFileSync(join(a.dir, "config.json"), "utf8")).trusted ?? []).toEqual([]);
    await sa.call("invite_member", { login: bob });
    const sb = server(b.dir);
    expect(await sb.call("accept_invite")).toContain("Joined team");
    expect(JSON.parse(readFileSync(join(b.dir, "config.json"), "utf8")).trusted ?? []).toEqual([]);
    expect(await until(sb, "status", "Team: core")).toContain("Always allowed (answered without dialogs): nobody");
  }, 60_000);

  it("join_peer and invite_peer refuse while a team is set, and change nothing", async () => {
    const { dir } = await home();
    const configPath = join(dir, "config.json");
    const before = JSON.stringify({ relay: relay.wsUrl, name: "erin", teamRelay: relay.url, team: { teamId: "0123456789abcdef", name: "core" } });
    writeFileSync(configPath, before);
    const s = server(dir);
    for (const [tool, args] of [["join_peer", { code: "k7q2-9xmd-4tpa" }], ["invite_peer", {}]] as const) {
      const r = await s.reply(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toContain('this machine is using team "core"; legacy groups are inactive while a team is set');
    }
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("an expired sign-in says so in status and in other tools", async () => {
    const { dir } = await home();
    writeFileSync(join(dir, "session.json"), JSON.stringify({ login: "erin", token: "t", expiresAt: Math.floor(Date.now() / 1000) - 60, relay: relay.url }));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ relay: relay.url, name: "erin", teamRelay: relay.url, team: { teamId: "0123456789abcdef", name: "core" } }));
    const s = server(dir);
    const st = await s.call("status");
    expect(st).toContain("Sign-in expired: run /mindmeld:login");
    expect(st).toContain("Team: core");
    expect(await s.call("list_peers")).toContain("Sign-in expired: run /mindmeld:login");
    expect(await s.call("team")).toContain("Sign-in expired: run /mindmeld:login");
  });
});

describe("githubBase", () => {
  it("accepts MINDMELD_GITHUB_BASE only for a loopback http mock", () => {
    expect(githubBase({ MINDMELD_GITHUB_BASE: "http://127.0.0.1:8123" })).toBe("http://127.0.0.1:8123");
    expect(githubBase({ MINDMELD_GITHUB_BASE: "http://localhost:9000/" })).toBe("http://localhost:9000");
    for (const v of [
      "http://evil.example",
      "https://evil.example",
      "http://127.0.0.1", // no port
      "http://127.0.0.1.evil.example:80",
      "http://localhost.evil.example:80",
      "http://user@evil.example:80@127.0.0.1:80",
      "https://127.0.0.1:8123",
      "http://127.0.0.1:8123/path",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(githubBase({ MINDMELD_GITHUB_BASE: v }), v).toBe("https://github.com");
    }
    // The old development switches no longer unlock anything.
    expect(githubBase({ MINDMELD_GITHUB_BASE: "http://mock", NODE_ENV: "test" })).toBe("https://github.com");
    expect(githubBase({ MINDMELD_GITHUB_BASE: "http://evil.example", MINDMELD_DEV: "1" })).toBe("https://github.com");
    expect(githubBase({})).toBe("https://github.com");
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
