#!/usr/bin/env node
/**
 * Live team test against the PRODUCTION relay and real GitHub, with two people.
 *
 *   node test/live/run-team-live.mjs <adminLogin> <memberLogin>
 *
 * Starts two mindmeld servers (the plugin bundle) as MCP processes, one per person, each with
 * its own MINDMELD_HOME. Both sign in with GitHub's device flow: the script prints
 * "CODE <who>: <code>" lines, and each person enters theirs at https://github.com/login/device.
 * Then: create a team, invite, accept, share, ask (the answer comes from a real read-only
 * Claude fork on the member's side), remove the member, and check they are locked out.
 *
 * The MCP client here can't show approval dialogs, so the member "always allows" the admin
 * and removal passes confirmed: true (both are the documented no-dialog paths).
 * Needs a signed-in `claude` and `npm run build:plugin`. Uses a little Claude quota.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [admin, member] = process.argv.slice(2);
if (!admin || !member) {
  console.error("usage: node test/live/run-team-live.mjs <adminLogin> <memberLogin>");
  process.exit(2);
}
const BUNDLE = fileURLToPath(new URL("../../plugin/server/mindmeld.cjs", import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), "mm_team_live_"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail.replace(/\s+/g, " ").slice(0, 240)}` : ""}`);
};

// A fresh-terminal environment: no markers inherited from a parent Claude session.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE_CODE_") && !["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT"].includes(k)),
);

function startServer(who) {
  const home = join(WORK, `home-${who}`);
  const project = join(WORK, `project-${who}`);
  mkdirSync(project, { recursive: true });
  if (who === "member") {
    writeFileSync(
      join(project, "notes.md"),
      "# Scraper notes\n\nThe scraper got fast because we switched to a bounded worker pool of 32 workers with HTTP keep-alive and connection reuse. Runtime went from 40 minutes to 3.\n",
    );
  }
  const child = spawn(process.execPath, [BUNDLE, "mcp"], {
    cwd: project,
    env: { ...cleanEnv, MINDMELD_HOME: home, CLAUDE_PROJECT_DIR: project },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiting = new Map();
  let nextId = 1;
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line);
        if (m.id !== undefined && waiting.has(m.id)) {
          waiting.get(m.id)(m);
          waiting.delete(m.id);
        }
      } catch {
        // not JSON-RPC
      }
    }
  });
  child.stderr.on("data", () => {}); // server logs; not needed
  const rpc = (method, params, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = setTimeout(() => reject(new Error(`${who} ${method} timed out`)), timeoutMs);
      waiting.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name, args = {}, timeoutMs) => {
    const m = await rpc("tools/call", { name, arguments: args }, timeoutMs);
    if (m.error) return { text: `RPC error: ${m.error.message}`, isError: true };
    return { text: (m.result?.content ?? []).map((c) => c.text).join("\n"), isError: !!m.result?.isError };
  };
  const init = async () => {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "team-live", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  };
  return { who, call, init, stop: () => child.kill() };
}

async function waitFor(label, fn, timeoutMs, everyMs = 4000) {
  const end = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < end) {
    const r = await fn();
    if (r.ok) return { ok: true, text: r.text };
    last = r.text;
    await sleep(everyMs);
  }
  return { ok: false, text: `${label} timed out; last: ${last}` };
}

const A = startServer("admin");
const B = startServer("member");
try {
  await A.init();
  await B.init();

  // 1. Sign in both (humans approve on github.com).
  for (const [s, login] of [[A, admin], [B, member]]) {
    const r = await s.call("login");
    const code = r.text.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0];
    console.log(`CODE ${login}: ${code ?? "(none)"} :: ${r.text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  for (const [s, login] of [[A, admin], [B, member]]) {
    const r = await waitFor(`${login} sign-in`, async () => {
      const st = (await s.call("status")).text;
      return { ok: new RegExp(`Signed in: @${login}`, "i").test(st), text: st };
    }, 15 * 60_000);
    step(`${login} signed in`, r.ok, r.ok ? "" : r.text);
    if (!r.ok) throw new Error("sign-in did not complete");
  }

  // 2. Team and invite.
  const teamName = `live-${Date.now().toString(36)}`;
  const created = await A.call("create_team", { name: teamName });
  step("admin creates team", !created.isError, created.text);
  const invited = await A.call("invite_member", { login: member });
  step("admin invites member", !invited.isError, invited.text);

  // 3. Member accepts; gets the team key from the admin automatically.
  const accepted = await B.call("accept_invite", { team: teamName });
  step("member accepts", !accepted.isError, accepted.text);
  const keyed = await waitFor("member key", async () => {
    const st = (await B.call("status")).text;
    return { ok: new RegExp(`Team: ${teamName}`).test(st) && !/waiting for a teammate/.test(st) && !/failed/i.test(st), text: st };
  }, 90_000, 3000);
  step("member has the team key and is connected", keyed.ok, keyed.text);

  // 4. Share, always-allow the admin (no dialogs in this client), ask.
  const shared = await B.call("share_session", { label: "scraper work" });
  step("member shares session", !shared.isError, shared.text);
  const trusted = await B.call("trust_peer", { peer: admin, allow: true });
  step("member always-allows admin", !trusted.isError, trusted.text);
  const listed = await waitFor("admin sees share", async () => {
    const t = (await A.call("list_peers")).text;
    return { ok: /scraper work/.test(t), text: t };
  }, 60_000, 3000);
  step("admin sees 'scraper work'", listed.ok, listed.text);
  const asked = await A.call(
    "ask_peer",
    { peer: member, question: "What does notes.md in your project say about why the scraper got fast? Quote the key numbers.", timeout_sec: 300 },
    330_000,
  );
  step("answer comes back from the member's session", !asked.isError && /worker pool|keep-alive|32/i.test(asked.text), asked.text);
  step("answer is attributed to the member's GitHub login", new RegExp(member, "i").test(asked.text), asked.text.slice(0, 120));

  // 5. Remove the member: rotation, member locked out.
  const removed = await A.call("remove_member", { login: member, confirmed: true }, 120_000);
  step("admin removes member (and rotates)", !removed.isError && !/could not be rotated/i.test(removed.text), removed.text);
  const roster = await A.call("team");
  step("roster shows a new key epoch and no member", !new RegExp(`@?${member}\\b`, "i").test(roster.text.split(/log|Log/)[0]) && /epoch\D*2|key epoch\D*2/i.test(roster.text), roster.text);
  const locked = await waitFor("member locked out", async () => {
    const st = (await B.call("status")).text;
    return { ok: /removed|not in|no longer|not a member/i.test(st) || !new RegExp(`Team: ${teamName} \\(`).test(st), text: st };
  }, 60_000, 3000);
  step("member is told they were removed / disconnected", locked.ok, locked.text);
  const after = await A.call("ask_peer", { peer: member, question: "still there?", timeout_sec: 20 }, 40_000);
  step("member can no longer be asked", after.isError, after.text);
} catch (e) {
  step("run", false, e.message);
} finally {
  A.stop();
  B.stop();
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `FAIL (${failed} step${failed === 1 ? "" : "s"}; work dir ${WORK})` : "ALL PASS");
  process.exit(failed ? 1 : 0);
}
