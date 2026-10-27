import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const ROOM_PATH = /^\/room\/([0-9a-f]{64})$/;
const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * A dumb fan-out relay: sockets join a room by id, and every frame is forwarded
 * to the other sockets in that room. Frames are end-to-end encrypted; the relay
 * stores nothing and cannot read them.
 */
export function startRelay(port: number, host = "0.0.0.0"): Promise<Server> {
  const rooms = new Map<string, Set<WebSocket>>();
  const http = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("claude-share relay\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  http.on("upgrade", (req, socket, head) => {
    const match = ROOM_PATH.exec(req.url ?? "");
    if (!match) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const roomId = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      let room = rooms.get(roomId);
      if (!room) rooms.set(roomId, (room = new Set()));
      room.add(ws);

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        for (const other of room) {
          if (other !== ws && other.readyState === WebSocket.OPEN) other.send(data.toString());
        }
      });
      ws.on("close", () => {
        room.delete(ws);
        if (room.size === 0) rooms.delete(roomId);
      });
    });
  });

  return new Promise((resolve) => http.listen(port, host, () => resolve(http)));
}
