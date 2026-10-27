# claude-share (`claude-share-mcp` on npm)

Let your Claude Code session ask your teammate's Claude Code session a question, and get the answer back without copy-paste.

```
you:        "ask Alex's Claude how they got the scraper so fast"
your Claude ──ask_peer──► relay ──► Alex's daemon ──► read-only fork of Alex's session
your Claude ◄──answer──── relay ◄── Alex approves ◄── "We batched requests in src/fetch.ts…"
```

The answer comes from a **headless fork of the session your teammate picked** in their project. It knows what they built and why, and their live session isn't touched.

## Quick start

One of you runs a relay. It can be a laptop on the same Wi-Fi, a VPS, or a machine on your Tailscale network:

```sh
npx claude-share-mcp relay --port 8787
```

Install (each of you):

```sh
npm install -g claude-share-mcp     # gives you the `claude-share` command
```

> The npm package is `claude-share-mcp`. Don't run `npx claude-share`: that's an unrelated package. Without a global install, use `npx -y claude-share-mcp <command>`.

Pair once. The inviter keeps `pair` running until the friend joins:

```sh
# you
claude-share pair --relay ws://<relay-host>:8787 --name dhrupad
# → Invite code: k7q2-9xmd-4tpa   (one-time, expires in 15 minutes)

# your friend
claude-share join k7q2-9xmd-4tpa --relay ws://<relay-host>:8787 --name sarim
```

To add a third person, run `claude-share pair` again. It invites them into the same group.

Each of you, in your project directory:

```sh
claude-share up                      # pick which session answers, then keep this terminal open
claude mcp add claude-share -- claude-share mcp
```

`up` lists your Claude sessions in that folder, showing each one's first prompt, and you choose which one answers. Press Enter to always use whichever is most recent. To skip the prompt, use `--session <id-prefix>` or `--session latest`. `claude-share sessions` prints the list.

Then just talk to Claude: *"ask alex how they set up the auth middleware."*

## Tools Claude gets

| tool | what it does |
|---|---|
| `list_peers` | who's online, and in which project |
| `ask_peer` | ask a question; blocks until the answer arrives |
| `share_snippet` | push code or notes to a teammate's inbox |
| `read_inbox` | read what teammates shared with you |

## When a question arrives

```
? dhrupad asks:
How did you get the scraper so fast?
[a]uto-answer with Claude  [w]rite reply  [d]ecline > a
asking a fork of your latest session…

draft answer:
We batched requests in src/fetch.ts…

[s]end  [e]dit  [d]ecline >
```

`claude-share up --auto-approve` skips both prompts. Only use it with people you trust.

## Safety model

- **Pairing via a PAKE handshake.** Invite codes run SPAKE2 over ristretto255. The relay sees only the first 4 characters (a rendezvous id), never the password part. Someone watching, including the relay operator, can't guess the code offline. An attacker gets one live guess, and a wrong guess burns the invite.
- **End-to-end encrypted.** Pairing hands each member a random 256-bit group secret. Every message is sealed with AES-256-GCM using a key derived from that secret. The relay only sees a room hash and ciphertext, and stores nothing.
- **Read-only fork.** The answering fork gets only `Read`, `Grep` and `Glob`. There's no Bash, no edits, no web access, no Chrome and **no MCP servers**, so a question can't reach your connectors. Forks are never saved as sessions.
- **You approve.** By default you see every question and every draft answer before it leaves your machine.
- **Replies are fenced.** Answers reach the asking Claude wrapped in `<peer_reply untrusted="true">` with an instruction to treat them as data.
- **Rate limited.** At most 10 questions per peer per 10 minutes.
- **Local API.** The daemon binds to `127.0.0.1`, and every request needs a random bearer token stored in `~/.claude-share/daemon.json` (mode 600).

Known limits: the relay can see who's online, when, and how much data moves (not the content). The session list reads Claude Code's on-disk transcript layout, which isn't a documented API. If it changes, `up` falls back to "most recent session".

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

## Upgrading from 0.1

0.2 changes how pairing works, so 0.1 configs aren't compatible. Pair again: one of you runs `claude-share pair --new-group` and the other runs `claude-share join <code>`.
