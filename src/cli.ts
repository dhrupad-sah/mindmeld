#!/usr/bin/env node
import { basename } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { answerWithFork } from "./answerer.js";
import { generateGroupSecret, generateInviteCode } from "./crypto.js";
import { DEFAULT_RELAY, defaultName, deleteConfig, loadConfig, saveConfig, withTeam, type Config } from "./config.js";
import { Daemon, type Decide, type Decision } from "./daemon.js";
import { runMcpServer, teamLeaveNote, teamSetNote } from "./mcp.js";
import { runInviter, runJoiner } from "./pairing.js";
import { loadSession } from "./auth/session.js";
import { loadOrCreateIdentity } from "./identity.js";
import {
  acceptInvite,
  addDevice,
  createTeam,
  deleteMember,
  formatTeam,
  getRoster,
  inviteMember,
  inviteMessage,
  listTeams,
  normLogin,
  removeAndRotate,
  setRole,
  signIn,
  signInLine,
  signInState,
} from "./teamapi.js";
import { TeamChannel } from "./teamchannel.js";
import { rotate } from "./teamkeys.js";
import { startRelay } from "./relay.js";
import { describeSession, listSessions, type SessionInfo } from "./sessions.js";

const USAGE = `mindmeld — let teammates' Claude Code sessions ask each other questions

  mindmeld pair  [--name alice] [--new-group] [--relay wss://…]
                                                       invite someone: prints a one-time code
  mindmeld join  <code> [--name bob]               join with a friend's invite code
  mindmeld up    [--session <id|latest>] [--auto-approve]
                                                       run the daemon (in your project dir)
  mindmeld leave     [-y]                             leave your group (disconnects every session here)
  mindmeld login                                   sign in with GitHub (needed for teams)
  mindmeld team                                    show your team: members, devices, invites, activity
  mindmeld team create <name>                      create a team (you're its admin)
  mindmeld team invite <github-login>              invite someone (admins)
  mindmeld team accept [team]                      accept an invite, or use a team you're already in
  mindmeld team remove <github-login> [-y]         remove someone and rotate the team key (admins)
  mindmeld team role <github-login> admin|member   change someone's role (admins)
  mindmeld sessions                                list Claude sessions in this directory
  mindmeld mcp                                     MCP server (used by Claude Code)
  mindmeld relay [--port 8787]                     self-host a relay (optional; a hosted one is the default)

Easiest: install the Claude Code plugin and do everything from Claude:
  claude plugin install mindmeld --marketplace dhrupad-sah/mindmeld`;

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
      yes: { type: "boolean", short: "y" },
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
      const current = loadConfigOrNull();
      if (current?.team) throw new Error(teamSetNote(current.team.name));
      const prev = values["new-group"] ? null : current;
      const secret = prev?.secret ?? generateGroupSecret();
      const config: Config = {
        ...prev,
        secret,
        relay: values.relay ?? prev?.relay ?? DEFAULT_RELAY,
        name: values.name ?? prev?.name ?? defaultName(),
      };
      saveConfig(config);
      const code = generateInviteCode();
      console.log(prev ? "Inviting someone into your existing group." : "Created a new group.");
      console.log(`\nInvite code: ${bold(code)}   ${dim("(one-time, expires in 15 minutes)")}`);
      const relayHint = config.relay === DEFAULT_RELAY ? "" : ` --relay ${config.relay}`;
      console.log(`Send your friend:  mindmeld join ${code}${relayHint}\n`);
      console.log(dim("waiting for them to join… (keep this running)"));
      const { peerName } = await runInviter({ relay: config.relay, code, secret, name: config.name });
      console.log(`${cyan("✓")} paired with ${bold(peerName)}. In Claude Code, run ${bold("/mindmeld:share")} in a session to let them ask it.`);
      return;
    }
    case "join": {
      const code = positionals[0];
      if (!code) throw new Error("usage: mindmeld join <code>");
      const prev = loadConfigOrNull();
      if (prev?.team) throw new Error(teamSetNote(prev.team.name));
      const relay = values.relay ?? prev?.relay ?? DEFAULT_RELAY;
      const name = values.name ?? prev?.name ?? defaultName();
      const { secret, inviterName } = await runJoiner({ relay, code, name });
      saveConfig({ ...prev, secret, relay, name });
      console.log(`${cyan("✓")} joined ${bold(inviterName)}'s group as ${bold(name)}.`);
      console.log(`Next: in Claude Code, run ${bold("/mindmeld:share")} in a session to let them ask it (sessions are private by default).`);
      return;
    }
    case "leave": {
      const current = loadConfigOrNull();
      if (!current) {
        console.log("You're not in a mindmeld group.");
        return;
      }
      if (current.team && !current.secret) {
        console.log(teamLeaveNote(current.team.name, false));
        return;
      }
      if (!values.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const a = (await rl.question("Leave your mindmeld group? Every session on this machine disconnects, and you'll need a new invite to reconnect. [y/N] ")).trim().toLowerCase();
        rl.close();
        if (a !== "y" && a !== "yes") return;
      }
      if (current.team) {
        const { secret: _gone, trusted: _t, ...rest } = current;
        saveConfig(rest);
        console.log(teamLeaveNote(current.team.name, true));
        return;
      }
      deleteConfig();
      console.log(`${cyan("✓")} left the group. Open Claude sessions disconnect within a few seconds.`);
      return;
    }
    case "login": {
      const relay = loadConfigOrNull()?.relay ?? DEFAULT_RELAY;
      const session = await signIn(relay, (code, uri) => {
        console.log(`Open ${bold(uri)} and enter ${bold(code)}`);
        console.log(dim("waiting for you to approve on GitHub…"));
      });
      console.log(`${cyan("✓")} signed in as ${bold(`@${session.login}`)}.`);
      return;
    }
    case "team":
      return team(positionals, Boolean(values.yes));
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

/** `mindmeld team [create|invite|accept|remove|role]`: the CLI side of the MCP team tools. */
async function team(args: string[], yes: boolean): Promise<void> {
  const [sub, a, b] = args;
  const s = signInState();
  if (!("session" in s)) throw new Error(`${signInLine(s)} (or: mindmeld login)`);
  const session = s.session;
  const config = loadConfigOrNull();
  const relay = config?.relay ?? DEFAULT_RELAY;
  const useTeam = (t: { teamId: string; name: string }) => saveConfig(withTeam(config, { relay, name: config?.name ?? session.login }, t));
  const current = () => {
    if (!config?.team) throw new Error("you're not in a team yet: mindmeld team create <name>, or mindmeld team accept");
    return config.team;
  };
  switch (sub) {
    case undefined: {
      if (!config?.team) {
        const invites = (await listTeams(relay, session)).filter((t) => t.role === "invited");
        console.log("You're not in a team yet. Create one with `mindmeld team create <name>`, or accept an invite with `mindmeld team accept`.");
        if (invites.length) console.log(`Pending invites: ${invites.map((t) => `"${t.name}"`).join(", ")}`);
        return;
      }
      console.log(formatTeam(await getRoster(relay, session, config.team.teamId), { login: session.login, deviceId: loadOrCreateIdentity().deviceId }));
      return;
    }
    case "create": {
      const name = args.slice(1).join(" ").trim();
      if (!name) throw new Error("usage: mindmeld team create <name>");
      const { teamId } = await createTeam(relay, session, name);
      useTeam({ teamId, name });
      console.log(`${cyan("✓")} created team ${bold(name)} with you as admin. Invite people with: mindmeld team invite <github-login>`);
      return;
    }
    case "invite": {
      if (!a) throw new Error("usage: mindmeld team invite <github-login>");
      const t = current();
      await inviteMember(relay, session, t.teamId, a);
      console.log(inviteMessage(a, t.name));
      return;
    }
    case "accept": {
      const teams = await listTeams(relay, session);
      const q = args.slice(1).join(" ").trim().toLowerCase();
      const match = q ? teams.filter((t) => t.teamId === q || t.name.toLowerCase() === q) : teams;
      if (match.length === 0) throw new Error(`no pending invite or team${q ? ` called "${q}"` : ""} for @${session.login}`);
      if (match.length > 1) throw new Error(`several teams and invites (${match.map((t) => `"${t.name}"`).join(", ")}): say which, e.g. mindmeld team accept ${match[0].name}`);
      if (match[0].role !== "invited") {
        useTeam({ teamId: match[0].teamId, name: match[0].name });
        console.log(`${cyan("✓")} this machine now uses team ${bold(match[0].name)}, where you're ${match[0].role}.`);
        return;
      }
      await acceptInvite(relay, session, match[0].teamId);
      useTeam({ teamId: match[0].teamId, name: match[0].name });
      console.log(`${cyan("✓")} joined team ${bold(match[0].name)}. A teammate's mindmeld gives this device the team key when one of them is online.`);
      return;
    }
    case "remove": {
      if (!a) throw new Error("usage: mindmeld team remove <github-login> [-y]");
      const t = current();
      const who = normLogin(a);
      if (!yes) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ans = (await rl.question(`Remove @${who} from team "${t.name}" and rotate the team key? [y/N] `)).trim().toLowerCase();
        rl.close();
        if (ans !== "y" && ans !== "yes") return;
      }
      const id = loadOrCreateIdentity();
      const r = await removeAndRotate(who, {
        remove: () => deleteMember(relay, session, t.teamId, who),
        rotate: () => rotate({ relayHttp: relay, teamId: t.teamId, session, id, reason: "removed" }),
      });
      if (r.isError) throw new Error(r.text);
      console.log(`${cyan("✓")} ${r.text}`);
      return;
    }
    case "role": {
      if (!a || (b !== "admin" && b !== "member")) throw new Error("usage: mindmeld team role <github-login> admin|member");
      const t = current();
      await setRole(relay, session, t.teamId, a, b);
      console.log(`${cyan("✓")} @${normLogin(a)} is now ${b} in team "${t.name}".`);
      return;
    }
    default:
      throw new Error(`unknown team command "${sub}" (create, invite, accept, remove, role)`);
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
    throw new Error(`no session starting with "${flag}" in this directory (see: mindmeld sessions)`);
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
  if (!config) throw new Error("not paired yet: run `mindmeld pair` or `mindmeld join <code>` first");
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

  let name = config.name;
  let channel: TeamChannel | undefined;
  if (config.team) {
    const session = loadSession();
    if (!session) throw new Error(`${signInLine()} (or: mindmeld login)`);
    channel = new TeamChannel({ relayHttp: config.relay, teamId: config.team.teamId, session, id: loadOrCreateIdentity() });
    channel.on("status", (why: string | null) => why && console.log(dim(`team: ${why}`)));
    addDevice(config.relay, session, config.team.teamId).catch(() => {}); // a second machine joins its login's team
    name = session.login;
  }
  const daemon = new Daemon({ ...config, name, channel, project: basename(cwd), decide });
  daemon.on("connected", () => console.log(dim(`connected to relay ${config.relay}`)));
  daemon.on("disconnected", () => console.log(dim("relay connection lost, reconnecting…")));
  daemon.on("relay-error", (e: NodeJS.ErrnoException) => console.log(dim(`relay error: ${e.message || e.code || "connection failed"}`)));
  daemon.on("peer-joined", (p) => console.log(`${cyan("●")} ${p.name} is online (${p.project})`));
  daemon.on("peer-left", (p) => console.log(dim(`○ ${p.name} went offline`)));
  daemon.on("snippet", (s) => console.log(`${cyan("✉")} snippet received: ${s.title}`));

  daemon.start();
  console.log(`${bold("mindmeld")} up as ${bold(name)}${config.team ? ` in team ${bold(config.team.name)}` : ""} in ${cwd}`);
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
