# mindmeld product review (2026-10-30)

Triggered by the first real use with a friend. Findings are ranked by severity. P0 items are
fixed in 0.4.0; the others are tracked here.

## P0: privacy and security

1. **Every open session is visible to the whole group** *(reported by the user)*. Each Claude
   session's MCP server joined the group automatically and broadcast its project folder name and
   its **first prompt** to every member, and any of those sessions could be asked questions. A
   first prompt can contain anything: client names, plans, pasted secrets.
   **Fix:** sessions are private by default. A session is visible and answerable only after
   `/mindmeld:share` in that session; `/mindmeld:stop` ends it, and so does closing the session.
   The label others see is whatever you choose (default: the project folder name), and the share
   confirmation shows exactly what is visible. First prompts are never sent. Asking doesn't
   require sharing: an asker connects silently and is never listed.

2. **The "read-only" fork could read any file in the home directory** *(found in this review)*.
   Verified: a fork with `--allowedTools Read` read `~/.gitconfig`. Combined with "always allow",
   a group member could ask for `~/.ssh/id_rsa` and get it with nobody approving.
   **Fix:** forks run with path-scoped rules `Read(./**)`, `Grep(./**)`, `Glob(./**)`, plus
   `--permission-mode dontAsk` and `--setting-sources ""` so the user's own allow rules can't widen
   them, and explicit denies for `.env*`, keys and credential files inside the project.
   Verified: outside reads are denied, project reads work.

3. **Names aren't authenticated inside a group.** Any member could claim another member's name,
   and "always allow" trusts a name. *Open:* per-member signing keys exchanged at pairing; until
   then the README warns about it, and trust only skips approval for files inside the shared
   project (see 2).

## P0: feedback ("is it even working?")

4. **The asker gets no feedback** *(reported)*. `ask_peer` sat silently for up to 10 minutes,
   with no way to tell "delivered and waiting for approval" from "lost".
   **Fix:** the answering side reports status (`received` → `approved` → `writing answer` →
   answer or decline). The asker gets MCP progress notifications, and the tool fails within
   15 s with a clear reason if no shared session acknowledges the question.

5. **There's no way to check state** *(reported)*. You couldn't see whether you were connected,
   whether this session was shared, or what had been answered automatically on your behalf.
   **Fix:** `/mindmeld:status` shows the relay connection, your name, whether this session is
   shared and as what, who else is sharing, trusted people, pending questions, and recent
   activity, including auto-answered questions, so nothing happens invisibly.

6. **The plugin silently failed inside the mindmeld repo** (npx resolved the local checkout).
   **Fix:** the plugin starts the server from the home directory, through a small launcher.

## P1: reliability

7. Questions sent while the relay connection is down are dropped. (4 surfaces this; next:
   queue and resend on reconnect.)
8. No protocol version check between peers. *0.4 adds `v` to hello and warns on mismatch.*
9. After `/clear` the session id changes but the MCP server keeps the old one. The answer then
   comes from the pre-clear history. *Open:* SessionStart hook to refresh it.
10. Large answers can exceed the relay's 1 MB frame limit. *Open:* cap and truncate with a notice.
11. ~~The first `npx` start outlasted Claude Code's startup check, so the first launch failed.~~
    **Fixed in plugin 0.4.1:** the server is bundled into the plugin and starts in about 1 s cold.

## P2: product

12. Groups are all-or-nothing. Everyone in a group sees every shared session. Per-pair or named
    groups would fit teams better.
13. ~~No way to leave a group.~~ **Fixed in 0.4.2:** `/mindmeld:leave` and `mindmeld leave`, which every open session follows within about 3 s. Removing one member still means the others leave and re-pair (a new secret). Per-member keys would fix that properly.
14. The relay has no per-room rate limit or size cap (abuse and cost).
15. Each auto-answer runs a fork on the answerer's own Claude quota. The rate limit (10 per
    10 min) exists but isn't visible. Show it in status.
