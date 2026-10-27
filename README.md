# claude-share (`claude-share-mcp` on npm)

Let your Claude Code session ask your teammate's Claude Code session a question, and get the answer back without copy-paste.

```
you:        "ask Alex's Claude how they got the scraper so fast"
your Claude ──ask_peer──► relay ──► Alex's daemon ──► read-only fork of Alex's session
your Claude ◄──answer──── relay ◄── Alex approves ◄── "We batched requests in src/fetch.ts…"
```

The answer comes from a **headless fork of your teammate's most recent session** in their project. It knows what they built and why, and their live session isn't touched.

## Quick start

One of you runs a relay. It can be a laptop on the same Wi-Fi, a VPS, or a machine on your Tailscale network:

```sh
npx claude-share-mcp relay --port 8787
```

Install (each of you):

```sh
npm install -g claude-share-mcp     # gives you the `claude-share` command
```

Pair once:

```sh
# you
claude-share pair --relay ws://<relay-host>:8787 --name dhrupad
# → Pairing code: k7q2-9xmd-4tpa

# your friend
claude-share join k7q2-9xmd-4tpa --relay ws://<relay-host>:8787 --name alex
```

Each of you, in your project directory:

```sh
claude-share up                      # keep this terminal open; it's where you approve questions
claude mcp add claude-share -- claude-share mcp
```

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

- **End-to-end encrypted.** AES-256-GCM, with the key derived from the pairing code. The relay only sees a room hash and ciphertext, and stores nothing.
- **Read-only fork.** The answering fork gets only `Read`, `Grep` and `Glob`. There's no Bash, no edits, no web access and **no MCP servers**, so a question can't reach your connectors.
- **You approve.** By default you see every question and every draft answer before it leaves your machine.
- **Replies are fenced.** Answers reach the asking Claude wrapped in `<peer_reply untrusted="true">` with an instruction to treat them as data.
- **Rate limited.** At most 10 questions per peer per 10 minutes.
- **Local API.** The daemon binds to `127.0.0.1`, and every request needs a random bearer token stored in `~/.claude-share/daemon.json` (mode 600).

Known limit: a malicious *relay operator* could brute-force a pairing code offline. Run your own relay. A PAKE handshake is on the roadmap.

## Roadmap

PAKE pairing · hosted relay on Cloudflare Durable Objects · mDNS LAN discovery · push questions into a live session (Claude Code channels) · target an exact session id instead of `--continue`.

## Development

```sh
npm install
npm test        # unit + end-to-end (real relay, two daemons, stub claude)
npm run build
```

Design doc: [`docs/superpowers/specs/2026-10-27-claude-share-design.md`](docs/superpowers/specs/2026-10-27-claude-share-design.md)

MIT licensed.
