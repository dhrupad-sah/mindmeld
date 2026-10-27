#!/usr/bin/env node
import { basename } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { answerWithFork } from "./answerer.js";
import { generateCode, normalizeCode } from "./crypto.js";
import { DEFAULT_RELAY, defaultName, loadConfig, saveConfig, saveDaemonInfo } from "./config.js";
import { Daemon, type Decide, type Decision } from "./daemon.js";
import { runMcpServer } from "./mcp.js";
import { startRelay } from "./relay.js";

const USAGE = `claude-share — let teammates' Claude Code sessions ask each other questions

  claude-share relay [--port 8787]                     run a relay (one of you, or a server)
  claude-share pair  [--relay ws://host:8787] [--name alice]   create a pairing code
  claude-share join  <code> [--relay ...] [--name bob]          join with a friend's code
  claude-share up    [--auto-approve]                  run the daemon (in your project dir)
  claude-share mcp                                     MCP server (used by Claude Code)

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
    },
  });

  switch (cmd) {
    case "relay": {
      const port = Number(values.port ?? process.env.PORT ?? 8787);
      await startRelay(port);
      console.log(`relay listening on ws://0.0.0.0:${port}`);
      return;
    }
    case "pair":
    case "join": {
      const code = cmd === "pair" ? generateCode() : positionals[0];
      if (!code || normalizeCode(code).length !== 12) throw new Error("usage: claude-share join <code>");
      const prev = loadConfig();
      const relay = values.relay ?? prev?.relay ?? DEFAULT_RELAY;
      const name = values.name ?? prev?.name ?? defaultName();
      saveConfig({ code, relay, name });
      if (cmd === "pair") {
        console.log(`Pairing code: ${bold(code)}`);
        console.log(`Send your friend:  claude-share join ${code} --relay ${relay}`);
      } else {
        console.log(`Joined. Relay: ${relay}, your name: ${name}`);
      }
      console.log(`Next: run ${bold("claude-share up")} in your project directory.`);
      return;
    }
    case "up":
      return up(Boolean(values["auto-approve"]));
    case "mcp":
      return runMcpServer();
    default:
      console.log(USAGE);
      process.exitCode = cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
}

async function up(autoApprove: boolean) {
  const config = loadConfig();
  if (!config) throw new Error("not paired yet: run `claude-share pair` or `claude-share join <code>` first");
  const cwd = process.cwd();
  const interactive = Boolean(process.stdin.isTTY);
  if (!interactive && !autoApprove) {
    console.warn("stdin is not a terminal; incoming questions will be declined (use --auto-approve to answer them).");
  }
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  // Questions are handled one at a time so prompts never interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const decide: Decide = (ask) => {
    const run = queue.then(() => handleQuestion(ask, { cwd, autoApprove, rl }));
    queue = run.catch(() => {});
    return run;
  };

  const daemon = new Daemon({ ...config, project: basename(cwd), decide });
  daemon.on("connected", () => console.log(dim(`connected to relay ${config.relay}`)));
  daemon.on("disconnected", () => console.log(dim("relay connection lost, reconnecting…")));
  daemon.on("relay-error", (e: Error) => console.log(dim(`relay error: ${e.message}`)));
  daemon.on("peer-joined", (p) => console.log(`${cyan("●")} ${p.name} is online (${p.project})`));
  daemon.on("peer-left", (p) => console.log(dim(`○ ${p.name} went offline`)));
  daemon.on("snippet", (s) => console.log(`${cyan("✉")} snippet received: ${s.title}`));

  const port = await daemon.start();
  saveDaemonInfo({ port, token: daemon.token, pid: process.pid });
  console.log(`${bold("claude-share")} up as ${bold(config.name)} in ${cwd}`);
  console.log(dim(`answers come from a read-only fork of your latest Claude session here${autoApprove ? " (auto-approve ON)" : ""}`));

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
  { cwd, autoApprove, rl }: { cwd: string; autoApprove: boolean; rl: Interface | null },
): Promise<Decision> {
  console.log(`\n${cyan("?")} ${bold(ask.from)} asks:\n${ask.question}`);
  if (ask.context) console.log(dim(`context: ${ask.context}`));

  const fork = async () => {
    console.log(dim("asking a fork of your latest session…"));
    return answerWithFork({ cwd, from: ask.from, question: ask.question, context: ask.context });
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
