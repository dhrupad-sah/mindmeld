import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { compareVersions, VERSION } from "./version.js";

const ROOM_PATH = /^\/room\/([0-9a-f]{64})$/;
const PAIR_PATH = /^\/pair\/([a-z0-9]{4,16})$/;
const MAX_FRAME_BYTES = 1024 * 1024;

export interface RelayOptions {
  /** Newest client version; v3+ clients show "update available" below it. */
  latest?: string;
  /** Oldest client version allowed to connect (v3+ clients only). */
  minimum?: string;
}

interface Member {
  ws: WebSocket;
  /** Connection id the relay stamps on this socket's frames. */
  cid: string;
  /** Client version, or null for pre-0.5 clients that don't send one. */
  v: string | null;
}

/**
 * A dumb fan-out relay. Two kinds of rooms:
 * - `/room/<id>`: a paired group; every frame is forwarded to the other members.
 *   Clients from 0.5 on connect with `?v=<version>`. They get version info, connection ids and
 *   joined/left events, and are kept apart from older clients, which see each other as before.
 * - `/pair/<rendezvous>`: a one-time pairing handshake between exactly two sockets.
 *   When the second one arrives, both get `{"t":"peer-joined"}`.
 * Frames are end-to-end protected; the relay stores nothing and cannot read them.
 * Same protocol as the Cloudflare relay in relay-worker/.
 */
export function startRelay(port: number, host = "0.0.0.0", opts: RelayOptions = {}): Promise<Server> {
  const latest = opts.latest ?? VERSION;
  const minimum = opts.minimum ?? "0.5.0";
  const rooms = new Map<string, Set<Member>>();
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("mindmeld relay\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  const send = (m: Member, frame: object | string) => {
    if (m.ws.readyState === WebSocket.OPEN) m.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  };
  const serverInfo = (set: Set<Member>) => ({
    t: "server",
    latest,
    minimum,
    legacy: [...set].filter((m) => m.v === null).length,
  });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const room = ROOM_PATH.exec(url.pathname);
    const pair = PAIR_PATH.exec(url.pathname);
    if (!room && !pair) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const key = room ? `room:${room[1]}` : `pair:${pair![1]}`;
    const members = rooms.get(key);
    if (pair && members && members.size >= 2) {
      socket.end("HTTP/1.1 409 Conflict\r\n\r\n");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = rooms.get(key);
      if (!set) rooms.set(key, (set = new Set()));
      const me: Member = { ws, cid: randomBytes(6).toString("hex"), v: url.searchParams.get("v") };

      if (room && me.v !== null && compareVersions(me.v, minimum) < 0) {
        // Accept, explain, close: a refused upgrade would only make the client retry forever.
        send(me, { ...serverInfo(set), blocked: true });
        ws.close(4001, "update required");
        return;
      }
      set.add(me);
      const versioned = (m: Member) => m.v !== null;

      if (pair && set.size === 2) {
        for (const m of set) send(m, { t: "peer-joined" });
      }
      if (room) {
        if (versioned(me)) {
          send(me, serverInfo(set));
          for (const m of set) if (m !== me && versioned(m)) send(m, { t: "joined", c: me.cid });
        } else {
          for (const m of set) if (versioned(m)) send(m, serverInfo(set));
        }
      }

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const raw = data.toString();
        if (pair) {
          for (const m of set) if (m !== me) send(m, raw);
          return;
        }
        if (!versioned(me)) {
          // Old clients only ever reach each other.
          for (const m of set) if (m !== me && !versioned(m)) send(m, raw);
          return;
        }
        let frame: { t?: string; d?: unknown };
        try {
          frame = JSON.parse(raw);
        } catch {
          return;
        }
        if (frame.t !== "msg" || typeof frame.d !== "string") return;
        const stamped = JSON.stringify({ t: "msg", d: frame.d, c: me.cid });
        for (const m of set) if (m !== me && versioned(m)) send(m, stamped);
      });

      ws.on("close", () => {
        set.delete(me);
        if (set.size === 0) rooms.delete(key);
        // A pairing room is single-use: if either side leaves, end it for the other too.
        if (pair) for (const m of set) m.ws.close(1000, "peer left");
        if (room) {
          for (const m of set) {
            if (!versioned(m)) continue;
            if (versioned(me)) send(m, { t: "left", c: me.cid });
            else send(m, serverInfo(set));
          }
        }
      });
    });
  });

  return new Promise((resolve) => http.listen(port, host, () => resolve(http)));
}
