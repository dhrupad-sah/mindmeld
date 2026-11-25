# mindmeld

Let your Claude Code session ask your teammate's Claude Code session a question, and get the answer back without copy-paste.

```
you:        "ask Sarim how they got the scraper so fast"
your Claude ──ask_peer──► relay ──► Sarim's Claude: "Dhrupad asks… [Accept] [Decline]"
your Claude ◄──answer──── relay ◄── read-only copy of Sarim's session: "We moved to a worker pool…"
```

The answer comes from a **read-only copy of the Claude session your teammate has open**. It knows what they built and why, and their live session isn't touched.

## Setup (each of you, once)

```sh
claude plugin install mindmeld --marketplace dhrupad-sah/mindmeld
```

Restart Claude Code afterwards. The server is bundled into the plugin, so there's nothing else to download. The only requirement is Node 20+.

<details><summary>Without the plugin</summary>

```sh
npm install -g mindmeld-mcp
claude mcp add -s user mindmeld -- mindmeld mcp
```
</details>

## Teams (GitHub sign-in)

A team is a group of people who sign in with GitHub. Each machine gets its own key pair, the team has a roster with admins and members, and an admin can remove someone for real: their devices are cut off and the team key is replaced, so they can't read anything sent afterwards. (Legacy groups below can't do that.) Teams need the hosted relay or your own relay running the 0.6 Worker. To use your own for teams, sign in with `mindmeld login --relay wss://your-relay` (or set `"teamRelay"` in `~/.mindmeld/config.json`); environment variables never change where your GitHub sign-in goes.

1. **Sign in, everyone, once:** `/mindmeld:login`. Claude shows a code and a link. Open the link, enter the code, approve on GitHub. Sign-in finishes on its own and `/mindmeld:status` shows who you are. It lasts 7 days, then you sign in again.
2. **Create a team (an admin):** `/mindmeld:team create core`. You're its first admin and this machine is connected to it.
3. **Invite by GitHub username:** `/mindmeld:team invite sarim-dev`. Claude gives you a short message to send them.
4. **They sign in and accept:** they install the plugin, run `/mindmeld:login`, then `/mindmeld:team accept core`. `/mindmeld:team accept` on its own joins nothing: it lists their pending invites and who sent each one. Their machine gets the team key the next time a teammate is online. `/mindmeld:status` shows "waiting" until then.
5. **Share a session:** `/mindmeld:share scraper work`, same as before. Sessions stay private until you do this.
6. **Ask:** *"ask sarim-dev how they got the scraper so fast"*. Approval dialogs, the read-only fork and "always allow" work as described below.

`/mindmeld:team` on its own shows the members, roles, pending invites (and who sent them), and each device's key fingerprint and whether it has the team key. `/mindmeld:team role <login> admin|member` changes a role. `/mindmeld:team uninvite <login>` cancels a pending invite (admins only).

**Removing someone:** `/mindmeld:team remove sarim-dev` (admins only). A dialog asks you to confirm. Then their devices are disconnected right away and the team key is rotated for everyone left. They keep whatever they already received, but not anything sent after.

The relay learns team names, members' GitHub logins, roles, device public keys and who is connected. It never sees team keys or message content. One thing to know: the relay hands out the public keys, so a malicious relay could swap one. If that matters to you, compare fingerprints from `/mindmeld:team` with your teammates over another channel. Details, constructions and known gaps are in [`docs/security.md`](docs/security.md); it has not had an outside review yet.

## Legacy groups (invite codes)

Groups paired with an invite code still work and are unchanged. They have no accounts: everyone shares one secret, and names aren't verified.

### Connecting a legacy group

- **You:** `/mindmeld:invite` (or just say *"invite a teammate to mindmeld"*). Claude gives you a code like `k7q2-9xmd-4tpa` and a message to send. The code works once and expires in 15 minutes.
- **Them:** `/mindmeld:join k7q2-9xmd-4tpa`. Connected.

Joining exposes nothing. **Every session is private until you share it:**

- **Them, in the session that has the answers:** `/mindmeld:share scraper work`. The group can now see "scraper work" and ask it questions. They see your name, that label and when the session was last active. Never your prompts, files or transcript.
- `/mindmeld:stop` makes it private again. Closing the session does too.
- `/mindmeld:leave` leaves the group entirely. Every session on this machine disconnects and the pairing is deleted, after a confirmation. To reconnect you'll need a new invite.
- `/mindmeld:peers` lists the sessions people are sharing. `/mindmeld:status` shows whether you're connected, whether this session is shared, who's "always allowed", and every recent question in and out.

## Use

*"Ask Sarim how they set up the auth middleware."* Your Claude shows progress as it happens: delivered → approved → writing the answer. If Sarim's session doesn't acknowledge the question within 15 seconds, you're told right away instead of waiting.

On Sarim's side, in the session they shared, Claude Code shows a dialog:

```
MCP server mindmeld requests your input
Dhrupad asks your shared session "scraper work":
How did you set up the auth middleware?
Answer with a read-only copy of this session? You'll see the answer before it's sent.
(To skip these prompts for Dhrupad, tell Claude "always allow Dhrupad".)
  Accept   Decline
```

Sarim presses Enter, a read-only copy of that session writes the answer, and a second dialog shows the draft. Another Enter sends it to your Claude. Telling Claude *"always allow Dhrupad"* skips both dialogs for Dhrupad from then on. *"stop allowing Dhrupad"* turns that off.

If Sarim shares several sessions, the question goes to the one used most recently. Every question, including ones answered automatically, is logged in `/mindmeld:status`.

## Tools Claude gets

| tool | what it does |
|---|---|
| `invite_peer` / `join_peer` | pair with a teammate |
| `share_session` / `stop_sharing` | make this session visible and askable, or private again |
| `status` | connection, sharing state, trusted people, recent questions |
| `leave_group` | leave the group and disconnect every session on this machine |
| `trust_peer` | always allow, or stop allowing, someone's questions |
| `list_peers` | sessions teammates are sharing |
| `ask_peer` | ask a question; blocks until the answer arrives |
| `share_snippet` / `read_inbox` | send or receive code and notes, no reply needed |

### Removing someone from a group

Everyone in a group shares one key, so you can't remove one person on their own. Instead, the rest of you run `/mindmeld:leave` and pair again with a fresh `/mindmeld:invite`. That creates a new key the removed person doesn't have.

## Terminal commands (optional)

Everything above works from inside Claude. The CLI is there for scripts and servers:

```sh
mindmeld pair / join <code>     # pair from a terminal instead
mindmeld up --auto-approve      # an always-on answerer for a project (no dialogs; trusted groups only)
mindmeld leave                  # leave your group (asks to confirm; -y to skip)
mindmeld sessions               # list Claude sessions in this directory
mindmeld relay                  # self-host a relay
```

## Relay

By default, both sides connect to a hosted relay (a Cloudflare Worker, source in [`relay-worker/`](relay-worker/)). It only passes along encrypted frames and stores nothing. To run your own, use `mindmeld relay --port 8787` on any reachable machine, or deploy `relay-worker/` to your own Cloudflare account. Then pass `--relay ws://host:8787` to `pair` and `join`, or set `MINDMELD_RELAY` (invite-code groups only; teams use `mindmeld login --relay`, see above).

## Safety model

This section describes legacy groups. For teams, see [`docs/security.md`](docs/security.md).

- **Pairing via a PAKE handshake.** Invite codes run SPAKE2 over ristretto255. The relay sees only the first 4 characters (a rendezvous id), never the password part. Someone watching, including the relay operator, can't guess the code offline. An attacker gets one live guess, and a wrong guess burns the invite.
- **End-to-end encrypted.** Pairing hands each member a random 256-bit group secret. Every message is sealed with AES-256-GCM using a key derived from that secret. The relay only sees a room hash and ciphertext, and stores nothing.
- **Private by default.** A session is invisible to your group until you run `/mindmeld:share` in it. Sharing reveals only your name, the label you chose and a last-active time. Asking never reveals anything: askers aren't listed at all.
- **A sandboxed, read-only fork.** Answers come from a copy of the shared session that can only `Read` and `Glob` files **inside that project**. Reads outside it are denied by Claude Code's permission system, and so are `.env*`, keys, `*.pem` and credential files inside it. The fork has no Bash, Grep, edits, web, Chrome or MCP servers. Your own settings are not loaded, so your allow rules can't widen any of this. Forks are never saved as sessions.
- **You approve.** By default you see every question and every draft answer before it leaves your machine.
- **Replies are fenced.** Answers reach the asking Claude wrapped in `<peer_reply untrusted="true">` with an instruction to treat them as data.
- **Rate limited.** At most 10 questions per peer per 10 minutes.
- **Local API.** The daemon binds to `127.0.0.1`, and every request needs a random bearer token stored in `~/.claude-share/daemon.json` (mode 600).

- **Names aren't authenticated within a group.** Anyone you've paired with holds the group secret and could claim another member's name. "Always allow" trusts a name, so only pair with people you'd trust with any of the group's names.

Known limits: the relay can see who's online, when, and how much data moves (not the content). Session labels come from Claude Code's on-disk transcript layout, which isn't a documented API.

## Roadmap

Hosted relay on Cloudflare Durable Objects · mDNS LAN discovery · push questions into a live session (Claude Code channels) · remove a member from a group (rotate the secret).

## Development

```sh
npm install
npm test        # crypto, SPAKE2, pairing, sessions, end-to-end (real relay, daemons, stub claude)
npm run build
```

Design doc: [`docs/superpowers/specs/2026-10-27-claude-share-design.md`](docs/superpowers/specs/2026-10-27-claude-share-design.md)

MIT licensed.

## Upgrading

- **From claude-share 0.2:** your pairing carries over automatically (`~/.claude-share` is copied to `~/.mindmeld`). Install the plugin, remove the old entry with `claude mcp remove claude-share`, and stop running `claude-share up`, since Claude itself is now the client.
- **From claude-share 0.1:** pairing changed, so pair again with `/mindmeld:invite` and `/mindmeld:join`.
