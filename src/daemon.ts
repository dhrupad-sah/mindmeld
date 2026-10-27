import { randomUUID } from "node:crypto";
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
  session?: string;
  activeAt?: number;
  lastSeen: number;
}

export interface DaemonOptions {
  /** Group secret from pairing. */
  secret: string;
  relay: string;
  name: string;
  project: string;
  decide: Decide;
  /** Describes the Claude session behind this daemon, re-read on every hello. */
  sessionInfo?: () => { label?: string; activeAt?: number };
  rateLimit?: { max: number; windowMs: number };
}

interface PendingAsk {
  resolve: (r: { from: string; text: string } | { error: string }) => void;
  expected: number;
  declines: string[];
}

export class Daemon extends EventEmitter {
  readonly peerId = randomUUID();
  private readonly key: Buffer;
  private readonly roomUrl: string;
  private ws: WebSocket | null = null;
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

  start(): void {
    this.connect();
    this.helloTimer = setInterval(() => this.sendHello(), HELLO_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.helloTimer) clearInterval(this.helloTimer);
    this.send({ type: "bye", peer: this.peerId });
    this.ws?.close();
    for (const p of this.pending.values()) p.resolve({ error: "daemon stopped" });
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
    let info: { label?: string; activeAt?: number } = {};
    try {
      info = this.opts.sessionInfo?.() ?? {};
    } catch {
      // best-effort metadata
    }
    this.send({
      type: "hello",
      peer: this.peerId,
      name: this.opts.name,
      project: this.opts.project,
      session: info.label,
      activeAt: info.activeAt,
    });
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
        this.peers.set(p.peer, {
          peer: p.peer,
          name: p.name,
          project: p.project,
          session: p.session,
          activeAt: p.activeAt,
          lastSeen: Date.now(),
        });
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

  // ── outgoing operations ─────────────────────────────────────────────

  /**
   * Pick the one peer connection a message should go to. Each open Claude session is its own
   * peer, so "sarim" may match several: route to the most recently active session.
   * `peer` may be a peer id, a full name, or a first name (case-insensitive).
   */
  private route(peer?: string): PeerInfo | { error: string } {
    const online = this.onlinePeers();
    if (online.length === 0) return { error: "no peers online" };
    let matches: PeerInfo[];
    if (peer) {
      const q = peer.trim().toLowerCase();
      matches = online.filter(
        (p) => p.peer === peer || p.name.toLowerCase() === q || p.name.toLowerCase().split(/\s+/)[0] === q,
      );
      if (matches.length === 0) {
        const names = [...new Set(online.map((p) => p.name))].join(", ");
        return { error: `"${peer}" is not online (online: ${names})` };
      }
    } else {
      const names = new Set(online.map((p) => p.name));
      if (names.size > 1) return { error: `several people are online (${[...names].join(", ")}); say who to ask` };
      matches = online;
    }
    return matches.reduce((best, p) => ((p.activeAt ?? 0) > (best.activeAt ?? 0) ? p : best));
  }

  ask(question: string, opts: { peer?: string; context?: string; timeoutSec?: number } = {}) {
    const target = this.route(opts.peer);
    if ("error" in target) return Promise.resolve(target);
    const id = randomUUID();
    const timeoutSec = opts.timeoutSec ?? 600;
    return new Promise<{ from: string; text: string } | { error: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: `no answer within ${timeoutSec}s` });
      }, timeoutSec * 1000);
      this.pending.set(id, {
        expected: 1,
        declines: [],
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      this.send({ type: "ask", id, from: this.peerId, to: target.peer, question, context: opts.context });
    });
  }

  snippet(title: string, text: string, peer?: string): { ok: true; to: string } | { error: string } {
    const target = this.route(peer);
    if ("error" in target) return target;
    this.send({ type: "snippet", id: randomUUID(), from: this.peerId, to: target.peer, title, text });
    return { ok: true, to: target.name };
  }

  drainInbox(): Snippet[] {
    return this.inbox.splice(0);
  }
}
