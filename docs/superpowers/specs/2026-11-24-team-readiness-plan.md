# mindmeld: team-readiness plan (2026-11-24)

Context: Dhrupad's company leadership is interested. The bar moves from "works for two friends"
to "a team can adopt it and pass a security review". Scope is the eight items Dhrupad picked
from the 2026-11-24 PM review. Each item below covers what we know, the design, the decisions,
the risks and what "done" means. The build order is at the end.

---

## 1. Questions wait for people who are away (async)

**Problem.** A question only works if the answerer has a shared session open *and* is at the
keyboard. Otherwise it fails after 15 s. Slack beats that.

**What we know**
- The relay is a Durable Object per room. SQLite-backed storage is available on the free plan,
  so the relay can keep encrypted messages until someone comes back.
- Today a question is addressed to a *session* (peer id). A session that's gone can't receive
  it later, so a waiting question must be addressed to a *person* (needs item 3, identity).

**Design**
- `ask_peer` to someone who isn't online, or who doesn't acknowledge: the question is stored,
  encrypted, in the relay's mailbox for that person (7-day expiry). The asker gets "queued:
  you'll see Sarim's answer in /mindmeld:inbox".
- When the person next opens Claude Code, the mailbox is delivered to that session. A dialog
  appears: "Dhrupad asked yesterday about *scraper work*: answer from this session?" If the
  session isn't shared, they see a notice in `/mindmeld:status` instead, and nothing is answered.
- The answer goes to the asker's mailbox. The asker sees it in their next session through
  `/mindmeld:inbox`, and `status` shows the count of new answers.
- The relay stores only ciphertext addressed to a member id, with no question text.

**Decision needed:** when an away person returns, should the question go to *any* session they
open, or only to a session shared under the label the asker picked? Recommendation: offer it in
whichever session they share first, and show the label the asker picked.

**Risks:** stale context (they answer days later from a session that has moved on). Mitigation:
the dialog shows when the question was asked.

**Done when:** you ask while Sarim is offline, Sarim opens Claude Code an hour later and
approves, and the answer shows up in your next session. Plus an e2e test with a fake clock for
expiry.

---

## 2. Getting started without coordinating

**Problem.** Install, restart, both online within the same 15-minute invite window, share every
session again each time it starts, and only then ask.

**Design (depends on 3)**
- **Invite by GitHub username:** `/mindmeld:invite @sarim`. No code and no time window. The
  invite waits on the relay until Sarim signs in with GitHub, and accepting it is one dialog.
  Codes stay available for people without GitHub.
- **Share by project, remembered:** "always share sessions in this project as *scraper*",
  stored per project in `~/.mindmeld/projects.json`. New sessions in that folder share
  automatically, and `/mindmeld:status` says so. Private remains the default for every other
  folder.
- **No restart after install:** check whether Claude Code picks up a plugin's MCP server
  without a restart (it may need `/mcp` reconnect). Document the shortest path either way.

**Done when:** a new teammate goes from install to their first answered question in under
2 minutes, with neither person waiting on the other. Time it on a fresh machine.

---

## 3. Team-grade identity and admin (the big one)

**Problem.** One shared group key, no login, no admin, no audit, and names that can be faked.
Nobody can be removed, and the relay runs on a personal Cloudflare account.

**What we know**
- GitHub's device flow lets a terminal tool sign someone in with only the app's public client
  id (no secret shipped). The user opens github.com/login/device and enters a short code. The
  relay can confirm who they are by calling `api.github.com/user` with that token.

**Design**
- **Identity:** `mindmeld login` (or the first `/mindmeld:invite` or `:join`) runs the GitHub
  device flow. The relay checks the token once, issues a mindmeld session token, and throws the
  GitHub token away.
- **Per-member keys:** each machine creates an X25519 key (encryption) and an Ed25519 key
  (signing), registered with the relay under the person's GitHub login. Every message is signed,
  so names can't be faked.
- **Team key, wrapped per member:** the team's symmetric key is encrypted separately to each
  member's public key. **Removing someone** = an admin removes them, the client creates a new
  team key and wraps it for the remaining members, and the relay drops the removed member's
  connections. They keep nothing that decrypts future traffic.
- **Roles:** the team creator is admin. Admins invite, remove and promote. `/mindmeld:team`
  lists members, roles and key fingerprints.
- **Audit:** each client keeps a local log of every question in and out, answered or not (this
  extends `activity.jsonl`). The relay keeps a membership log: joined, removed, key rotated.
  Message content is never logged.
- **Hosting:** keep the relay deployable to *the company's own* Cloudflare account
  (`relay-worker/` plus a short guide), with the GitHub app owned by the company. The public
  hosted relay stays for individuals.

**Tradeoffs to tell security reviewers up front**
- The relay will know team membership (GitHub logins) and who's online. Today it knows
  nothing. Content stays end-to-end encrypted.
- The relay hands out public keys, so a malicious relay could swap them. Mitigation: show key
  fingerprints in `/mindmeld:team` for out-of-band checks. Later option: pin keys to members'
  GitHub SSH keys.
- The protocol code (SPAKE2 today, key wrapping next) is custom and needs an external review
  before a company relies on it.

**Decisions needed:** GitHub login, or the company's SSO (Google Workspace/Okta)? Who hosts the
relay for the company pilot?

**Done when:** an admin creates a team, invites two people by username, removes one, and the
removed person can't decrypt anything sent afterwards (test). The README's security section is
rewritten for a reviewer.

---

## 4. Update warnings

**Problem.** Old clients keep running. Dhrupad ran 0.3.1, which had the privacy bug, for weeks.

**Design**
- The client sends its version when it connects (`?v=0.5.0`). The relay replies with
  `{t:"server", latest, minimum}`.
- Below `minimum`, the relay refuses the connection with a clear message: "mindmeld 0.3.1 is no
  longer supported: run claude plugin update mindmeld@mindmeld". `/mindmeld:status` and the
  first tool call in a session show the same text.
- Below `latest`: `/mindmeld:status` shows "update available". Once per session, Claude
  mentions it after a mindmeld tool runs.
- Set `minimum` to 0.4.0 straight away, which closes the 0.3 privacy hole for everyone.
- Check whether Claude Code can auto-update plugins from a marketplace, and document it if so.

**Done when:** a 0.3.1 client is refused with that message, and a 0.4.x client sees "update
available".

---

## 5. Measurement without reading content

**Problem.** We don't know how many teams exist, or whether questions get answered.

**What we know:** the relay can't see message types today, because they're inside the
encryption.

**Design**
- Add a coarse plaintext *kind* to the envelope (`presence`, `ask`, `answer`, `decline`,
  `status`). That costs a little metadata. Document it.
- Cloudflare Workers Analytics Engine records, per event: kind, a hashed team id, client
  version, OS and day. Never content or names.
- A small `/stats` page for us: active teams, daily active people, questions asked, answered,
  declined and expired, median time to answer, and the version mix.
- With item 3 in place, the relay also knows member counts per team.

**Done when:** the dashboard shows real numbers from a two-person test, and the README says
exactly what's collected.

---

## 6. Cheaper presence (without making it worse)

**Problem.** Each connected session sends a "hello" every 20 s. That's about 4,300 relay
messages a day per session even when nothing happens, and it's what fills the relay's metrics.

**What we know**
- Incoming WebSocket messages are billed at 1/20th of a request. WebSocket *protocol pings*
  aren't billed at all. The free plan allows 100k requests a day, and going over makes
  operations fail. So today's load is probably only ~1–2% of the limit, but it grows linearly
  with sessions.

**Design**
- The relay already knows when sockets connect and close, so it announces joins and leaves
  itself. With item 3 it knows which member each socket is.
- A client sends its encrypted "hello" (label, last-active time) only when something changes:
  connecting, sharing, a label change, or activity more than 5 minutes newer than the last one
  sent. Newcomers ask existing peers for their hellos once.
- Liveness: the client sends WebSocket protocol pings every 60 s (free), so half-open
  connections are detected.

**Why it doesn't make the product worse:** presence updates arrive *faster* (the instant a
socket closes, instead of after up to 60 s). The only change is that "last active" is accurate
to 5 minutes instead of 20 seconds, and the only thing that uses it is choosing between several
shared sessions of the same person.

**Done when:** an idle connected session generates fewer than 100 relay messages a day, and the
routing and presence tests still pass.

---

## 7. Windows

**What could break (from reading the code)**
- `spawn("claude")`: on Windows an npm-installed Claude is `claude.cmd`, which needs a shell to
  run. The native installer's `claude.exe` doesn't.
- The session folder encoding (`C:\Users\…` → `C--Users-…`). It's probably right, since the
  same rule replaces every non-alphanumeric character, but that needs verifying on Windows.
- `chmod 600` does nothing on Windows, so the config file's privacy relies on the user profile's
  access controls. Document that.
- Path and quoting in the `--mcp-config '{"mcpServers":{}}'` argument when a shell is used.
- The plugin's `node ${CLAUDE_PLUGIN_ROOT}/…` command when the path contains spaces.

**Plan**
- Add GitHub Actions CI on ubuntu, macOS and Windows: typecheck, unit and e2e tests, the bundle
  test, and the sessions-folder encoding test. There's no CI today.
- Fix the `spawn` (resolve `claude.cmd` or `claude.exe`, quoting safely).
- **One real test on a Windows machine with Claude Code signed in** (CI can't sign in). Needs a
  Windows laptop or VM from someone at the company.

**Done when:** CI is green on all three platforms, and the manual Windows run completes
invite → join → share → ask → answer.

---

## 8. README and demo GIF

**Plan (do this last, after the flows above settle)**
- The first screen: one sentence, a 20–30 s GIF (ask in one session → dialog in the other →
  answer comes back), and the one-line install.
- Record the real two-session flow with the existing test scripts. Use `vhs` for repeatable
  takes (not installed: `brew install vhs`), or a screen recording converted with
  `ffmpeg`/`gifski`. Keep it under 2 MB.
- Move the security model, CLI and self-hosting into `docs/`. Add a short "for security
  reviewers" page (from item 3).

**Done when:** a stranger can tell what it does from the first screen and install it in one
command.

---

## Build order

| Phase | Items | Why this order | Rough size |
|---|---|---|---|
| **0. Protect current users** | 4 updates, 6 presence, 7 Windows CI | Small, independent, and stops the 0.3 privacy hole now | 2–3 days |
| **1. Identity and teams** | 3 | Everything else needs "a person" instead of "a session" | 1.5–2 weeks |
| **2. Async questions** | 1 | Needs member addresses and mailboxes from phase 1 | 4–5 days |
| **3. Onboarding** | 2 | Invites by username need identity; remembered sharing is quick | 3 days |
| **4. Measurement** | 5 | Envelope kinds settle once the protocol changes are done | 2 days |
| **5. Windows and polish** | 7 manual pass, 8 README and GIF | Record the demo once the UX is final | 2–3 days |

That's about 4–5 weeks of focused work. Protocol v3 (identity) won't be compatible with 0.4
clients. The `minimum` version from item 4 handles the cutover with a clear message.

## Open decisions

1. **Login:** GitHub (fastest, matches teammate-sync) or the company's SSO?
2. **Relay hosting for the pilot:** the company's Cloudflare account, or keep mine for now?
3. **Away questions:** any session they open, or only a shared one with the asker's label?
4. **Security review:** who reviews the crypto before a company pilot: internal security, or an
   outside reviewer?
