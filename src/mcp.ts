import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { answerWithFork } from "./answerer.js";
import { DEFAULT_RELAY, defaultName, loadConfig, saveConfig, type Config } from "./config.js";
import { generateGroupSecret, generateInviteCode } from "./crypto.js";
import { Daemon, type Decide, type Decision } from "./daemon.js";
import { runInviter, runJoiner } from "./pairing.js";
import { fenceUntrusted } from "./protocol.js";
import { listSessions } from "./sessions.js";

const APPROVAL_TIMEOUT_MS = 10 * 60_000;
const NOT_PAIRED =
  "Not connected to anyone yet. Use invite_peer to get a code to send a teammate, or join_peer with a code they sent you.";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

function loadConfigOrNull(): Config | null {
  try {
    return loadConfig();
  } catch {
    return null; // a 0.1 config; pairing again replaces it
  }
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/**
 * The MCP server is the whole client: Claude Code starts one per session, and it holds the
 * relay connection for that session. Questions that arrive are approved through elicitation
 * dialogs in that session and answered by a read-only fork of it.
 */
export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "mindmeld", version: "0.3.1" });
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const mySessionId = process.env.CLAUDE_CODE_SESSION_ID;
  let daemon: Daemon | null = null;

  /** This session's transcript; after /clear the id may be stale, so fall back to the newest. */
  const mySession = () => {
    const sessions = listSessions(cwd);
    return sessions.find((s) => s.id === mySessionId) ?? sessions[0];
  };

  const isTrusted = (from: string) => (loadConfigOrNull()?.trusted ?? []).includes(from.toLowerCase());
  const setTrust = (name: string, on: boolean) => {
    const c = loadConfigOrNull();
    if (!c) return false;
    const rest = (c.trusted ?? []).filter((n) => n !== name.toLowerCase());
    saveConfig({ ...c, trusted: on ? [...rest, name.toLowerCase()] : rest });
    return true;
  };

  const elicit = (message: string, requestedSchema: any) =>
    server.server.elicitInput({ message, requestedSchema }, { timeout: APPROVAL_TIMEOUT_MS });

  // One question at a time, so approval dialogs never stack up.
  let queue: Promise<unknown> = Promise.resolve();
  const decide: Decide = (ask) => {
    const run = queue.then(() => answer(ask));
    queue = run.catch(() => {});
    return run;
  };

  async function answer(ask: { from: string; question: string; context?: string }): Promise<Decision> {
    const trusted = isTrusted(ask.from);
    if (!trusted) {
      if (!server.server.getClientCapabilities()?.elicitation) {
        return { action: "decline", reason: "they can't approve questions right now (no interactive Claude session)" };
      }
      const asked = [
        `${ask.from} asks:`,
        "",
        ask.question.slice(0, 2000),
        ask.context ? `\nTheir context: ${ask.context.slice(0, 1000)}` : "",
        "",
        "Answer with a read-only copy of this session? You'll see the answer before it's sent.",
        `(To skip these prompts for ${ask.from}, tell Claude "always allow ${ask.from.split(/\s+/)[0]}".)`,
      ].join("\n");
      // No form fields: a field takes keyboard focus, and then Enter no longer means Accept.
      const r = await elicit(asked, { type: "object", properties: {} });
      if (r.action !== "accept") return { action: "decline", reason: "declined" };
    }

    const draft = await answerWithFork({
      cwd,
      from: ask.from,
      question: ask.question,
      context: ask.context,
      sessionId: mySession()?.id,
    });
    if (trusted) return { action: "send", text: draft };

    const r = await elicit(`Send this answer to ${ask.from}?\n\n${draft.slice(0, 8000)}`, {
      type: "object",
      properties: {},
    });
    return r.action === "accept" ? { action: "send", text: draft } : { action: "decline", reason: "declined to send the answer" };
  }

  function connect(config: Config) {
    void daemon?.stop();
    daemon = new Daemon({
      ...config,
      project: basename(cwd),
      decide,
      sessionInfo: () => {
        const s = mySession();
        return s ? { label: s.firstPrompt.slice(0, 80), activeAt: s.modified.getTime() } : {};
      },
    });
    daemon.start();
  }

  const existing = loadConfigOrNull();
  if (existing) connect(existing);

  server.registerTool(
    "list_peers",
    {
      title: "List peers",
      description: "List teammates connected through mindmeld right now, one line per open Claude session.",
      inputSchema: {},
    },
    async () => {
      if (!daemon) return text(NOT_PAIRED);
      const peers = daemon.onlinePeers();
      if (peers.length === 0) return text("Nobody is online right now. They're online whenever they have a Claude Code session open.");
      return text(
        peers
          .map((p) => `- ${p.name}: ${p.project}${p.session ? ` · "${p.session}"` : ""}${p.activeAt ? ` · active ${ago(p.activeAt)}` : ""}`)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "ask_peer",
    {
      title: "Ask a teammate's Claude",
      description:
        "Ask a teammate's Claude Code session a question, e.g. how they solved something or how part of their work functions. " +
        "It goes to their most recently active session; they approve it in their Claude, and a read-only copy of that session answers. " +
        "Blocks until the answer arrives (can take a few minutes). Make the question self-contained.",
      inputSchema: {
        question: z.string().describe("The question, self-contained"),
        peer: z.string().optional().describe("Who to ask (name or first name). Optional if only one person is online"),
        context: z.string().optional().describe("Optional extra context: what you're trying to do, errors, etc."),
        timeout_sec: z.number().int().min(10).max(3600).optional().describe("Default 600"),
      },
    },
    async ({ question, peer, context, timeout_sec }) => {
      if (!daemon) return text(NOT_PAIRED, true);
      const r = await daemon.ask(question, { peer, context, timeoutSec: timeout_sec });
      if ("error" in r) return text(`No answer: ${r.error}`, true);
      return text(fenceUntrusted(r.from, r.text));
    },
  );

  server.registerTool(
    "share_snippet",
    {
      title: "Share a snippet",
      description: "Send a piece of context (code, notes, an explanation) to a teammate's inbox. No reply expected.",
      inputSchema: {
        title: z.string(),
        text: z.string(),
        peer: z.string().optional().describe("Who to send it to. Optional if only one person is online"),
      },
    },
    async ({ title, text: body, peer }) => {
      if (!daemon) return text(NOT_PAIRED, true);
      const r = daemon.snippet(title, body, peer);
      return "error" in r ? text(r.error, true) : text(`Shared with ${r.to}.`);
    },
  );

  server.registerTool(
    "read_inbox",
    {
      title: "Read inbox",
      description: "Read snippets teammates have shared with this session.",
      inputSchema: {},
    },
    async () => {
      if (!daemon) return text(NOT_PAIRED);
      const items = daemon.drainInbox();
      if (items.length === 0) return text("Inbox is empty.");
      return text(items.map((i) => fenceUntrusted(i.from, `# ${i.title}\n${i.text}`)).join("\n\n"));
    },
  );

  server.registerTool(
    "trust_peer",
    {
      title: "Always allow (or stop allowing) a teammate",
      description:
        "When the user says to always allow someone, their questions get answered without approval dialogs. " +
        "Use allow=false when the user wants to be asked again.",
      inputSchema: {
        peer: z.string().describe("The teammate's name, as shown by list_peers"),
        allow: z.boolean().describe("true = answer without asking; false = ask every time"),
      },
    },
    async ({ peer, allow }) => {
      if (!daemon) return text(NOT_PAIRED, true);
      const known = daemon.onlinePeers().find((p) => p.name.toLowerCase() === peer.toLowerCase() || p.name.toLowerCase().split(/\s+/)[0] === peer.toLowerCase());
      const name = known?.name ?? peer;
      setTrust(name, allow);
      return text(
        allow
          ? `${name}'s questions will now be answered automatically from this machine, without approval dialogs.`
          : `You'll be asked before answering ${name}'s questions again.`,
      );
    },
  );

  server.registerTool(
    "invite_peer",
    {
      title: "Invite a teammate",
      description:
        "Create a one-time invite code so a teammate's Claude Code can connect with this one. " +
        "Give the user the code to send them. The code expires in 15 minutes.",
      inputSchema: {
        my_name: z.string().optional().describe("How teammates will see the user. Defaults to their git user.name"),
      },
    },
    async ({ my_name }) => {
      const prev = loadConfigOrNull();
      const config: Config = {
        secret: prev?.secret ?? generateGroupSecret(),
        relay: prev?.relay ?? DEFAULT_RELAY,
        name: my_name ?? prev?.name ?? defaultName(),
        trusted: prev?.trusted,
      };
      saveConfig(config);
      if (!daemon || !prev || my_name) connect(config);

      const code = generateInviteCode();
      runInviter({ relay: config.relay, code, secret: config.secret, name: config.name }).then(
        ({ peerName }) => console.error(`mindmeld: ${peerName} joined`),
        (e) => console.error(`mindmeld: invite ${code} ended: ${(e as Error).message}`),
      );
      return text(
        [
          `Invite code: ${code}`,
          "",
          "Tell the user to send their teammate this message:",
          `  1. Install (once): claude plugin install mindmeld --marketplace dhrupad-sah/mindmeld`,
          `  2. In Claude Code: /mindmeld:join ${code}`,
          "",
          `The code works once and expires in 15 minutes. Keep this session open until they've joined. You'll appear to them as "${config.name}".`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "join_peer",
    {
      title: "Join a teammate",
      description: "Connect to a teammate using the invite code they sent (looks like k7q2-9xmd-4tpa).",
      inputSchema: {
        code: z.string().describe("The invite code"),
        my_name: z.string().optional().describe("How teammates will see the user. Defaults to their git user.name"),
      },
    },
    async ({ code, my_name }) => {
      const prev = loadConfigOrNull();
      const relay = prev?.relay ?? DEFAULT_RELAY;
      const name = my_name ?? prev?.name ?? defaultName();
      try {
        const { secret, inviterName } = await runJoiner({ relay, code, name });
        const config: Config = { secret, relay, name, trusted: prev?.secret === secret ? prev.trusted : [] };
        saveConfig(config);
        connect(config);
        return text(
          `Connected to ${inviterName}'s group as "${name}". ` +
            `Ask them anything with ask_peer, e.g. "ask ${inviterName.split(/\s+/)[0]} how they built X".` +
            (prev && prev.secret !== secret ? " (This replaced the group this machine was in before.)" : ""),
        );
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}
