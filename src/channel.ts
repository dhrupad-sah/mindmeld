import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { keyFor, open, roomIdFor, seal } from "./crypto.js";
import { Control, Frame, Payload, PING_INTERVAL_MS } from "./protocol.js";
import { VERSION } from "./version.js";

export type ServerInfo = Extract<Control, { t: "server" }>;

/** Who a payload came from, as far as the transport can tell. */
export interface PayloadSender {
  /** Relay connection id, so a "left" event can remove the peers on that connection. */
  cid?: string;
  /** Authenticated login. When present it is the sender's name; names claimed in payloads are ignored. */
  login?: string;
}

/**
 * A pluggable transport under Daemon. Emits:
 * - "payload" (p: Payload, from: PayloadSender)
 * - "joined" (cid) / "left" (cid)
 * - "server" / "blocked" (info: ServerInfo)
 * - "connected" / "disconnected"
 */
export interface Channel extends EventEmitter {
  start(): void;
  stop(): Promise<void>;
  readonly connected: boolean;
  readonly server: ServerInfo | null;
  send(p: Payload): void;
}

export interface GroupChannelOptions {
  /** Group secret from pairing. */
  secret: string;
  relay: string;
  /** Client version sent to the relay. Defaults to this build's version. */
  version?: string;
}

/** Legacy secret-based group: one encrypted room on the relay, names come from hellos. */
export class GroupChannel extends EventEmitter implements Channel {
  private readonly key: Buffer;
  private readonly roomUrl: string;
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private serverInfo: ServerInfo | null = null;
  private stopped = false;
  /** Encrypted frames this client has sent; lets tests check that idle sessions stay quiet. */
  framesSent = 0;

  constructor(opts: GroupChannelOptions) {
    super();
    this.key = keyFor(opts.secret);
    const version = encodeURIComponent(opts.version ?? VERSION);
    this.roomUrl = `${opts.relay.replace(/\/$/, "")}/room/${roomIdFor(opts.secret)}?v=${version}`;
  }

  start(): void {
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get server(): ServerInfo | null {
    return this.serverInfo;
  }

  send(p: Payload): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const frame: Frame = { t: "msg", d: seal(this.key, JSON.stringify(p)) };
    this.ws.send(JSON.stringify(frame));
    this.framesSent++;
  }

  private connect(): void {
    const ws = new WebSocket(this.roomUrl);
    this.ws = ws;
    ws.on("open", () => {
      this.emit("connected");
      let alive = true;
      ws.on("pong", () => (alive = true));
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (!alive) return ws.terminate(); // half-open connection: reconnect
        alive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
      this.pingTimer.unref?.();
    });
    ws.on("message", (data) => this.handleFrame(data.toString()));
    ws.on("error", (e) => this.emit("relay-error", e));
    ws.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      // Always reported, even when stopped, so the daemon can drop its peers.
      this.emit("disconnected");
      if (this.stopped) return;
      setTimeout(() => !this.stopped && this.connect(), 2000);
    });
  }

  private handleControl(c: Control): void {
    switch (c.t) {
      case "server":
        this.serverInfo = c;
        if (c.blocked) {
          this.stopped = true; // don't reconnect: the relay will refuse this version again
          this.emit("blocked", c);
        } else {
          this.emit("server", c);
        }
        break;
      case "joined":
        this.emit("joined", c.c);
        break;
      case "left":
        this.emit("left", c.c);
        break;
    }
  }

  private handleFrame(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const control = Control.safeParse(json);
    if (control.success) return this.handleControl(control.data);
    const f = Frame.safeParse(json);
    if (!f.success) return;
    const plain = open(this.key, f.data.d);
    if (plain === null) return;
    const parsed = Payload.safeParse(JSON.parse(plain));
    if (!parsed.success) return;
    this.emit("payload", parsed.data, { cid: f.data.c } satisfies PayloadSender);
  }
}
