#!/usr/bin/env node
import { basename } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { answerWithFork } from "./answerer.js";
import { generateGroupSecret, generateInviteCode } from "./crypto.js";
import { DEFAULT_RELAY, defaultName, loadConfig, saveConfig, saveDaemonInfo, type Config } from "./config.js";
import { Daemon, type Decide, type Decision } from "./daemon.js";
import { runMcpServer } from "./mcp.js";
import { runInviter, runJoiner } from "./pairing.js";
import { startRelay } from "./relay.js";
import { describeSession, listSessions, type SessionInfo } from "./sessions.js";

const USAGE = `claude-share — let teammates' Claude Code sessions ask each other questions

  claude-share pair  [--name alice] [--new-group] [--relay wss://…]
                                                       invite someone: prints a one-time code
  claude-share join  <code> [--name bob]               join with a friend's invite code
  claude-share up    [--session <id|latest>] [--auto-approve]
                                                       run the daemon (in your project dir)
  claude-share sessions                                list Claude sessions in this directory
  claude-share mcp                                     MCP server (used by Claude Code)
  claude-share relay [--port 8787]                     self-host a relay (optional; a hosted one is the default)

Register with Claude Code:  claude mcp add claude-share -- claude-share mcp`;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      relay: { type: "string" },
      name: { type: "string" },
      "auto-approve": { type: "boolean" },
      "new-group": { type: "boolean" },
      session: { type: "string" },
    },
  });

  switch (cmd) {
    case "relay": {
      const port = Number(values.port ?? process.env.PORT ?? 8787);
      await startRelay(port);
      console.log(`relay listening on ws://0.0.0.0:${port}`);
      return;
    }
    case "pair": {
      const prev = values["new-group"] ? null : loadConfigOrNull();
      const config: Config = {
        secret: prev?.secret ?? generateGroupSecret(),
        relay: values.relay ?? prev?.relay ?? DEFAULT_RELAY,
        name: values.name ?? prev?.name ?? defaultName(),
      };
      saveConfig(config);
      const code = generateInviteCode();
      console.log(prev ? "Inviting someone into your existing group." : "Created a new group.");
      console.log(`\nInvite code: ${bold(code)}   ${dim("(one-time, expires in 15 minutes)")}`);
      const relayHint = config.relay === DEFAULT_RELAY ? "" : ` --relay ${config.relay}`;
      console.log(`Send your friend:  claude-share join ${code}${relayHint}\n`);
      console.log(dim("waiting for them to join… (keep this running)"));
      const { peerName } = await runInviter({ relay: config.relay, code, secret: config.secret, name: config.name });
      console.log(`${cyan("✓")} paired with ${bold(peerName)}. Next: ${bold("claude-share up")} in your project directory.`);
      return;
    }
    case "join": {
      const code = positionals[0];
      if (!code) throw new Error("usage: claude-share join <code>");
      const prev = loadConfigOrNull();
      const relay = values.relay ?? prev?.relay ?? DEFAULT_RELAY;
      const name = values.name ?? prev?.name ?? defaultName();
      const { secret, inviterName } = await runJoiner({ relay, code, name });
      saveConfig({ secret, relay, name });
      console.log(`${cyan("✓")} joined ${bold(inviterName)}'s group as ${bold(name)}.`);
      console.log(`Next: run ${bold("claude-share up")} in your project directory.`);
      return;
    }
    case "sessions": {
      const sessions = listSessions(process.cwd());
      if (sessions.length === 0) console.log("No Claude Code sessions found for this directory.");
      for (const s of sessions.slice(0, 20)) console.log(describeSession(s));
      return;
    }
    case "up":
      return up(Boolean(values["auto-approve"]), values.session);
    case "mcp":
      return runMcpServer();
    default:
      console.log(USAGE);
      process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
}

function loadConfigOrNull(): Config | null {
  try {
    return loadConfig();
  } catch {
    return null; // an old 0.1 config: pairing again replaces it
  }
}

/** Which session answers: a pinned id, or null for "the most recent one at question time". */
async function chooseSession(cwd: string, flag: string | undefined, rl: Interface | null): Promise<string | null> {
  const sessions = listSessions(cwd);
  if (flag === "latest") return null;
  if (flag) {
    const match = sessions.filter((s) => s.id.startsWith(flag));
    if (match.length === 1) return match[0].id;
    if (match.length > 1) throw new Error(`--session ${flag} matches ${match.length} sessions; use more characters`);
    if (/^[0-9a-f-]{36}$/.test(flag)) return flag; // not found locally; let claude --resume decide
    throw new Error(`no session starting with "${flag}" in this directory (see: claude-share sessions)`);
  }
  if (!rl || sessions.length === 0) return null;

  const shown = sessions.slice(0, 9);
  console.log(bold("\nWhich Claude session should answer questions?"));
  shown.forEach((s, i) => console.log(`  ${i + 1}) ${describeSession(s)}`));
  console.log(`  ${dim("Enter) whichever session is most recent when a question arrives")}`);
  for (;;) {
    const answer = (await rl.question("> ")).trim();
    if (!answer) return null;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1].id;
    console.log(dim(`pick 1-${shown.length}, or press Enter`));
  }
}

function sessionForQuestion(cwd: string, pinned: string | null): SessionInfo | { id: string; firstPrompt: string } | null {
  if (pinned) return listSessions(cwd).find((s) => s.id === pinned) ?? { id: pinned, firstPrompt: "" };
  return listSessions(cwd)[0] ?? null;
}

async function up(autoApprove: boolean, sessionFlag: string | undefined) {
  const config = loadConfig();
  if (!config) throw new Error("not paired yet: run `claude-share pair` or `claude-share join <code>` first");
  const cwd = process.cwd();
  const interactive = Boolean(process.stdin.isTTY);
  if (!interactive && !autoApprove) {
    console.warn("stdin is not a terminal; incoming questions will be declined (use --auto-approve to answer them).");
  }
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const pinned = await chooseSession(cwd, sessionFlag, rl);

  // Questions are handled one at a time so prompts never interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const decide: Decide = (ask) => {
    const run = queue.then(() => handleQuestion(ask, { cwd, autoApprove, rl, pinned }));
    queue = run.catch(() => {});
    return run;
  };

  const daemon = new Daemon({ ...config, project: basename(cwd), decide });
  daemon.on("connected", () => console.log(dim(`connected to relay ${config.relay}`)));
  daemon.on("disconnected", () => console.log(dim("relay connection lost, reconnecting…")));
  daemon.on("relay-error", (e: NodeJS.ErrnoException) => console.log(dim(`relay error: ${e.message || e.code || "connection failed"}`)));
  daemon.on("peer-joined", (p) => console.log(`${cyan("●")} ${p.name} is online (${p.project})`));
  daemon.on("peer-left", (p) => console.log(dim(`○ ${p.name} went offline`)));
  daemon.on("snippet", (s) => console.log(`${cyan("✉")} snippet received: ${s.title}`));

  const port = await daemon.start();
  saveDaemonInfo({ port, token: daemon.token, pid: process.pid });
  console.log(`${bold("claude-share")} up as ${bold(config.name)} in ${cwd}`);
  const which = pinned ? `session ${pinned.slice(0, 8)}` : "your most recent session";
  console.log(dim(`answers come from a read-only fork of ${which} here${autoApprove ? " (auto-approve ON)" : ""}`));

  const shutdown = async () => {
    await daemon.stop();
    rl?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleQuestion(
  ask: { from: string; question: string; context?: string },
  { cwd, autoApprove, rl, pinned }: { cwd: string; autoApprove: boolean; rl: Interface | null; pinned: string | null },
): Promise<Decision> {
  console.log(`\n${cyan("?")} ${bold(ask.from)} asks:\n${ask.question}`);
  if (ask.context) console.log(dim(`context: ${ask.context}`));

  const fork = async () => {
    const session = sessionForQuestion(cwd, pinned);
    const label = session ? `session ${session.id.slice(0, 8)}${session.firstPrompt ? ` (“${session.firstPrompt.slice(0, 50)}”)` : ""}` : "your most recent session";
    console.log(dim(`asking a fork of ${label}…`));
    return answerWithFork({ cwd, from: ask.from, question: ask.question, context: ask.context, sessionId: session?.id });
  };

  if (autoApprove) {
    const text = await fork();
    console.log(dim(`sent:\n${text}`));
    return { action: "send", text };
  }
  if (!rl) return { action: "decline", reason: "peer is not available to approve questions" };

  const choice = (await rl.question("[a]uto-answer with Claude  [w]rite reply  [d]ecline > ")).trim().toLowerCase();
  if (choice.startsWith("d")) return decline(rl);
  let draft = choice.startsWith("w") ? await readMultiline(rl) : await fork();

  for (;;) {
    console.log(`\n${bold("draft answer:")}\n${draft}\n`);
    const next = (await rl.question("[s]end  [e]dit  [d]ecline > ")).trim().toLowerCase();
    if (next.startsWith("s")) return { action: "send", text: draft };
    if (next.startsWith("d")) return decline(rl);
    if (next.startsWith("e")) draft = await readMultiline(rl);
  }
}

async function decline(rl: Interface): Promise<Decision> {
  const reason = (await rl.question("reason (optional) > ")).trim();
  return { action: "decline", reason: reason || "declined by peer" };
}

async function readMultiline(rl: Interface): Promise<string> {
  console.log(dim('type your reply; finish with a line containing only "."'));
  const lines: string[] = [];
  for (;;) {
    const line = await rl.question("");
    if (line.trim() === ".") return lines.join("\n");
    lines.push(line);
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
