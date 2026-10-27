# Spike: session identity and in-Claude approval (2026-10-27)

Claude Code 2.1.311. A throwaway MCP server was driven through real `claude` sessions
(`-p`, and interactive via `expect`).

## Q1. Can an MCP server know which session it belongs to? **Yes.**

Claude Code starts each stdio MCP server with `CLAUDE_CODE_SESSION_ID` in its environment.
It matched the id passed with `--session-id` exactly. `CLAUDE_PROJECT_DIR` is also set.

**Implication:** the MCP server can be the daemon. A question that reaches a session's MCP
server is answered by `claude -p --resume $CLAUDE_CODE_SESSION_ID --fork-session …`. That means
"the session you're in answers", with no picker and no second terminal.

Edge case (not tested): after `/clear` the session id changes, but the MCP server may keep
running with the old id, so answers would come from the pre-`/clear` history. Possible fix: a
`SessionStart` hook (`source: "clear"`) records the new id for the server to pick up.

## Q2. Can approval happen inside Claude Code? **Yes, with elicitation.**

- Claude Code advertises the `elicitation: { form, url }` capability.
- `elicitInput` renders a native dialog ("MCP server X requests your input", the message,
  Accept / Decline).
- **It works while the session is idle.** A request sent 5 s after the turn ended still
  showed the dialog, and Enter returned `{ action: "accept" }`.
- In `-p` (headless) mode it auto-returns `cancel`, so treat that as "nobody is there to approve".
- The SDK's default request timeout is 60 s, so pass `{ timeout }` (e.g. 10 min).

**Implication:** the incoming question and draft answer show up where the user already is.
"Always allow <peer>" can be a boolean field in the same form (not yet tested).

## Channels (`notifications/claude/channel`): works, but not for the default path

A pushed message landed in the live, idle session and started a new turn. Claude treated it as
untrusted and didn't act on it. However, a server that isn't on the approved list needs
`--dangerously-load-development-channels` plus a warning prompt at every launch, which is too
much friction. Elicitation covers the approval need without it.

## Decision for 0.3

The MCP server is the daemon. Its session id comes from `CLAUDE_CODE_SESSION_ID`, and approval
uses elicitation (10 min timeout, "always allow" checkbox). Channels are optional later, if the
server gets onto the approved list.
