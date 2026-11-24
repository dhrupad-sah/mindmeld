import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { z } from "zod";
import type { Session } from "./auth/session.js";
import type { Channel, PayloadSender, ServerInfo } from "./channel.js";
import type { DeviceIdentity } from "./identity.js";
import { Payload, PING_INTERVAL_MS } from "./protocol.js";
import { openFrame, sealFrame, type TeamFrame } from "./teamcrypto.js";
import { fetchRoster, fetchTeamKeys, httpBase, rosterDevices } from "./teamkeys.js";

export interface TeamChannelOptions {
  /** Relay base URL (http(s):// or ws(s)://). */
  relayHttp: string;
  teamId: string;
  session: Session;
  id: DeviceIdentity;
}

/** Close codes the relay uses on team sockets. */
export const TEAM_CLOSE = { removed: 4001, noKey: 4003, noTeam: 4004 } as const;

const TeamFrameSchema = z.object({ e: z.number().int(), dev: z.string(), d: z.string(), sig: z.string() });

/** What the relay sends on a team socket. `c` and `login` are routing hints only, never identity. */
const TeamMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("server"), latest: z.string(), minimum: z.string(), epoch: z.number() }),
  z.object({ t: z.literal("joined"), c: z.string(), login: z.string() }),
  z.object({ t: z.literal("left"), c: z.string(), login: z.string() }),
  z.object({ t: z.literal("roster") }),
  z.object({ t: z.literal("msg"), f: TeamFrameSchema, c: z.string(), login: z.string() }),
]);

const RETRY_MS = 2000;
const CLOSE_TIMEOUT_MS = 1000;
/** A device without a key waits for one to be wrapped for it; no need to knock every 2s. */
const NO_KEY_RETRY_MS = 30_000;
/** Frames for an epoch this client has no key for yet, held until the next key refresh. */
const MAX_HELD = 64;

/**
 * The team transport: one socket at /v1/teams/:id/ws (bearer token in the Authorization header).
 * Every frame is sealed with the current epoch's team key and signed by this device; incoming frames
 * are verified with `openFrame` against the roster, and the sender's login comes from that signature.
 * The roster and verified keys are fetched on start, on reconnect, and whenever the relay says the
 * roster changed. Emits the Channel events plus "closed" (code, reason) and "status" (reason | null).
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
  private reason: string | null = null;
  /** Encrypted frames this client has sent; lets tests check that idle sessions stay quiet. */
  framesSent = 0;

  constructor(private readonly opts: TeamChannelOptions) {
    super();
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
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
   * Why the channel is not working normally, for the status line: "no team key yet", "removed from
   * team", or a key verification failure such as "team key for epoch 3 failed verification (...)".
   * Null when all is well.
   */
  get status(): string | null {
    return this.reason ?? this.keyProblems.find((p) => p.includes(`epoch ${this.currentEpoch} `)) ?? null;
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
        do {
          this.refreshAgain = false;
          const { relayHttp, teamId, session, id } = this.opts;
          const roster = await fetchRoster(relayHttp, teamId, session);
          const k = await fetchTeamKeys(relayHttp, teamId, session, id, roster);
          this.roster = rosterDevices(roster);
          this.keys = k.keys;
          this.currentEpoch = Math.max(k.epoch, roster.epoch);
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
    try {
      await this.refresh();
    } catch (e) {
      this.emit("relay-error", e);
      const status = (e as { status?: number }).status;
      if (status === 403 || status === 404) {
        // Not (or no longer) in this team: retrying will not help.
        this.stopped = true;
        this.setReason(status === 403 ? "removed from team" : "no such team");
        this.emit("closed", status === 403 ? TEAM_CLOSE.removed : TEAM_CLOSE.noTeam, this.reason);
        return;
      }
      setTimeout(() => void this.connect(), RETRY_MS).unref?.();
      return;
    }
    if (this.stopped) return;
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
    ws.on("error", (e) => this.emit("relay-error", e));
    ws.on("close", (code, buf) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      const wasAdmitted = this.admitted;
      this.admitted = false;
      this.cidLogin.clear();
      const reason = buf.toString();
      this.emit("closed", code, reason);
      let delay = RETRY_MS;
      if (code === TEAM_CLOSE.removed || code === TEAM_CLOSE.noTeam) {
        this.stopped = true;
        this.setReason(code === TEAM_CLOSE.removed ? "removed from team" : "no such team");
      } else if (code === TEAM_CLOSE.noKey) {
        this.setReason("no team key yet");
        delay = NO_KEY_RETRY_MS;
      }
      // Always reported once admitted, even when stopped, so the daemon can drop its peers.
      if (wasAdmitted) this.emit("disconnected");
      if (this.stopped) return;
      setTimeout(() => void this.connect(), delay).unref?.();
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
        if (msg.epoch !== this.currentEpoch) void this.refresh().catch((e) => this.emit("relay-error", e));
        if (!this.admitted) {
          this.admitted = true;
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
        void this.refresh().catch((e) => this.emit("relay-error", e));
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
      void this.refresh().catch((e) => this.emit("relay-error", e));
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
