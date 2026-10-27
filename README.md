# claude-share (`claude-share-mcp` on npm)

Let your Claude Code session ask your teammate's Claude Code session a question, and get the answer back without copy-paste.

```
you:        "ask Sarim how they got the scraper so fast"
your Claude ──ask_peer──► relay ──► Sarim's Claude: "Dhrupad asks… [Accept] [Decline]"
your Claude ◄──answer──── relay ◄── read-only copy of Sarim's session: "We moved to a worker pool…"
```

The answer comes from a **read-only copy of the Claude session your teammate has open**. It knows what they built and why, and their live session isn't touched.

## Setup (each of you, once)

```sh
npm install -g claude-share-mcp
claude mcp add -s user claude-share -- claude-share mcp
```

> The npm package is `claude-share-mcp`. Don't run `npx claude-share`: that's an unrelated package.

## Connect

In Claude Code, just say it:

- **You:** *"invite a teammate to claude-share"* → Claude gives you a code like `k7q2-9xmd-4tpa`. Send it to them. It works once and expires in 15 minutes.
- **Them:** *"join claude-share with code k7q2-9xmd-4tpa"* → connected.

That's it. From then on you're online whenever you have a Claude Code session open. There's nothing else to run.

## Use

*"Ask Sarim how they set up the auth middleware."*

On Sarim's side, Claude Code shows a dialog:

```
MCP server claude-share requests your input
Dhrupad asks: How did you set up the auth middleware?
Answer with a read-only copy of this session? You'll see the answer before it's sent.
  [ ] Always allow Dhrupad
  Accept   Decline
```

Sarim accepts, a read-only copy of that session writes the answer, Sarim approves the draft, and it lands in your Claude. If Sarim ticks **Always allow**, Dhrupad's later questions are answered without any prompts.

If Sarim has several Claude sessions open, the question goes to the one used most recently. `list_peers` shows each session and what it's about.

## Tools Claude gets

| tool | what it does |
|---|---|
| `invite_peer` / `join_peer` | pair with a teammate |
| `list_peers` | who's online, in which project and session |
| `ask_peer` | ask a question; blocks until the answer arrives |
| `share_snippet` / `read_inbox` | send or receive code and notes, no reply needed |

## Terminal commands (optional)

Everything above works from inside Claude. The CLI is there for scripts and servers:

```sh
claude-share pair / join <code>     # pair from a terminal instead
claude-share up --auto-approve      # an always-on answerer for a project (no dialogs; trusted groups only)
claude-share sessions               # list Claude sessions in this directory
claude-share relay                  # self-host a relay
```

## Relay

By default, both sides connect to a hosted relay (a Cloudflare Worker, source in [`relay-worker/`](relay-worker/)). It only passes along encrypted frames and stores nothing. To run your own, use `claude-share relay --port 8787` on any reachable machine, or deploy `relay-worker/` to your own Cloudflare account. Then pass `--relay ws://host:8787` to `pair` and `join`, or set `CLAUDE_SHARE_RELAY`.

## Safety model

- **Pairing via a PAKE handshake.** Invite codes run SPAKE2 over ristretto255. The relay sees only the first 4 characters (a rendezvous id), never the password part. Someone watching, including the relay operator, can't guess the code offline. An attacker gets one live guess, and a wrong guess burns the invite.
- **End-to-end encrypted.** Pairing hands each member a random 256-bit group secret. Every message is sealed with AES-256-GCM using a key derived from that secret. The relay only sees a room hash and ciphertext, and stores nothing.
- **Read-only fork.** The answering fork gets only `Read`, `Grep` and `Glob`. There's no Bash, no edits, no web access, no Chrome and **no MCP servers**, so a question can't reach your connectors. Forks are never saved as sessions.
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

- **From 0.2:** your pairing still works. Remove any old `claude mcp add claude-share …` entry, add the user-scope one above, and stop running `claude-share up`, since Claude itself is now the client.
- **From 0.1:** pairing changed, so pair again with `invite_peer` / `join_peer`.
