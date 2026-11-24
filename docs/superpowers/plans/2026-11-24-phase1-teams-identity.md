# Phase 1: Teams and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teams where every member signs in with GitHub, every device has its own keys, names can't be faked, admins can remove someone, and that person can't read anything sent afterwards.

**Architecture:**
- **Relay:** the Cloudflare Worker gets an authenticated API.
  - `/v1/auth/*`: swaps a GitHub token for a short mindmeld token.
  - `/v1/teams/*`: one Durable Object per team holds the roster, devices, wrapped team keys and the membership log, and hosts the team's WebSocket.
- **Clients:**
  - Each device holds an Ed25519 key for signing and an X25519 key for encryption.
  - Each team key epoch is a random 32-byte key, sealed separately to every member device.
  - Every frame is encrypted with the current epoch key and signed by the sending device.
  - Removing someone starts a new epoch.
- **Daemon:** gets a `Channel` abstraction, so question/answer logic runs unchanged over the existing secret-based groups ("legacy groups") and the new teams.

**Tech Stack:** TypeScript, Node ≥ 20, `@noble/curves` (ed25519, x25519), `@noble/hashes`, Node `crypto` (AES-256-GCM, HKDF), Cloudflare Workers + Durable Objects (SQLite), wrangler `unstable_startWorker` for tests, vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-team-readiness-plan.md` (item 3; decisions section)

## Global Constraints

- **Sign-in:** GitHub only, via OAuth device flow. Only the public client id ships in code. The GitHub token is never stored by client or relay after the swap.
- **Relay hosting:** Dhrupad's Cloudflare account (`account_id` 7ed5d8cfe91c1eb8e81711afaea457e0), worker `claude-share-relay`.
- **Relay visibility:** the relay may know team names, member GitHub logins, roles, device public keys and who's connected. It must never see team keys or message plaintext.
- **Legacy groups:** existing secret-based groups and the 0.5 protocol keep working unchanged. Teams are additive.
- **Version:** 0.6.0. Relay `MIN_VERSION` stays 0.5.0.
- **Local key file:** device private keys live in `~/.mindmeld/identity.json`, mode 600, never sent anywhere.
- **Copy rules (from earlier reviews):**
  - Every invite, removal and key change is visible in `/mindmeld:team` and the membership log.
  - No silent failures: any blocked state says what the person is waiting for.
- **Crypto review:** deferred. `docs/security.md` lists every custom construction for the reviewer.

## Review Focus

1. **Removed member, frames in flight:** a removed member's socket is closed, and frames sealed with the new epoch are unreadable to them, including frames from a client that hadn't yet seen the rotation. → Task 7 test `removed member cannot read frames after rotation`.
2. **Invite while nobody else is online:** the invitee joins, but no member is online to seal the team key to their device. Status must say "waiting for a teammate to come online to give this device the team key", and it must resolve automatically when one does. → Task 8 test `pending device gets the key when a member comes online`.
3. **Expired mindmeld token mid-session:** the client re-authenticates silently from the stored refresh grant, or shows "sign in again", and never gives a silent "nobody online". → Task 4 test `expired token is refreshed`, Task 9 status copy.
4. **One person, several devices:** a laptop and a desktop are both sealed the key. Removing the person removes all their devices. → Task 5 test `removing a member drops all their devices`.
5. **Frame from a device not in the roster, or with a bad signature:** dropped and counted, never shown as a message from anyone. → Task 3 test `rejects forged sender`, Task 7 test `forged frame is dropped`.

---

### Task 0: GitHub OAuth app and relay secrets (Dhrupad and Claude together)

**Files:**
- Modify: `relay-worker/wrangler.jsonc` (vars `GITHUB_CLIENT_ID`, `GITHUB_API_BASE`)
- Create: `src/auth/config.ts`

- [ ] **Step 1:** Dhrupad creates a GitHub OAuth App at github.com/settings/developers:
  - name "mindmeld"
  - homepage `https://github.com/dhrupad-sah/mindmeld`
  - callback URL `https://github.com/dhrupad-sah/mindmeld` (unused by device flow)
  - **Enable Device Flow**: checked

  Claude records the client id.
- [ ] **Step 2:** In `src/auth/config.ts`, export `GITHUB_CLIENT_ID = "<id>"` and `GITHUB_DEVICE_SCOPE = "read:user"`.
- [ ] **Step 3:** Generate a random signing key for mindmeld tokens:

  ```
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > key.tmp
  npx wrangler secret put TOKEN_SIGNING_KEY < key.tmp && rm key.tmp
  ```

  Add `"GITHUB_API_BASE": "https://api.github.com"` to vars.
- [ ] **Step 4:** Commit `feat(auth): GitHub OAuth client id and relay auth config`.

### Task 1: Device identity keys

**Files:**
- Create: `src/identity.ts`
- Test: `test/identity.test.ts`

**Interfaces:**
- Produces:
  - `interface DeviceIdentity { deviceId: string; signPub: string; signPriv: string; boxPub: string; boxPriv: string }` (hex strings; `deviceId` = first 16 hex chars of sha256(signPub))
  - `loadOrCreateIdentity(): DeviceIdentity` (reads or writes `identity.json` in `homeDir()`, mode 600)
  - `fingerprint(signPub: string): string` (groups of 4 hex chars, first 16 bytes of sha256, like `a1b2 c3d4 …`)

- [ ] **Step 1:** Write tests:
  - `creates once and reuses`: two calls with the same `MINDMELD_HOME` return equal `deviceId`.
  - `file is mode 600`: `statSync(...).mode & 0o777` is `0o600` (skip on win32).
  - `fingerprint is stable and 8 groups`: matches `/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/`.
- [ ] **Step 2:** Run `npx vitest run test/identity.test.ts`. Expect FAIL (module missing).
- [ ] **Step 3:** Implement with `ed25519.utils.randomSecretKey()` / `ed25519.getPublicKey` and `x25519.utils.randomSecretKey()` / `x25519.getPublicKey` from `@noble/curves/ed25519.js`.
- [ ] **Step 4:** Run the tests. Expect PASS.
- [ ] **Step 5:** Commit `feat: per-device identity keys`.

### Task 2: Team crypto primitives

**Files:**
- Create: `src/teamcrypto.ts`
- Test: `test/teamcrypto.test.ts`

**Interfaces:**
- Consumes: `DeviceIdentity` (Task 1)
- Produces:
  - `sealToDevice(boxPub: string, plaintext: Uint8Array): string`: ephemeral X25519 → shared secret → `HKDF-SHA256(shared, salt = ephPub‖boxPub, info "mindmeld/seal/v1", 32)` → AES-256-GCM. Output base64(ephPub ‖ nonce ‖ ct ‖ tag).
  - `openFromDevice(id: DeviceIdentity, sealed: string): Uint8Array | null`
  - `sealFrame(epoch: number, teamKey: Uint8Array, id: DeviceIdentity, payload: string): TeamFrame`, where `TeamFrame = { e: number; dev: string; d: string; sig: string }`:
    - `d` = AES-GCM(teamKey, payload) with AAD = `"mindmeld/frame/v1|" + epoch + "|" + deviceId`
    - `sig` = Ed25519(signPriv, utf8(`epoch|dev|d`))
  - `openFrame(f: TeamFrame, keys: Map<number, Uint8Array>, roster: Map<string, { login: string; signPub: string }>): { login: string; payload: string } | null`

- [ ] **Step 1:** Write tests:
  - `seal/open round trip`.
  - `open fails for a different device`.
  - `frame round trip returns sender login`.
  - `rejects forged sender`: `dev` changed to another roster device → null.
  - `rejects tampered d` → null.
  - `rejects unknown epoch` → null.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement. Reuse the `seal` / `open` AES-GCM helpers from `src/crypto.ts`, extended with an optional AAD parameter, rather than writing new ones.
- [ ] **Step 4:** Run them. Expect PASS. Also run the full suite, since `crypto.ts` changed.
- [ ] **Step 5:** Commit `feat: team crypto (sealed key delivery, signed frames)`.

### Task 3: Relay test harness on the real Worker

**Files:**
- Create: `test/helpers/worker.ts`, `test/helpers/github-mock.ts`
- Modify: `relay-worker/wrangler.jsonc` (a `test` env)
- Test: `test/worker-harness.test.ts`

**Interfaces:**
- Produces:
  - `startTestRelay(): Promise<{ url: string; wsUrl: string; github: GithubMock; stop(): Promise<void> }>`: runs `relay-worker/src/index.ts` through wrangler `unstable_startWorker` with:
    - `GITHUB_API_BASE` pointing at the mock
    - a fixed `TOKEN_SIGNING_KEY`
    - local Durable Object storage
  - `GithubMock.addUser(login: string): string`: returns a fake GitHub token that the mock's `GET /user` accepts.

- [ ] **Step 1:** Write test `harness serves the relay`: `fetch(url)` returns text containing "mindmeld relay".
- [ ] **Step 2:** Implement. The GitHub mock is a `node:http` server answering `GET /user` with `{ login }` for known bearer tokens and 401 otherwise.
- [ ] **Step 3:** Run it. Expect PASS.
- [ ] **Step 4:** Commit `test: run the real Worker in tests`.

### Task 4: Sign-in (relay `/v1/auth`, client device flow)

**Files:**
- Modify: `relay-worker/src/index.ts`
- Create: `relay-worker/src/auth.ts`, `src/auth/github.ts`, `src/auth/session.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- **Relay:**
  - `POST /v1/auth/github` with `{ githubToken, device: { deviceId, signPub, boxPub } }`:
    - Calls `${GITHUB_API_BASE}/user`.
    - On success returns `{ login, token, expiresAt }`. `token` = `base64url(json{login, deviceId, exp})` + "." + HMAC-SHA256(TOKEN_SIGNING_KEY), valid 7 days.
    - Records the device under the login in the `Users` Durable Object (one per login).
    - On GitHub 401 returns 401 `{ error: "github sign-in failed" }`.
  - `verifyToken(token, env): { login: string; deviceId: string } | null`
- **Client:**
  - `deviceFlowLogin(opts: { clientId: string; onCode(userCode: string, verificationUri: string): void; fetchImpl?: typeof fetch; githubBase?: string }): Promise<string>`: returns the GitHub token and honours `interval` and `slow_down`.
  - `exchange(relayHttp: string, githubToken: string, id: DeviceIdentity): Promise<Session>`
  - `interface Session { login: string; token: string; expiresAt: number }`, stored in `homeDir()/session.json`, mode 600.
  - `loadSession(): Session | null` returns null when expired.

- [ ] **Step 1:** Write tests against the harness:
  - `exchange returns login and a token the relay accepts`
  - `bad github token is rejected with 401`
  - `expired token is refused` (`GET /v1/me` with an `exp` in the past → 401)
  - `deviceFlowLogin polls until granted`: the mock returns `authorization_pending`, then `slow_down`, then a token, and the test asserts the second wait grew by 5 s, using fake timers.
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement. Add `GET /v1/me` returning `{ login, deviceId }` for a valid bearer token.
- [ ] **Step 4:** Run them. Expect PASS.
- [ ] **Step 5:** Commit `feat(auth): GitHub device-flow sign-in and relay tokens`.

### Task 5: Team roster and membership (Team Durable Object)

**Files:**
- Create: `relay-worker/src/team.ts`
- Modify: `relay-worker/src/index.ts` (route `/v1/teams/*`), `relay-worker/wrangler.jsonc` (binding `TEAMS`, class `Team`, migration tag `v2` `new_sqlite_classes: ["Team", "Users"]`)
- Test: `test/team-relay.test.ts`

**Interfaces:** all routes need a bearer token.
- `POST /v1/teams` `{ name }` → `{ teamId }`. The caller becomes `admin`. `teamId` = random 16 hex.
- `GET /v1/teams` → teams the caller belongs to or is invited to: `[{ teamId, name, role | "invited" }]`. Comes from the caller's `Users` Durable Object.
- `GET /v1/teams/:id` → `{ name, epoch, members: [{ login, role, devices: [{ deviceId, signPub, boxPub, hasKey: boolean }] }], invites: [login], log: [{ at, by, event, subject }] }`. Members only.
- `POST /v1/teams/:id/invites` `{ login }` (admin) → 200. Logs `invited`.
- `POST /v1/teams/:id/accept` (invited caller) → 200. Logs `joined` and adds the caller's current device.
- `POST /v1/teams/:id/devices` (member) adds the caller's current device if it's new, and logs `device-added`.
- `PUT /v1/teams/:id/keys` `{ epoch, wrapped: { [deviceId]: sealed } }` (member):
  - stores wrapped keys
  - rejects an epoch lower than the current one
  - a higher epoch is accepted from an admin only, and must cover every current device
- `GET /v1/teams/:id/keys` → `{ epoch, wrapped: string | null, epochs: { [n]: string } }` for the caller's device (current plus up to 2 previous epochs).
- `DELETE /v1/teams/:id/members/:login` (admin; can't remove the last admin) → `{ needsRotation: true }`:
  - removes all of that login's devices
  - closes their sockets
  - logs `removed`
- `POST /v1/teams/:id/roles` `{ login, role: "admin" | "member" }` (admin). Logs `role`.

- [ ] **Step 1:** Write tests:
  - `creator is admin`
  - `non-member gets 403 on roster`
  - `invite → accept adds member with device lacking key`
  - `member cannot invite`
  - `removing a member drops all their devices` (two devices for one login)
  - `cannot remove last admin`
  - `higher epoch from non-admin is refused`
  - `rotation must cover all current devices`
  - `log records invited, joined, removed in order`
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement with Durable Object SQLite tables `members(login, role)`, `devices(login, deviceId, signPub, boxPub)`, `keys(epoch, deviceId, sealed)`, `invites(login)`, `log(at, by, event, subject)` and a `meta(name, epoch)` row.
- [ ] **Step 4:** Run them. Expect PASS.
- [ ] **Step 5:** Commit `feat(relay): team roster, invites, roles, wrapped keys, membership log`.

### Task 6: Channel abstraction in the daemon

**Files:**
- Create: `src/channel.ts`
- Modify: `src/daemon.ts`
- Test: existing `test/e2e.test.ts` and `test/presence.test.ts` must still pass unchanged

**Interfaces:**
- Produces:
  - ```ts
    interface Channel extends EventEmitter {
      start(): void;
      stop(): Promise<void>;
      readonly connected: boolean;
      readonly server: ServerInfo | null;
      send(p: Payload): void;
    }
    ```
    It emits:
    - `"payload"` with `(p: Payload, from: { cid?: string; login?: string })`
    - `"joined"` with `(cid: string)`
    - `"left"` with `(cid: string)`
    - `"server"` / `"blocked"` with `(info)`
    - `"connected"` / `"disconnected"`
  - `class GroupChannel implements Channel` holds today's secret-based WebSocket code, moved out of `Daemon`.
  - `DaemonOptions` gains `channel?: Channel`. If it's absent, Daemon builds a `GroupChannel` from `secret` / `relay`.
  - When a channel provides `from.login`, Daemon uses it as the sender's name and ignores any `name` claimed inside the payload.
- [ ] **Step 1:** Move the code without behaviour changes. Then run `npm test`: all 43 tests pass, and the presence tests pass against both relays.
- [ ] **Step 2:** Commit `refactor: Channel abstraction under Daemon`.

### Task 7: Team channel (client side of the team WebSocket)

**Files:**
- Modify: `relay-worker/src/team.ts` (WebSocket at `GET /v1/teams/:id/ws`, bearer token required)
- Create: `src/teamchannel.ts`
- Test: `test/team-channel.test.ts`

**Interfaces:**
- **Relay:**
  - The socket is accepted only for a member device with the current key. Otherwise it closes with code 4003 and reason `"no team key yet"`.
  - The relay forwards `{ t:"msg", f: TeamFrame }` to other member sockets, stamped with `c` and `login`.
  - It sends `joined` / `left` with `{ c, login }`, and `server` with `{ latest, minimum, epoch }`.
  - When the roster changes, it sends `{ t:"roster" }` to all sockets.
- **Client:**
  - `class TeamChannel implements Channel` with `constructor(opts: { relayHttp: string; teamId: string; session: Session; id: DeviceIdentity })`:
    - fetches the roster and keys on start and on every `roster` event
    - seals with the current epoch
    - opens with `openFrame` against roster devices
    - emits `"payload"` with `from.login` taken from the verified signature, not from the relay's stamp
- [ ] **Step 1:** Write tests (harness, two signed-in fake users):
  - `members exchange payloads with verified login`
  - `forged frame is dropped`: a raw socket for a member sends a frame signed by a different device → no payload event
  - `removed member cannot read frames after rotation`:
    - A removes B and rotates.
    - A frame A sends afterwards fails to open with every key B holds.
    - B's socket is closed with code 4001.
  - `device without key gets 4003 and a clear reason`
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them. Expect PASS.
- [ ] **Step 5:** Commit `feat: team channel with signed, epoch-keyed frames`.

### Task 8: Key distribution and rotation (client)

**Files:**
- Create: `src/teamkeys.ts`
- Test: `test/teamkeys.test.ts`

**Interfaces:**
- `ensureTeamKeys(opts: { relayHttp; teamId; session; id }): Promise<"ok" | { waiting: string }>`
  - If this device has no key, it returns `{ waiting: "waiting for a teammate to come online to give this device the team key" }`.
  - For any roster devices with `hasKey: false`, it seals the current key to them and PUTs it. Any member holding the key can do this.
- `rotate(opts: { …same; reason: "removed" }): Promise<number>` (admin only) creates a new 32-byte key, seals it to every current device, PUTs it at `epoch + 1` and returns the new epoch.
- `TeamChannel` calls `ensureTeamKeys` on start and on every `roster` event. `removeMember` (Task 9) calls `rotate` right after the DELETE.
- [ ] **Step 1:** Write tests:
  - `first member creates epoch 1`
  - `pending device gets the key when a member comes online`:
    - B accepts while A is offline, so B is `waiting`.
    - A starts, so B's key appears.
    - B's channel connects.
  - `rotation after removal is readable by remaining devices only`
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run them. Expect PASS.
- [ ] **Step 5:** Commit `feat: automatic key delivery and rotation on removal`.

### Task 9: Claude-facing tools and CLI

**Files:**
- Modify: `src/mcp.ts`, `src/cli.ts`, `src/config.ts`
- Create: `plugin/commands/login.md`, `plugin/commands/team.md`
- Test: extend `test/bundle.test.ts`

**Interfaces:**
- **Config:** `config.json` gains `team?: { teamId: string; name: string }`. When `team` is set, the MCP server builds `Daemon` with a `TeamChannel`. Otherwise it uses `GroupChannel` as today.
- **MCP tools:**
  - `login`: device flow. It returns the code and URL text at once and finishes in the background. The next `status` shows "signed in as @x".
  - `create_team { name }`
  - `invite_member { login }` (admin): if the invitee hasn't installed mindmeld, the message to send says so.
  - `accept_invite { team? }`
  - `team`:
    - members with roles and devices
    - each device's fingerprint and whether it has the key
    - pending invites
    - the last 20 log entries
  - `remove_member { login }` (admin, after a confirmation dialog): DELETE, then `rotate`.
  - `set_role { login, role }`
- **`status`** gains these lines:
  - `Signed in: @login` or `Not signed in: run /mindmeld:login`
  - `Team: <name> (you're admin|member)`
  - the `waiting` text from Task 8 when it applies
- **Commands:** `/mindmeld:login` and `/mindmeld:team`.
- **CLI:** `mindmeld login`, `mindmeld team [create|invite|accept|remove|role]` mirror the tools.
- [ ] **Step 1:** Extend the bundle test: `team tools are listed` (login, create_team, invite_member, accept_invite, team, remove_member, set_role). Then run it. Expect FAIL.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run `npm test`. Expect PASS.
- [ ] **Step 4:** Commit `feat: team tools and CLI`.

### Task 10: Ship 0.6.0

**Files:**
- Create: `docs/security.md`
- Modify: `README.md`, versions (`package.json`, plugin manifests, `src/version.ts`), `relay-worker/wrangler.jsonc` (`LATEST_VERSION` 0.6.0)

- [ ] **Step 1:** Write `docs/security.md` for reviewers, covering:
  - what the relay knows (from Global Constraints)
  - each custom construction (`sealToDevice`, frame format with AAD and signature, epochs and rotation, token format, SPAKE2 for legacy groups)
  - trust in the relay for public-key distribution, with fingerprints as the mitigation
  - known gaps: no external review yet, the relay could hand out a wrong public key, and there's no forward secrecy within an epoch
- [ ] **Step 2:** README: a "Teams (GitHub sign-in)" section above legacy groups, with the four commands.
- [ ] **Step 3:** Run `npm test`, the Worker typecheck and CI. Then deploy the relay. Then run `python3 test/live/run-live.py` (legacy flow, which must still pass).
- [ ] **Step 4:** A live team check with two real sessions (manual or a `run-live.py --team` variant): sign in both, create a team, invite, accept, share, ask, answer, then remove and confirm the removed member is told and disconnected.
- [ ] **Step 5:** Commit, tag `v0.6.0`, push, and write GitHub release notes.
