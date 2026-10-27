import { DurableObject } from "cloudflare:workers";

/**
 * claude-share relay on Cloudflare: same protocol as `claude-share relay` (src/relay.ts).
 * - /room/<64 hex>: a paired group; frames fan out to the other members.
 * - /pair/<rendezvous>: one-time handshake room for exactly two sockets.
 * Frames are end-to-end encrypted; nothing is stored. One Durable Object per room.
 */

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
}

const ROOM_PATH = /^\/room\/([0-9a-f]{64})$/;
const PAIR_PATH = /^\/pair\/([a-z0-9]{4,16})$/;
const MAX_FRAME_BYTES = 1024 * 1024;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(req.url);
    const room = ROOM_PATH.exec(pathname);
    const pair = PAIR_PATH.exec(pathname);
    if (!room && !pair) {
      return new Response("claude-share relay\n", { headers: { "content-type": "text/plain" } });
    }
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket\n", { status: 426 });
    }
    const name = room ? `room:${room[1]}` : `pair:${pair![1]}`;
    return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(req);
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const isPair = new URL(req.url).pathname.startsWith("/pair/");
    const members = this.ctx.getWebSockets();
    if (isPair && members.length >= 2) return new Response("pairing room is full\n", { status: 409 });

    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API: the object can sleep between messages without dropping sockets.
    this.ctx.acceptWebSocket(server, [isPair ? "pair" : "room"]);
    if (isPair && members.length === 1) {
      for (const ws of this.ctx.getWebSockets()) ws.send(JSON.stringify({ t: "peer-joined" }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_FRAME_BYTES) return;
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) {
        try {
          other.send(message);
        } catch {
          // Socket is closing; it'll be cleaned up by its own close event.
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close(1000, "bye");
    } catch {}
    // A pairing room is single-use: if either side leaves, end it for the other too.
    if (this.ctx.getTags(ws).includes("pair")) {
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws) {
          try {
            other.close(1000, "peer left");
          } catch {}
        }
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
