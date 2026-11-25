import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type Channel, GroupChannel, type PayloadSender, type SendTarget, type ServerInfo } from "./channel.js";
import { ACTIVITY_CHECK_MS, ACTIVITY_RESOLUTION_MS, Payload, PROTOCOL_VERSION } from "./protocol.js";

type Ask = Extract<Payload, { type: "ask" }>;
type Snippet = Extract<Payload, { type: "snippet" }>;

export type Decision = { action: "send"; text: string } | { action: "decline"; reason: string };
/** Decides how to respond to an incoming question (interactive prompt, auto-fork, or test stub). */
export type AskState = Extract<Payload, { type: "status" }>["state"];
export type Decide = (ask: Ask, report: (state: AskState) => void) => Promise<Decision>;
export type AskResult = { from: string; text: string } | { error: string };

export interface PeerInfo {
  peer: string;
  name: string;
  project: string;
  session?: string;
  activeAt?: number;
  v?: number;
  /** Relay connection id, so a "left" event can remove this peer at once. */
  cid?: string;
  lastSeen: number;
}

export type { ServerInfo };

export interface DaemonOptions {
  /** Group secret from pairing. Needed to build a GroupChannel when no `channel` is given. */
  secret?: string;
  relay: string;
  /** Transport to run over. Defaults to a GroupChannel built from `secret` / `relay`. */
  channel?: Channel;
  name: string;
  project: string;
  decide: Decide;
  /** Describes the Claude session behind this daemon, re-read on every hello. */
  sessionInfo?: () => { activeAt?: number };
  /**
   * Shared sessions are listed to the group and can be asked questions. Unshared ones are
   * invisible: they can still ask, but never announce themselves or answer. Default: shared.
   */
  share?: { label: string } | null;
  /** How long an ask waits for the target to acknowledge before failing (v2+ peers). */
  ackTimeoutMs?: number;
  /** Client version sent to the relay. Defaults to this build's version. */
  version?: string;
  /** Override for tests: how often to check whether "last active" should be re-announced. */
  activityCheckMs?: number;
  rateLimit?: { max: number; windowMs: number };
}

interface PendingAsk {
  /** Peer id the question went to, so it can fail fast if that connection drops. */
  target: string;
  resolve: (r: AskResult) => void;
  onStatus?: (state: AskState) => void;
  acked: boolean;
  expected: number;
  declines: string[];
}

/** A directed payload the channel could not address (e.g. the peer's device is no longer on the team roster). */
const unreachable = (name: string) => `can't reach ${name}'s session right now`;
/** Peer-id ownership bindings kept, so hello spam with random peer ids stays bounded. */
const MAX_PEER_OWNERS = 1000;

export class Daemon extends EventEmitter {
  readonly peerId = randomUUID();
  private readonly channel: Channel;
  private activityTimer: NodeJS.Timeout | null = null;
  private lastSentActive = 0;
  private _stopped = false;
  private readonly peers = new Map<string, PeerInfo>();
  private readonly pending = new Map<string, PendingAsk>();
  private readonly inbox: Snippet[] = [];
  private readonly askLog = new Map<string, number[]>();
  /**
   * Verified login that first used each peer id (only for channels that report logins). A hello,
   * bye or reply for that peer id from any other login is ignored. Bounded by MAX_PEER_OWNERS: beyond
   * it, the oldest bindings of peers that are not online are forgotten.
   */
  private readonly peerOwner = new Map<string, string>();
  private share: { label: string } | null;

  constructor(private readonly opts: DaemonOptions) {
    super();
    this.share = opts.share === undefined ? { label: opts.project } : opts.share;
    if (!opts.channel && !opts.secret) throw new Error("no group secret and no channel");
    this.channel = opts.channel ?? new GroupChannel({ secret: opts.secret!, relay: opts.relay, version: opts.version });
    this.wireChannel();
  }

  /** Encrypted frames this client has sent (only transports that count them report it). */
  get framesSent(): number {
    return (this.channel as { framesSent?: number }).framesSent ?? 0;
  }

  /** No reconnect and no "disconnected" event once stopped. Also forwarded to the channel (tests crash a daemon this way). */
  get stopped(): boolean {
    return this._stopped;
  }
  set stopped(v: boolean) {
    this._stopped = v;
    if ("stopped" in this.channel) (this.channel as { stopped: boolean }).stopped = v;
  }

  /** The channel's socket, if it has one. Kept so tests can kill the connection. */
  get ws(): { terminate(): void } | null {
    return (this.channel as { ws?: { terminate(): void } | null }).ws ?? null;
  }

  start(): void {
    this.channel.start();
    // Re-announce only when "last active" moved enough to matter for routing; no heartbeat.
    this.activityTimer = setInterval(() => {
      if (!this.share) return;
      const at = this.activeAt();
      if (at && at - this.lastSentActive >= ACTIVITY_RESOLUTION_MS) this.sendHello();
    }, this.opts.activityCheckMs ?? ACTIVITY_CHECK_MS);
    this.activityTimer.unref?.();
  }

  /** Version info from the relay: latest, minimum, and how many teammates run an old client. */
  get server(): ServerInfo | null {
    return this.channel.server;
  }

  async stop(): Promise<void> {
    this._stopped = true;
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.send({ type: "bye", peer: this.peerId });
    const stopping = this.channel.stop();
    for (const p of this.pending.values()) p.resolve({ error: "daemon stopped" });
    await stopping;
  }

  /** Peers present right now. The relay reports leaves, so there is no timeout to wait out. */
  onlinePeers(): PeerInfo[] {
    return [...this.peers.values()];
  }

  // ── channel events ──────────────────────────────────────────────────

  private wireChannel(): void {
    const ch = this.channel;
    ch.on("connected", () => {
      // Connection ids from a previous connection are meaningless now; shared peers re-announce
      // themselves in response to our "joined".
      this.peers.clear();
      this.emit("connected");
      this.sendHello();
    });
    ch.on("disconnected", () => {
      for (const peer of [...this.peers.values()]) this.dropPeer(peer.peer, "disconnected from the relay");
      if (!this._stopped) this.emit("disconnected");
    });
    ch.on("relay-error", (e) => this.emit("relay-error", e));
    ch.on("server", (info) => this.emit("server", info));
    ch.on("blocked", (info) => {
      this._stopped = true;
      this.emit("blocked", info);
    });
    ch.on("joined", () => {
      if (this.share) this.sendHello(); // let the newcomer see this shared session
    });
    ch.on("left", (cid: string) => {
      for (const p of [...this.peers.values()]) if (p.cid === cid) this.dropPeer(p.peer, "closed");
    });
    ch.on("payload", (p: Payload, from: PayloadSender) => this.handlePayload(p, from));
  }

  /**
   * Hand a payload to the channel. Directed payloads carry their recipient (`to`); presence (hello,
   * bye) never does. False when the channel cannot resolve the recipient (nothing was sent).
   */
  private send(p: Payload, to?: SendTarget): boolean {
    return this.channel.send(p, to);
  }

  get connected(): boolean {
    return this.channel.connected;
  }

  /** The name this daemon announces itself as (the login, on a team). */
  get name(): string {
    return this.opts.name;
  }

  get sharing(): { label: string } | null {
    return this.share;
  }

  /** Start or stop sharing this session with the group. */
  setShare(share: { label: string } | null): void {
    const was = this.share;
    this.share = share;
    if (share) this.sendHello();
    else if (was) this.send({ type: "bye", peer: this.peerId });
  }

  private sendHello(): void {
    if (!this.share) return; // unshared sessions never announce themselves
    const activeAt = this.activeAt();
    if (activeAt) this.lastSentActive = activeAt;
    const info = { activeAt };
    this.send({
      type: "hello",
      peer: this.peerId,
      name: this.opts.name,
      project: this.share.label,
      activeAt: info.activeAt,
      v: PROTOCOL_VERSION,
    });
  }

  private activeAt(): number | undefined {
    try {
      return this.opts.sessionInfo?.().activeAt;
    } catch {
      return undefined; // best-effort metadata
    }
  }

  /** Forget a peer, and fail any question still waiting on it instead of letting it time out. */
  private dropPeer(peerId: string, why: string): void {
    const info = this.peers.get(peerId);
    if (!info) return;
    this.peers.delete(peerId);
    this.emit("peer-left", info);
    for (const [id, p] of this.pending) {
      if (p.target === peerId) {
        this.pending.delete(id);
        p.resolve({ error: `${info.name}'s session ${why} before answering` });
      }
    }
  }

  /** False if `login` (a verified identity key) is set and the peer id was first seen from a different one; binds it otherwise. */
  private ownsPeer(peerId: string, login: string | undefined): boolean {
    if (login === undefined) return true;
    const owner = this.peerOwner.get(peerId);
    if (owner === undefined) {
      this.peerOwner.set(peerId, login);
      if (this.peerOwner.size > MAX_PEER_OWNERS) {
        for (const old of this.peerOwner.keys()) {
          if (this.peerOwner.size <= MAX_PEER_OWNERS) break;
          if (!this.peers.has(old) && old !== peerId) this.peerOwner.delete(old);
        }
      }
    }
    return owner === undefined || owner === login;
  }

  /** False if a reply to a question came from a login other than the one that owns the asked peer. */
  private fromTarget(pending: PendingAsk, login: string | undefined): boolean {
    if (login === undefined) return true;
    const owner = this.peerOwner.get(pending.target);
    return owner === undefined || owner === login;
  }

  private handlePayload(p: Payload, from: PayloadSender): void {
    // An authenticated login beats any name the payload claims for itself (it is the display name).
    const login = from.login;
    // Ownership binds to the most stable verified identity: the GitHub id on a team, else the login.
    const owner = from.uid !== undefined ? `uid:${from.uid}` : login;
    if ((p.type === "hello" || p.type === "bye") && !this.ownsPeer(p.peer, owner)) return;
    switch (p.type) {
      case "hello": {
        const isNew = !this.peers.has(p.peer);
        this.peers.set(p.peer, {
          peer: p.peer,
          name: login ?? p.name,
          project: p.project,
          session: p.session,
          activeAt: p.activeAt,
          v: p.v,
          cid: from.cid,
          lastSeen: Date.now(),
        });
        if (isNew) this.emit("peer-joined", this.peers.get(p.peer));
        break;
      }
      case "bye":
        this.dropPeer(p.peer, "stopped sharing");
        break;
      case "ask":
        // Only a shared session answers, and only questions addressed to it (or legacy broadcasts).
        if (this.share && (!p.to || p.to === this.opts.name || p.to === this.peerId)) void this.handleAsk(p, login, owner, from.device);
        break;
      case "status": {
        const pending = this.pending.get(p.id);
        if (pending && this.fromTarget(pending, owner)) {
          pending.acked = true;
          pending.onStatus?.(p.state);
        }
        break;
      }
      case "answer": {
        const pending = this.pending.get(p.id);
        if (pending && this.fromTarget(pending, owner)) {
          this.pending.delete(p.id);
          pending.resolve({ from: this.nameOf(p.from, undefined, login), text: p.text });
        }
        break;
      }
      case "decline": {
        const pending = this.pending.get(p.id);
        if (!pending || !this.fromTarget(pending, owner)) break;
        pending.declines.push(`${this.nameOf(p.from, undefined, login)}: ${p.reason}`);
        if (pending.declines.length >= pending.expected) {
          this.pending.delete(p.id);
          pending.resolve({ error: `declined — ${pending.declines.join("; ")}` });
        }
        break;
      }
      case "snippet":
        if (!p.to || p.to === this.opts.name || p.to === this.peerId) {
          this.inbox.push({ ...p, from: this.nameOf(p.from, undefined, login) });
          this.emit("snippet", p);
        }
        break;
    }
  }

  private nameOf(peerId: string, fallback?: string, login?: string): string {
    return login ?? this.peers.get(peerId)?.name ?? fallback ?? peerId.slice(0, 8);
  }

  private rateLimited(from: string): boolean {
    const { max, windowMs } = this.opts.rateLimit ?? { max: 10, windowMs: 10 * 60_000 };
    const now = Date.now();
    const recent = (this.askLog.get(from) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    this.askLog.set(from, recent);
    return recent.length > max;
  }

  private readonly seenAsks = new Set<string>();

  private async handleAsk(ask: Ask, login?: string, owner?: string, device?: string): Promise<void> {
    if (this.seenAsks.has(ask.id)) return; // a resend of a question already being handled
    this.seenAsks.add(ask.id);
    // Replies go back to the device the question came from (askers never send a hello).
    const asker: SendTarget = { device };
    const reply = (d: Decision) =>
      d.action === "send"
        ? this.send({ type: "answer", id: ask.id, from: this.peerId, text: d.text }, asker)
        : this.send({ type: "decline", id: ask.id, from: this.peerId, reason: d.reason }, asker);

    const report = (state: AskState) => void this.send({ type: "status", id: ask.id, from: this.peerId, state }, asker);
    report("received");
    // A verified identity cannot dodge the limit by rotating peer ids.
    if (this.rateLimited(owner ?? login ?? ask.from)) {
      reply({ action: "decline", reason: "rate limited — too many questions, try again later" });
      return;
    }
    const from = this.nameOf(ask.from, ask.fromName, login);
    this.emit("question", { from, question: ask.question });
    try {
      const d = await this.opts.decide({ ...ask, from, fromName: from }, report);
      this.emit("handled", { from, question: ask.question, action: d.action });
      reply(d);
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

  ask(
    question: string,
    opts: { peer?: string; context?: string; timeoutSec?: number; onStatus?: (state: AskState) => void } = {},
  ): Promise<AskResult> {
    if (!this.connected) return Promise.resolve({ error: "not connected to the relay right now; try again in a moment" });
    const target = this.route(opts.peer);
    if ("error" in target) return Promise.resolve(target);
    const id = randomUUID();
    const timeoutSec = opts.timeoutSec ?? 600;
    return new Promise<AskResult>((resolve) => {
      const timers: NodeJS.Timeout[] = [];
      const finish = (r: AskResult) => {
        timers.forEach(clearTimeout);
        this.pending.delete(id);
        resolve(r);
      };
      timers.push(setTimeout(() => finish({ error: `no answer within ${timeoutSec}s` }), timeoutSec * 1000));
      // Peers from 0.4 on acknowledge at once; older ones don't, so only hold newer ones to it.
      const to: SendTarget = { peer: target.peer };
      const payload: Payload = { type: "ask", id, from: this.peerId, fromName: this.opts.name, to: target.peer, question, context: opts.context };
      if ((target.v ?? 0) >= 2) {
        // Not acknowledged halfway through the window: resend once (a frame can be lost while
        // the socket reconnects). The answering side ignores duplicate ids.
        const ackMs = this.opts.ackTimeoutMs ?? 15_000;
        timers.push(setTimeout(() => !this.pending.get(id)?.acked && this.send(payload, to), ackMs / 2));
        timers.push(
          setTimeout(() => {
            if (!this.pending.get(id)?.acked) {
              finish({ error: `${target.name}'s session didn't acknowledge the question. It may have just closed or stopped sharing.` });
            }
          }, ackMs),
        );
      }
      this.pending.set(id, { target: target.peer, resolve: finish, onStatus: opts.onStatus, acked: false, expected: 1, declines: [] });
      if (!this.send(payload, to)) finish({ error: unreachable(target.name) });
    });
  }

  snippet(title: string, text: string, peer?: string): { ok: true; to: string } | { error: string } {
    const target = this.route(peer);
    if ("error" in target) return target;
    if (!this.send({ type: "snippet", id: randomUUID(), from: this.peerId, to: target.peer, title, text }, { peer: target.peer })) {
      return { error: unreachable(target.name) };
    }
    return { ok: true, to: target.name };
  }

  drainInbox(): Snippet[] {
    return this.inbox.splice(0);
  }
}
