import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { signInTestUser } from "./helpers/signin.js";
import { startTestRelay } from "./helpers/worker.js";

const LEGACY = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "legacy-relay", "wrangler.jsonc");

/**
 * The live relay already holds 0.6.0 data, whose `invites` (Team) and `teams` (Users) tables have no
 * invited_by column. A fixture worker with the same name, classes and migrations writes rows with the
 * 0.6.0 table definitions; the current relay then starts on that same storage, as a deploy would.
 */
describe("upgrading a relay that has 0.6.0 team data", () => {
  it("adds the invited_by columns, keeps old rows (inviter unknown) and works as before", async () => {
    const persist = await mkdtemp(join(tmpdir(), "mindmeld-relay-upgrade-"));
    try {
      const teamId = "0123456789abcdef";
      const admin = { uid: 777001, login: "upgrade-admin" };
      const invitee = "upgrade-bob";

      // Without the LEGACY_FIXTURE binding the fixture refuses everything (it must never act as a relay).
      const locked = await startTestRelay({ config: LEGACY, persist });
      try {
        expect((await fetch(`${locked.url}/seed`, { method: "POST", body: "{}" })).status).toBe(404);
      } finally {
        await locked.stop();
      }

      const old = await startTestRelay({ config: LEGACY, persist, vars: { LEGACY_FIXTURE: "1" } });
      try {
        const res = await fetch(`${old.url}/seed`, {
          method: "POST",
          body: JSON.stringify({ teamId, name: "core", adminUid: admin.uid, adminLogin: admin.login, invitee }),
        });
        expect(res.status).toBe(200);
        // The seeded tables really have the old shape.
        expect(await res.json()).toEqual({ invites: ["login"], teams: ["team_id", "name", "role"] });
      } finally {
        await old.stop();
      }

      const relay = await startTestRelay({ persist });
      try {
        const call = async (token: string, method: string, path: string, body?: unknown) => {
          const r = await fetch(`${relay.url}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          return { status: r.status, body: await r.json().catch(() => null) };
        };
        const alice = await signInTestUser(relay, admin.login, admin.uid);
        const bob = await signInTestUser(relay, invitee);
        const carol = await signInTestUser(relay, "upgrade-carol");

        // Old rows: the inviter is unknown (null), nothing crashes.
        expect((await call(bob.token, "GET", "/v1/teams")).body).toEqual([{ teamId, name: "core", role: "invited", invitedBy: null }]);
        const r = await call(alice.token, "GET", `/v1/teams/${teamId}`);
        expect(r.status).toBe(200);
        expect(r.body.invites).toEqual([invitee]);
        expect(r.body.inviteDetails).toEqual([{ login: invitee, invitedBy: null }]);
        expect((await call(alice.token, "GET", "/v1/teams")).body).toEqual([{ teamId, name: "core", role: "admin" }]);

        // New invites on the upgraded tables record the inviter.
        expect((await call(alice.token, "POST", `/v1/teams/${teamId}/invites`, { login: carol.login })).status).toBe(200);
        expect((await call(carol.token, "GET", "/v1/teams")).body).toEqual([{ teamId, name: "core", role: "invited", invitedBy: admin.login }]);
        expect((await call(alice.token, "GET", `/v1/teams/${teamId}`)).body.inviteDetails).toEqual([
          { login: invitee, invitedBy: null },
          { login: carol.login, invitedBy: admin.login },
        ]);

        // The old invite can still be accepted, and one can be cancelled.
        expect((await call(bob.token, "POST", `/v1/teams/${teamId}/accept`)).status).toBe(200);
        expect((await call(bob.token, "GET", "/v1/teams")).body).toEqual([{ teamId, name: "core", role: "member" }]);
        expect((await call(alice.token, "DELETE", `/v1/teams/${teamId}/invites/${carol.login}`)).status).toBe(200);
        expect((await call(carol.token, "GET", "/v1/teams")).body).toEqual([]);
      } finally {
        await relay.stop();
      }

      // A second start on upgraded tables (column already there) is fine too.
      const again = await startTestRelay({ persist });
      try {
        const alice = await signInTestUser(again, admin.login, admin.uid);
        const r = await fetch(`${again.url}/v1/teams/${teamId}`, { headers: { authorization: `Bearer ${alice.token}` } });
        expect(r.status).toBe(200);
        expect((await r.json()).members.map((m: any) => m.login).sort()).toEqual([admin.login, invitee].sort());
      } finally {
        await again.stop();
      }
    } finally {
      await rm(persist, { recursive: true, force: true });
    }
  }, 120_000);
});
