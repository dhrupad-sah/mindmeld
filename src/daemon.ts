import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { keyFor, open, roomIdFor, seal } from "./crypto.js";
import { Frame, HELLO_INTERVAL_MS, PEER_TIMEOUT_MS, Payload } from "./protocol.js";

type Ask = Extract<Payload, { type: "ask" }>;
type Snippet = Extract<Payload, { type: "snippet" }>;

export type Decision = { action: "send"; text: string } | { action: "decline"; reason: string };
/** Decides how to respond to an incoming question (interactive prompt, auto-fork, or test stub). */
export type Decide = (ask: Ask) => Promise<Decision>;

export interface PeerInfo {
  peer: string;
  name: string;
  project: string;
  lastSeen: number;
}

export interface DaemonOptions {
  /** Group secret from pairing. */
  secret: string;
  relay: string;
  name: string;
  project: string;
  decide: Decide;
  /** Local API port; 0 picks a free one. */
  port?: number;
  rateLimit?: { max: number; windowMs: number };
}

interface PendingAsk {
  resolve: (r: { from: string; text: string } | { error: string }) => void;
  expected: number;
  declines: string[];
}

export class Daemon extends EventEmitter {
  readonly peerId = randomUUID();
  readonly token = randomBytes(24).toString("hex");
  private readonly key: Buffer;
  private readonly roomUrl: string;
  private ws: WebSocket | null = null;
  private http: Server | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly peers = new Map<string, PeerInfo>();
  private readonly pending = new Map<string, PendingAsk>();
  private readonly inbox: Snippet[] = [];
  private readonly askLog = new Map<string, number[]>();

  constructor(private readonly opts: DaemonOptions) {
    super();
    this.key = keyFor(opts.secret);
    this.roomUrl = `${opts.relay.replace(/\/$/, "")}/room/${roomIdFor(opts.secret)}`;
  }

  async start(): Promise<number> {
    this.connect();
    this.helloTimer = setInterval(() => this.sendHello(), HELLO_INTERVAL_MS);
    this.http = createServer((req, res) => {
      this.handleHttp(req)
        .then(([status, body]) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        })
        .catch((e) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(e?.message ?? e) }));
        });
    });
    await new Promise<void>((r) => this.http!.listen(this.opts.port ?? 0, "127.0.0.1", r));
    const addr = this.http.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.send({ type: "bye", peer: this.peerId });
    this.ws?.close();
    for (const p of this.pending.values()) p.resolve({ error: "daemon stopped" });
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }

  onlinePeers(): PeerInfo[] {
    const now = Date.now();
    return [...this.peers.values()].filter((p) => now - p.lastSeen < PEER_TIMEOUT_MS);
  }

  // ── relay connection ────────────────────────────────────────────────

  private connect(): void {
    const ws = new WebSocket(this.roomUrl);
    this.ws = ws;
    ws.on("open", () => {
      this.emit("connected");
      this.sendHello();
    });
    ws.on("message", (data) => this.handleFrame(data.toString()));
    ws.on("error", (e) => this.emit("relay-error", e));
    ws.on("close", () => {
      if (this.stopped) return;
      this.emit("disconnected");
      setTimeout(() => !this.stopped && this.connect(), 2000);
    });
  }

  private send(p: Payload): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const frame: Frame = { t: "msg", d: seal(this.key, JSON.stringify(p)) };
    this.ws.send(JSON.stringify(frame));
  }

  private sendHello(): void {
    this.send({ type: "hello", peer: this.peerId, name: this.opts.name, project: this.opts.project });
  }

  private handleFrame(raw: string): void {
    let frame: Frame;
    try {
      frame = Frame.parse(JSON.parse(raw));
    } catch {
      return;
    }
    const plain = open(this.key, frame.d);
    if (plain === null) return;
    const parsed = Payload.safeParse(JSON.parse(plain));
    if (!parsed.success) return;
    const p = parsed.data;

    switch (p.type) {
      case "hello": {
        const isNew = !this.onlinePeers().some((x) => x.peer === p.peer);
        this.peers.set(p.peer, { peer: p.peer, name: p.name, project: p.project, lastSeen: Date.now() });
        if (isNew) {
          this.emit("peer-joined", this.peers.get(p.peer));
          this.sendHello(); // let the newcomer see us immediately
        }
        break;
      }
      case "bye": {
        const info = this.peers.get(p.peer);
        this.peers.delete(p.peer);
        if (info) this.emit("peer-left", info);
        break;
      }
      case "ask":
        if (!p.to || p.to === this.opts.name || p.to === this.peerId) void this.handleAsk(p);
        break;
      case "answer": {
        const pending = this.pending.get(p.id);
        if (pending) {
          this.pending.delete(p.id);
          pending.resolve({ from: this.nameOf(p.from), text: p.text });
        }
        break;
      }
      case "decline": {
        const pending = this.pending.get(p.id);
        if (!pending) break;
        pending.declines.push(`${this.nameOf(p.from)}: ${p.reason}`);
        if (pending.declines.length >= pending.expected) {
          this.pending.delete(p.id);
          pending.resolve({ error: `declined — ${pending.declines.join("; ")}` });
        }
        break;
      }
      case "snippet":
        if (!p.to || p.to === this.opts.name || p.to === this.peerId) {
          this.inbox.push({ ...p, from: this.nameOf(p.from) });
          this.emit("snippet", p);
        }
        break;
    }
  }

  private nameOf(peerId: string): string {
    return this.peers.get(peerId)?.name ?? peerId.slice(0, 8);
  }

  private rateLimited(from: string): boolean {
    const { max, windowMs } = this.opts.rateLimit ?? { max: 10, windowMs: 10 * 60_000 };
    const now = Date.now();
    const recent = (this.askLog.get(from) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    this.askLog.set(from, recent);
    return recent.length > max;
  }

  private async handleAsk(ask: Ask): Promise<void> {
    const reply = (d: Decision) =>
      d.action === "send"
        ? this.send({ type: "answer", id: ask.id, from: this.peerId, text: d.text })
        : this.send({ type: "decline", id: ask.id, from: this.peerId, reason: d.reason });

    if (this.rateLimited(ask.from)) {
      reply({ action: "decline", reason: "rate limited — too many questions, try again later" });
      return;
    }
    try {
      reply(await this.opts.decide({ ...ask, from: this.nameOf(ask.from) }));
    } catch (e) {
      reply({ action: "decline", reason: `failed to answer: ${(e as Error).message}` });
    }
  }

  // ── outgoing operations (used by the local API) ─────────────────────

  private targets(peer?: string): PeerInfo[] {
    const online = this.onlinePeers();
    return peer ? online.filter((p) => p.name === peer || p.peer === peer) : online;
  }

  ask(question: string, opts: { peer?: string; context?: string; timeoutSec?: number } = {}) {
    const targets = this.targets(opts.peer);
    if (targets.length === 0) {
      return Promise.resolve({
        error: opts.peer ? `peer "${opts.peer}" is not online` : "no peers online",
      } as const);
    }
    const id = randomUUID();
    const to = opts.peer ? targets[0].peer : undefined;
    return new Promise<{ from: string; text: string } | { error: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: `no answer within ${opts.timeoutSec ?? 600}s` });
      }, (opts.timeoutSec ?? 600) * 1000);
      this.pending.set(id, {
        expected: targets.length,
        declines: [],
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      this.send({ type: "ask", id, from: this.peerId, to, question, context: opts.context });
    });
  }

  snippet(title: string, text: string, peer?: string): { ok: true } | { error: string } {
    const targets = this.targets(peer);
    if (targets.length === 0) return { error: peer ? `peer "${peer}" is not online` : "no peers online" };
    const to = peer ? targets[0].peer : undefined;
    this.send({ type: "snippet", id: randomUUID(), from: this.peerId, to, title, text });
    return { ok: true };
  }

  drainInbox(): Snippet[] {
    return this.inbox.splice(0);
  }

  // ── local HTTP API ──────────────────────────────────────────────────

  private authorized(req: IncomingMessage): boolean {
    const got = Buffer.from(req.headers.authorization ?? "");
    const want = Buffer.from(`Bearer ${this.token}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private async handleHttp(req: IncomingMessage): Promise<[number, unknown]> {
    if (!this.authorized(req)) return [401, { error: "unauthorized" }];
    const route = `${req.method} ${req.url}`;
    if (route === "GET /peers") {
      return [200, this.onlinePeers().map(({ name, project, lastSeen }) => ({ name, project, lastSeen }))];
    }
    if (route === "GET /inbox") return [200, this.drainInbox()];
    const body = await readJson(req);
    if (route === "POST /ask") {
      if (typeof body.question !== "string") return [400, { error: "question required" }];
      return [200, await this.ask(body.question, body)];
    }
    if (route === "POST /snippet") {
      if (typeof body.title !== "string" || typeof body.text !== "string") {
        return [400, { error: "title and text required" }];
      }
      return [200, this.snippet(body.title, body.text, body.peer)];
    }
    return [404, { error: "not found" }];
  }
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
