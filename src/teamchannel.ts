import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { z } from "zod";
import type { Session } from "./auth/session.js";
import type { Channel, PayloadSender, ServerInfo } from "./channel.js";
import { sameRelay } from "./config.js";
import type { DeviceIdentity } from "./identity.js";
import { Payload, PING_INTERVAL_MS } from "./protocol.js";
import { openFrame, sealFrame, type TeamFrame } from "./teamcrypto.js";
import { distributeKeys, fetchRoster, fetchTeamKeys, httpBase, rosterDevices, WAITING_FOR_KEY } from "./teamkeys.js";

export interface TeamChannelOptions {
  /** Relay base URL (http(s):// or ws(s)://). */
  relayHttp: string;
  teamId: string;
  session: Session;
  id: DeviceIdentity;
  /** Reconnect backoff (tests shrink it). Default: 2s doubling to 60s. */
  retry?: { baseMs: number; maxMs: number };
  /**
   * First retry delay while this device has no team key; doubles per attempt up to 30s, reset once
   * admitted (tests shrink it). Default 1s.
   */
  noKeyRetryMs?: number;
}

/** Shown when the relay refuses the session token (or it has expired locally). */
export const SIGN_IN_EXPIRED = "sign-in expired; run /mindmeld:login";

/**
 * Reconnect delay after `failures` consecutive failures: base * 2^failures, capped at `maxMs`,
 * with +/-20% jitter so a relay outage does not get every client back in lockstep.
 */
export function backoffDelay(failures: number, baseMs: number, maxMs: number, rand = Math.random()): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.min(failures, 30));
  return Math.round(exp * (0.8 + 0.4 * rand));
}

/** Close codes the relay uses on team sockets. */
export const TEAM_CLOSE = { removed: 4001, noKey: 4003, noTeam: 4004, signedOut: 4401 } as const;

const TeamFrameSchema = z.object({ e: z.number().int(), dev: z.string(), d: z.string(), sig: z.string() });

/** What the relay sends on a team socket. `c` and `login` are routing hints only, never identity. */
const TeamMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("server"), latest: z.string(), minimum: z.string(), epoch: z.number() }),
  z.object({ t: z.literal("joined"), c: z.string(), login: z.string() }),
  z.object({ t: z.literal("left"), c: z.string(), login: z.string() }),
  z.object({ t: z.literal("roster") }),
  z.object({ t: z.literal("msg"), f: TeamFrameSchema, c: z.string(), login: z.string() }),
]);

const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60_000;
const CLOSE_TIMEOUT_MS = 1000;
/**
 * A device without a key waits for a teammate to wrap one for it. On a normal onboarding the
 * teammate is online and delivers within moments, so start short and back off to 30s.
 */
const NO_KEY_RETRY_BASE_MS = 1000;
const NO_KEY_RETRY_MAX_MS = 30_000;
/** Frames for an epoch this client has no key for yet, held until the next key refresh. */
const MAX_HELD = 64;
/** Key-distribution passes per refresh (each write is followed by a refetch). */
const MAX_DISTRIBUTE_PASSES = 3;

/**
 * The team transport: one socket at /v1/teams/:id/ws (bearer token in the Authorization header).
 * Every frame is sealed with the current epoch's team key and signed by this device; incoming frames
 * are verified with `openFrame` against the roster, and the sender's login comes from that signature.
 * The roster and verified keys are fetched on start, on reconnect, and whenever the relay says the
 * roster changed. Each fetch is followed by `distributeKeys` (see `ensureTeamKeys`): an admin creates
 * the first key, a device holding the key delivers it to roster devices that lack one, and a device
 * without one reports WAITING_FOR_KEY as its status until a teammate delivers it (picked up on the
 * no-key retry). Emits the Channel events plus "closed" (code, reason) and "status" (reason | null).
 */
export class TeamChannel extends EventEmitter implements Channel {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private serverInfo: ServerInfo | null = null;
  private admitted = false;
  private stopped = false;
  private roster = new Map<string, { login: string; signPub: string }>();
  private keys = new Map<number, Uint8Array>();
  private currentEpoch = 0;
  /** Relay connection id -> the verified login of its first frame. */
  private readonly cidLogin = new Map<string, string>();
  private held: { f: TeamFrame; c: string; login: string }[] = [];
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private keyProblems: string[] = [];
  /** The last refresh found no usable key for the current epoch. */
  private waiting = false;
  private reason: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  /** Consecutive failed connection attempts; reset once the relay admits this device. */
  private failures = 0;
  /** Consecutive "no team key yet" closes; reset once the relay admits this device. */
  private noKeyAttempts = 0;
  /** Set when the relay answered 401 to the WebSocket upgrade. */
  private authRefused = false;
  /** `terminal` ran: its "closed" event was the last one. */
  private finished = false;
  /** Encrypted frames this client has sent; lets tests check that idle sessions stay quiet. */
  framesSent = 0;

  constructor(private readonly opts: TeamChannelOptions) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.finished = false;
    this.failures = 0;
    this.noKeyAttempts = 0;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  /** Try again after `delayMs`, or else the connection-failure backoff. Emits "retry" (delayMs). */
  private scheduleRetry(delayMs?: number): void {
    if (this.stopped) return;
    const { baseMs, maxMs } = this.opts.retry ?? { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS };
    const delay = delayMs ?? backoffDelay(this.failures++, baseMs, maxMs);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref?.();
    this.emit("retry", delay);
  }

  /** Stop for good: retrying cannot help (signed out, removed, no such team). */
  private terminal(code: number, reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setReason(reason);
    if (reason === SIGN_IN_EXPIRED) this.emit("auth-expired", reason);
    this.emit("closed", code, reason);
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  }

  /** A roster/keys fetch failed: 401/403/404 end the channel; anything else is reported. */
  private refreshFailed(e: unknown): boolean {
    this.emit("relay-error", e);
    const status = (e as { status?: number }).status;
    if (status === 401) this.terminal(TEAM_CLOSE.signedOut, SIGN_IN_EXPIRED);
    else if (status === 403) this.terminal(TEAM_CLOSE.removed, "removed from team");
    else if (status === 404) this.terminal(TEAM_CLOSE.noTeam, "no such team");
    else return false;
    return true;
  }

  /** Admitted by the relay (socket open and the relay's "server" hello received). */
  get connected(): boolean {
    return this.admitted && this.ws?.readyState === WebSocket.OPEN;
  }

  get server(): ServerInfo | null {
    return this.serverInfo;
  }

  /** Current team epoch as far as this client knows. */
  get epoch(): number {
    return this.currentEpoch;
  }

  /**
   * Why the channel is not working normally, for the status line: WAITING_FOR_KEY, "no team key
   * yet", "removed from team", or a key verification failure such as "team key for epoch 3 failed
   * verification (...)". Null when all is well.
   */
  get status(): string | null {
    const problem = this.keyProblems.find((p) => p.includes(`epoch ${this.currentEpoch} `));
    return this.reason ?? problem ?? (this.waiting && !this.admitted ? WAITING_FOR_KEY : null);
  }

  send(p: Payload): void {
    const key = this.keys.get(this.currentEpoch);
    if (!this.connected || !key) return;
    const f = sealFrame(this.currentEpoch, key, this.opts.id, JSON.stringify(p));
    this.ws!.send(JSON.stringify({ t: "msg", f }));
    this.framesSent++;
  }

  private setReason(r: string | null): void {
    if (r === this.reason) return;
    this.reason = r;
    this.emit("status", this.status);
  }

  /** Fetch the roster and verified keys; concurrent calls share one fetch, plus one rerun if asked again. */
  private refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        let passes = 0;
        do {
          this.refreshAgain = false;
          const { relayHttp, teamId, session, id } = this.opts;
          const roster = await fetchRoster(relayHttp, teamId, session);
          const k = await fetchTeamKeys(relayHttp, teamId, session, id, roster);
          if (passes++ < MAX_DISTRIBUTE_PASSES) {
            try {
              if ((await distributeKeys({ relayHttp, teamId, session, id }, roster, k)).wrote) this.refreshAgain = true;
            } catch (e) {
              const s = (e as { status?: number }).status;
              if (s === 401 || s === 403 || s === 404) throw e;
              // A race (400/409) or a relay hiccup: report it and look again; the channel still works.
              this.emit("relay-error", e);
              this.refreshAgain = true;
            }
          }
          this.roster = rosterDevices(roster);
          this.keys = k.keys;
          this.currentEpoch = Math.max(k.epoch, roster.epoch);
          this.waiting = !this.keys.has(this.currentEpoch) && !k.problems.some((p) => p.includes(`epoch ${this.currentEpoch} `));
          for (const p of k.problems) if (!this.keyProblems.includes(p)) this.emit("key-problem", p);
          this.keyProblems = k.problems;
          this.emit("status", this.status);
        } while (this.refreshAgain);
      } finally {
        this.refreshing = null;
      }
      const held = this.held.splice(0);
      for (const h of held) this.receive(h.f, h.c, h.login, false);
    })();
    return this.refreshing;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    // The token only ever goes to the relay that issued it.
    if (!this.opts.session.token || this.opts.session.expiresAt <= Date.now() / 1000 || !sameRelay(this.opts.relayHttp, this.opts.session.relay ?? "")) {
      return this.terminal(TEAM_CLOSE.signedOut, SIGN_IN_EXPIRED);
    }
    try {
      await this.refresh();
    } catch (e) {
      if (!this.refreshFailed(e)) this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    if (this.admitted) {
      // A previous socket is still winding down; its close handler will ignore it from here on.
      this.admitted = false;
      this.emit("disconnected");
    }
    this.authRefused = false;
    const url = `${httpBase(this.opts.relayHttp).replace(/^http/, "ws")}/v1/teams/${this.opts.teamId}/ws`;
    // closeTimeout: once close frames are exchanged, do not wait 30s for a peer that keeps TCP half open
    // (seen with relay-initiated closes of hibernated sockets); "closed" must arrive promptly.
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.opts.session.token}` }, closeTimeout: CLOSE_TIMEOUT_MS } as WebSocket.ClientOptions);
    this.ws = ws;
    ws.on("open", () => {
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
    ws.on("message", (data) => this.handleMessage(data.toString()));
    ws.on("error", (e) => {
      // ws reports a refused upgrade as "Unexpected server response: <status>".
      if (/Unexpected server response: 401\b/.test(e.message)) this.authRefused = true;
      this.emit("relay-error", e);
    });
    ws.on("close", (code, buf) => {
      if (ws !== this.ws) return; // a stale socket from before a restart
      if (this.pingTimer) clearInterval(this.pingTimer);
      const wasAdmitted = this.admitted;
      this.admitted = false;
      this.cidLogin.clear();
      const reason = buf.toString();
      // Always reported once admitted, even when stopped, so the daemon can drop its peers.
      if (wasAdmitted) this.emit("disconnected");
      if (this.stopped) {
        if (!this.finished) this.emit("closed", code, reason);
        return;
      }
      if (this.authRefused) return this.terminal(TEAM_CLOSE.signedOut, SIGN_IN_EXPIRED);
      if (code === TEAM_CLOSE.removed) return this.terminal(code, "removed from team");
      if (code === TEAM_CLOSE.noTeam) return this.terminal(code, "no such team");
      this.emit("closed", code, reason);
      if (code === TEAM_CLOSE.noKey) {
        this.setReason(this.waiting ? WAITING_FOR_KEY : "no team key yet");
        return this.scheduleRetry(backoffDelay(this.noKeyAttempts++, this.opts.noKeyRetryMs ?? NO_KEY_RETRY_BASE_MS, NO_KEY_RETRY_MAX_MS));
      }
      this.scheduleRetry();
    });
  }

  /** One message from the relay. */
  private handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const m = TeamMessage.safeParse(json);
    if (!m.success) return;
    const msg = m.data;
    switch (msg.t) {
      case "server":
        this.serverInfo = { t: "server", latest: msg.latest, minimum: msg.minimum };
        if (msg.epoch !== this.currentEpoch) void this.refresh().catch((e) => this.refreshFailed(e));
        if (!this.admitted) {
          this.admitted = true;
          this.failures = 0;
          this.noKeyAttempts = 0;
          this.setReason(null);
          this.emit("connected");
        }
        this.emit("server", this.serverInfo);
        break;
      case "joined":
        this.emit("joined", msg.c);
        break;
      case "left":
        this.cidLogin.delete(msg.c);
        this.emit("left", msg.c);
        break;
      case "roster":
        void this.refresh().catch((e) => this.refreshFailed(e));
        break;
      case "msg":
        this.receive(msg.f, msg.c, msg.login, true);
        break;
    }
  }

  /**
   * Verify and deliver one frame. The login is the one the signature proves (via the roster); the
   * relay's stamp must agree with it, and a connection id stays bound to the login of its first frame.
   */
  private receive(f: TeamFrame, c: string, stamped: string, mayHold: boolean): void {
    if (mayHold && !this.keys.has(f.e) && f.e > this.currentEpoch) {
      // Probably a rotation this client has not caught up with yet.
      if (this.held.length < MAX_HELD) this.held.push({ f, c, login: stamped });
      void this.refresh().catch((e) => this.refreshFailed(e));
      return;
    }
    const opened = openFrame(f, this.keys, this.roster);
    if (!opened) return;
    if (opened.login !== stamped) return;
    const bound = this.cidLogin.get(c);
    if (bound !== undefined && bound !== opened.login) return;
    let p: Payload;
    try {
      const parsed = Payload.safeParse(JSON.parse(opened.payload));
      if (!parsed.success) return;
      p = parsed.data;
    } catch {
      return;
    }
    this.cidLogin.set(c, opened.login);
    this.emit("payload", p, { cid: c, login: opened.login } satisfies PayloadSender);
  }
}
