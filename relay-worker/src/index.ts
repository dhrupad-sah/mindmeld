import { DurableObject } from "cloudflare:workers";
import { handleAuth } from "./auth.js";
import { handleTeams, type TeamEnv } from "./team.js";

export { Users } from "./auth.js";
export { Team } from "./team.js";

/**
 * mindmeld relay on Cloudflare: same protocol as `mindmeld relay` (src/relay.ts).
 * - /room/<64 hex>: a paired group; frames fan out to the other members. Clients from 0.5 on
 *   connect with `?v=<version>`: they get version info, connection ids and joined/left events,
 *   and are kept apart from older clients, which keep seeing each other as before.
 * - /pair/<rendezvous>: one-time handshake room for exactly two sockets.
 * - /v1/auth/github, /v1/me: GitHub sign-in and mindmeld session tokens (src/auth.ts).
 * - /v1/teams/*: team roster, invites, roles and wrapped team keys (src/team.ts).
 * Frames are end-to-end encrypted; nothing is stored. One Durable Object per room.
 */

interface Env extends TeamEnv {
  ROOMS: DurableObjectNamespace<Room>;
  LATEST_VERSION: string;
  MIN_VERSION: string;
}

/** Stored on each socket so it survives hibernation. */
interface Attachment {
  cid: string;
  v: string | null;
}

const ROOM_PATH = /^\/room\/([0-9a-f]{64})$/;
const PAIR_PATH = /^\/pair\/([a-z0-9]{4,16})$/;
const MAX_FRAME_BYTES = 1024 * 1024;

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function trySend(ws: WebSocket, msg: string): void {
  try {
    ws.send(msg);
  } catch {
    // Socket is closing; its own close event cleans up.
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/v1/")) {
      return (await handleAuth(req, env, pathname)) ?? (await handleTeams(req, env, pathname)) ?? new Response("not found\n", { status: 404 });
    }
    const room = ROOM_PATH.exec(pathname);
    const pair = PAIR_PATH.exec(pathname);
    if (!room && !pair) {
      return new Response("mindmeld relay\n", { headers: { "content-type": "text/plain" } });
    }
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket\n", { status: 426 });
    }
    const name = room ? `room:${room[1]}` : `pair:${pair![1]}`;
    return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(req);
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  private serverInfo(extra: object = {}): string {
    return JSON.stringify({
      t: "server",
      latest: this.env.LATEST_VERSION,
      minimum: this.env.MIN_VERSION,
      legacy: this.ctx.getWebSockets("legacy").length,
      ...extra,
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const isPair = url.pathname.startsWith("/pair/");
    if (isPair && this.ctx.getWebSockets().length >= 2) return new Response("pairing room is full\n", { status: 409 });

    const { 0: client, 1: server } = new WebSocketPair();
    if (isPair) {
      // Hibernation API: the object can sleep between messages without dropping sockets.
      this.ctx.acceptWebSocket(server, ["pair"]);
      const all = this.ctx.getWebSockets();
      if (all.length === 2) for (const ws of all) trySend(ws, JSON.stringify({ t: "peer-joined" }));
      return new Response(null, { status: 101, webSocket: client });
    }

    const v = url.searchParams.get("v");
    if (v !== null && compareVersions(v, this.env.MIN_VERSION) < 0) {
      // Accept, explain, close: a refused upgrade would only make the client retry forever.
      server.accept();
      server.send(this.serverInfo({ blocked: true }));
      server.close(4001, "update required");
      return new Response(null, { status: 101, webSocket: client });
    }

    const me: Attachment = { cid: crypto.randomUUID().slice(0, 12), v };
    this.ctx.acceptWebSocket(server, [v === null ? "legacy" : "v"]);
    server.serializeAttachment(me);
    if (v !== null) {
      trySend(server, this.serverInfo());
      const joined = JSON.stringify({ t: "joined", c: me.cid });
      for (const ws of this.ctx.getWebSockets("v")) if (ws !== server) trySend(ws, joined);
    } else {
      const info = this.serverInfo();
      for (const ws of this.ctx.getWebSockets("v")) trySend(ws, info);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_FRAME_BYTES) return;
    const tags = this.ctx.getTags(ws);
    if (tags.includes("pair") || tags.includes("legacy")) {
      // Pairing peers, and old clients, only ever reach their own kind.
      const pool = tags.includes("pair") ? "pair" : "legacy";
      for (const other of this.ctx.getWebSockets(pool)) if (other !== ws) trySend(other, message);
      return;
    }
    let frame: { t?: string; d?: unknown };
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (frame.t !== "msg" || typeof frame.d !== "string") return;
    const me = ws.deserializeAttachment() as Attachment;
    const stamped = JSON.stringify({ t: "msg", d: frame.d, c: me.cid });
    for (const other of this.ctx.getWebSockets("v")) if (other !== ws) trySend(other, stamped);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close(1000, "bye");
    } catch {}
    const tags = this.ctx.getTags(ws);
    if (tags.includes("pair")) {
      // A pairing room is single-use: if either side leaves, end it for the other too.
      for (const other of this.ctx.getWebSockets("pair")) {
        if (other !== ws) {
          try {
            other.close(1000, "peer left");
          } catch {}
        }
      }
      return;
    }
    const others = this.ctx.getWebSockets("v").filter((o) => o !== ws);
    if (tags.includes("v")) {
      const me = ws.deserializeAttachment() as Attachment;
      const left = JSON.stringify({ t: "left", c: me.cid });
      for (const o of others) trySend(o, left);
    } else {
      // An old client left: update the count new clients show.
      const legacy = this.ctx.getWebSockets("legacy").filter((o) => o !== ws).length;
      const info = JSON.stringify({ ...JSON.parse(this.serverInfo()), legacy });
      for (const o of others) trySend(o, info);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
