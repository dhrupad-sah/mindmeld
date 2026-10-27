import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const ROOM_PATH = /^\/room\/([0-9a-f]{64})$/;
const PAIR_PATH = /^\/pair\/([a-z0-9]{4,16})$/;
const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * A dumb fan-out relay. Two kinds of rooms:
 * - `/room/<id>`: a paired group; every frame is forwarded to the other members.
 * - `/pair/<rendezvous>`: a one-time pairing handshake between exactly two sockets.
 *   When the second one arrives, both get `{"t":"peer-joined"}`.
 * Frames are end-to-end protected; the relay stores nothing and cannot read them.
 */
export function startRelay(port: number, host = "0.0.0.0"): Promise<Server> {
  const rooms = new Map<string, Set<WebSocket>>();
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("mindmeld relay\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  http.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const room = ROOM_PATH.exec(url);
    const pair = PAIR_PATH.exec(url);
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
      set.add(ws);
      if (pair && set.size === 2) {
        for (const m of set) m.send(JSON.stringify({ t: "peer-joined" }));
      }

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        for (const other of set) {
          if (other !== ws && other.readyState === WebSocket.OPEN) other.send(data.toString());
        }
      });
      ws.on("close", () => {
        set.delete(ws);
        if (set.size === 0) rooms.delete(key);
        // A pairing room is single-use: if either side leaves, end it for the other too.
        if (pair) for (const m of set) m.close(1000, "peer left");
      });
    });
  });

  return new Promise((resolve) => http.listen(port, host, () => resolve(http)));
}
