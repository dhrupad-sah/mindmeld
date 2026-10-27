import { request } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadDaemonInfo } from "./config.js";
import { fenceUntrusted } from "./protocol.js";

/** Talk to the local daemon. Uses node:http (not fetch) so long asks aren't cut off by header timeouts. */
function callDaemon(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
  const info = loadDaemonInfo();
  if (!info) {
    return Promise.reject(new Error("claude-share daemon is not running. Ask the user to run `claude-share up` in a terminal."));
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: info.port,
        path,
        method,
        headers: {
          authorization: `Bearer ${info.token}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`bad response from daemon: ${raw.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "ECONNREFUSED"
          ? new Error("claude-share daemon is not running. Ask the user to run `claude-share up` in a terminal.")
          : e,
      ),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

async function guarded(fn: () => Promise<ReturnType<typeof text>>) {
  try {
    return await fn();
  } catch (e) {
    return text((e as Error).message, true);
  }
}

export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "claude-share", version: "0.1.0" });

  server.registerTool(
    "list_peers",
    {
      title: "List peers",
      description: "List teammates whose Claude Code sessions are connected through claude-share right now.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const peers: { name: string; project: string; lastSeen: number }[] = await callDaemon("GET", "/peers");
        if (peers.length === 0) return text("No peers online.");
        return text(peers.map((p) => `- ${p.name} (project: ${p.project})`).join("\n"));
      }),
  );

  server.registerTool(
    "ask_peer",
    {
      title: "Ask a peer's Claude",
      description:
        "Ask a teammate's Claude Code session a question, e.g. how they solved something or how a part of their work functions. " +
        "Their side answers from its own session history and project (read-only), usually after the teammate approves. " +
        "Blocks until the answer arrives. Include enough context for the question to stand on its own.",
      inputSchema: {
        question: z.string().describe("The question, self-contained"),
        peer: z.string().optional().describe("Peer name from list_peers; omit to ask everyone"),
        context: z.string().optional().describe("Optional extra context: what you're trying to do, error messages, etc."),
        timeout_sec: z.number().int().min(10).max(3600).optional().describe("Default 600"),
      },
    },
    ({ question, peer, context, timeout_sec }) =>
      guarded(async () => {
        const r = await callDaemon("POST", "/ask", { question, peer, context, timeoutSec: timeout_sec });
        if (r.error) return text(`No answer: ${r.error}`, true);
        return text(fenceUntrusted(r.from, r.text));
      }),
  );

  server.registerTool(
    "share_snippet",
    {
      title: "Share a snippet",
      description: "Push a piece of context (code, notes, an explanation) to a teammate's inbox. No reply expected.",
      inputSchema: {
        title: z.string(),
        text: z.string(),
        peer: z.string().optional().describe("Peer name; omit to send to everyone"),
      },
    },
    ({ title, text: body, peer }) =>
      guarded(async () => {
        const r = await callDaemon("POST", "/snippet", { title, text: body, peer });
        return r.error ? text(r.error, true) : text("Shared.");
      }),
  );

  server.registerTool(
    "read_inbox",
    {
      title: "Read inbox",
      description: "Read snippets teammates have shared with you since the last read.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const items: { from: string; title: string; text: string }[] = await callDaemon("GET", "/inbox");
        if (items.length === 0) return text("Inbox is empty.");
        return text(items.map((i) => fenceUntrusted(i.from, `# ${i.title}\n${i.text}`)).join("\n\n"));
      }),
  );

  await server.connect(new StdioServerTransport());
}
