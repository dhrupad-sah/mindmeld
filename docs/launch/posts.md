# mindmeld launch posts

Written in Dhrupad's voice. Everything here is true as of 0.4.2. Update before reposting.

## X

**Post**

My friend and I kept copy-pasting questions between our Claude Code sessions. I'd ask, he'd paste it into his Claude, then send me the answer to paste into mine.

So I built mindmeld. My Claude asks his directly, and he approves it with one key press.

https://github.com/dhrupad-sah/mindmeld

**Reply**

The answer comes from a read-only copy of his session, so it knows what he built and why, and his live session isn't touched. Sessions are private until you run /mindmeld:share. Setup is one command each plus an invite code. MIT licensed.

## LinkedIn

My friend and I both use Claude Code, and we kept doing something dumb. I'd ask him how he solved something, he'd paste my question into his Claude, then send me the answer so I could paste it into mine.

So I built mindmeld. My Claude can now ask his Claude directly.

The question shows up as a dialog in his session. He presses Enter, a read-only copy of that session writes the answer, he checks the draft, and another Enter sends it back. His live session isn't touched, and the copy can only read files inside that project, never .env or key files.

The first real test with him found the worst bug. Every Claude session he had open was visible to me, along with its first prompt. Now every session stays private until you run /mindmeld:share in it.

Setup is one command each plus a one-time invite code. It's free, MIT licensed, and built with Claude Code.

One thing I'd like help with: I wrote the pairing handshake myself on top of audited crypto libraries, and nobody has reviewed my part yet. If that's your area, please take a look.

https://github.com/dhrupad-sah/mindmeld

## Reddit: r/ClaudeCode

Check the sidebar rules first. Use a Showcase or Project flair if there is one.

**Title:** I got tired of copy-pasting between my Claude Code session and my friend's, so I made them talk to each other

My friend and I work on related stuff and both use Claude Code. When I needed to know how he solved something, I'd send him the question, he'd paste it into his session, then send me the answer so I could paste it into mine. His session had all the context, so it was the best place to ask, but we were acting as a very slow network cable.

mindmeld is a plugin that lets one session ask another person's session directly.

Here's how it works. Your Claude calls an ask tool. A dialog shows up in your teammate's session with the question. If they accept, it runs a headless fork of that session with `--fork-session`, so the answer comes from what that session already knows and their live session isn't touched. They see the draft and press Enter again to send it.

The fork can only use Read and Glob inside the project. Anything outside it gets denied at the permission level, and so do `.env`, key and credential files. It has no Bash, no edits, no web and no MCP servers.

The first test with my friend found a bad one: every session he had open was visible to me, first prompt included. Sessions are now private until you run `/mindmeld:share`.

Install:

    claude plugin install mindmeld --marketplace dhrupad-sah/mindmeld

Then `/mindmeld:invite` on your side and `/mindmeld:join <code>` on theirs.

Stuff you should know before trying it. Messages go through a small relay I host on Cloudflare (you can self-host it). They're end-to-end encrypted, but the relay can see when you're online and how much data moves. Each answer uses the answering person's Claude quota. Everyone in a group shares one key, so names can be faked inside a group, and removing someone means the rest of you pair again. I wrote the pairing handshake myself on top of @noble/curves and nobody has reviewed it yet.

I built it with Claude Code. Code is MIT: https://github.com/dhrupad-sah/mindmeld

If you work on a team that uses Claude Code, I'd like to hear where this falls apart for you.

## Reddit: r/ClaudeAI

Their showcase rule needs 50+ karma for a feed post. A new account should use the Project Showcase megathread. Read Rule 7 first.

I built mindmeld, a Claude Code plugin that lets your session ask a teammate's session a question. I built it with Claude Code, after my friend and I got sick of pasting questions and answers back and forth between our sessions.

They get an Accept/Decline dialog in their session, then a read-only copy of that session writes the answer from what it already knows. They approve the draft before it's sent. Sessions are private until you share them. It's free and MIT licensed.

    claude plugin install mindmeld --marketplace dhrupad-sah/mindmeld

Repo, with the known limits listed: https://github.com/dhrupad-sah/mindmeld

## Show HN

**Title:** Show HN: Mindmeld – Let your Claude Code session ask a teammate's session

**URL:** https://github.com/dhrupad-sah/mindmeld

**First comment**

My friend and I kept relaying questions between our Claude Code sessions by hand. His session had the context I needed, so I'd send him a question, he'd paste it in, and I'd paste the answer into mine.

mindmeld connects the two. An MCP server in each session holds a WebSocket to a relay. When a question arrives, the answering side shows an approval dialog using MCP elicitation, then runs `claude -p --resume <session> --fork-session` so the answer draws on that session's history. The fork gets Read and Glob scoped to the project, with .env and key files denied, and no MCP servers. Sessions are invisible to the group until you explicitly share one.

Pairing is a one-time code. The first four characters are a rendezvous id the relay can see. The rest is the password for a SPAKE2 handshake over ristretto255, which hands the joiner a random 256-bit group key. After that, everything is AES-256-GCM and the relay only forwards ciphertext. It runs on Cloudflare Durable Objects, and you can self-host it.

The parts I'd poke at first: I wrote the SPAKE2 protocol code myself on top of @noble/curves, and it hasn't been reviewed. M and N come from hash-to-curve instead of the RFC constants, since the RFC doesn't define ristretto255 parameters. Group members share one key, so names aren't authenticated inside a group. The read-only fork also relies on Claude Code's permission rules holding up.

I built it with Claude Code. I'd really like criticism of the security model.

## dev.to (or your own blog)

**Title:** Making two Claude Code sessions talk to each other

Use the Show HN comment as the outline, then add the three things testing taught me: (1) a checkbox in an elicitation dialog takes keyboard focus, so Enter stops meaning Accept, (2) forks saved their own sessions and became "the most recent session" for the next question until I added `--no-session-persistence`, and (3) `--allowedTools Read` let a fork read `~/.gitconfig`, so read-only didn't mean what I assumed.
