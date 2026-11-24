/**
 * Team WebSockets (GET /v1/teams/:id/ws), hosted by the Team Durable Object with the hibernation API.
 * The Worker authenticates the bearer token; the Team object admits only a member's own device that
 * holds a wrap at the current epoch. Otherwise the socket is accepted, then closed with:
 *   4001 "not a member of this team" / "removed from team", 4003 "no team key yet", 4004 "no such team".
 * An admitted socket first gets { t:"server", latest, minimum, epoch }; the others get
 * { t:"joined", c, login }. A client frame { t:"msg", f: { e, dev, d, sig } } is forwarded to every
 * other socket as { t:"msg", f, c, login } (only if f.dev is the socket's own device). `c` and `login`
 * are for routing and presence; clients take identity from the frame signature. On a roster change
 * every socket gets { t:"roster" }; a close sends { t:"left", c, login }.
 */

/** Stored on each team socket so it survives hibernation. */
export interface TeamSocketAttachment {
  cid: string;
  login: string;
  deviceId: string;
  /** Set when the relay closed this socket itself, so it is skipped and "left" is not sent twice. */
  closed?: boolean;
}

/** Whether a device may hold a team socket now. */
export type Admission = { ok: true; epoch: number } | { ok: false; code: number; reason: string };

export const CLOSE_REMOVED = 4001;
export const CLOSE_NO_KEY = 4003;
export const CLOSE_NO_TEAM = 4004;

const MAX_FRAME_BYTES = 1024 * 1024;
const HEX16 = /^[0-9a-f]{16}$/;
const devTag = (deviceId: string) => `dev:${deviceId}`;

/** Internal headers carrying the authenticated caller from the Worker to its Team object. */
const CALLER_LOGIN = "x-mm-login";
const CALLER_DEVICE = "x-mm-device";

/**
 * The upgrade request the Worker sends the Team object after verifying the bearer token. It is built
 * fresh, so nothing client-supplied (headers included) reaches the Team object.
 */
export function upgradeRequest(login: string, deviceId: string): Request {
  return new Request("https://team/ws", { headers: { upgrade: "websocket", [CALLER_LOGIN]: login, [CALLER_DEVICE]: deviceId } });
}

/** The verified caller of an `upgradeRequest`. */
export function socketCaller(req: Request): { login: string; deviceId: string } {
  return { login: req.headers.get(CALLER_LOGIN) ?? "", deviceId: req.headers.get(CALLER_DEVICE) ?? "" };
}

function trySend(ws: WebSocket, msg: string): void {
  try {
    ws.send(msg);
  } catch {
    // Socket is closing; its own close event cleans up.
  }
}

/** The team's sockets. Stateless itself: everything lives in the hibernatable sockets' attachments. */
export class TeamSockets {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly versions: () => { latest: string; minimum: string },
  ) {}

  private open(): { ws: WebSocket; me: TeamSocketAttachment }[] {
    const out: { ws: WebSocket; me: TeamSocketAttachment }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const me = ws.deserializeAttachment() as TeamSocketAttachment | null;
      if (me && !me.closed) out.push({ ws, me });
    }
    return out;
  }

  private broadcast(msg: string, except?: WebSocket): void {
    for (const { ws } of this.open()) if (ws !== except) trySend(ws, msg);
  }

  /** Upgrade to a team socket for `login`'s device, admitted or refused per `admit`. */
  accept(login: string, deviceId: string, admit: Admission): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    if (!admit.ok) {
      // Accept, explain, close: a refused upgrade gives the client no reason to show.
      server.accept();
      server.close(admit.code, admit.reason);
      return new Response(null, { status: 101, webSocket: client });
    }
    const me: TeamSocketAttachment = { cid: crypto.randomUUID().slice(0, 12), login, deviceId };
    this.ctx.acceptWebSocket(server, [devTag(deviceId)]);
    server.serializeAttachment(me);
    trySend(server, JSON.stringify({ t: "server", ...this.versions(), epoch: admit.epoch }));
    this.broadcast(JSON.stringify({ t: "joined", c: me.cid, login }), server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Forward a member's frame to the other sockets, stamped with its connection id and login. */
  message(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > MAX_FRAME_BYTES) return;
    const me = ws.deserializeAttachment() as TeamSocketAttachment | null;
    if (!me || me.closed) return;
    let frame: { t?: unknown; f?: Record<string, unknown> };
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    const f = frame?.f;
    if (frame?.t !== "msg" || !f || typeof f !== "object") return;
    if (!Number.isSafeInteger(f.e) || typeof f.dev !== "string" || !HEX16.test(f.dev) || typeof f.d !== "string" || typeof f.sig !== "string") return;
    // A device only speaks for itself (clients check the signature regardless).
    if (f.dev !== me.deviceId) return;
    const out = JSON.stringify({ t: "msg", f: { e: f.e, dev: f.dev, d: f.d, sig: f.sig }, c: me.cid, login: me.login });
    this.broadcast(out, ws);
  }

  /** A socket closed (by its client, or after an error): tell the others. */
  closed(ws: WebSocket): void {
    try {
      ws.close(1000, "bye");
    } catch {}
    const me = ws.deserializeAttachment() as TeamSocketAttachment | null;
    if (!me || me.closed) return;
    ws.serializeAttachment({ ...me, closed: true });
    this.broadcast(JSON.stringify({ t: "left", c: me.cid, login: me.login }), ws);
  }

  /** Close the sockets of these devices with `code` / `reason`, telling the others they left. */
  closeDevices(deviceIds: string[], code: number, reason: string): void {
    for (const id of deviceIds) {
      for (const ws of this.ctx.getWebSockets(devTag(id))) {
        const me = ws.deserializeAttachment() as TeamSocketAttachment | null;
        if (!me || me.closed) continue;
        ws.serializeAttachment({ ...me, closed: true });
        try {
          ws.close(code, reason);
        } catch {}
        this.broadcast(JSON.stringify({ t: "left", c: me.cid, login: me.login }), ws);
      }
    }
  }

  /**
   * The roster or keys changed: close sockets whose device no longer holds the current key (4003),
   * then send { t:"roster" } to every remaining socket.
   */
  rosterChanged(hasCurrentKey: (deviceId: string) => boolean): void {
    const lacking = [...new Set(this.open().map((s) => s.me.deviceId))].filter((id) => !hasCurrentKey(id));
    this.closeDevices(lacking, CLOSE_NO_KEY, "no team key yet");
    this.broadcast(JSON.stringify({ t: "roster" }));
  }
}
