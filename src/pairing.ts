import WebSocket from "ws";
import { open, parseInviteCode, seal } from "./crypto.js";
import { passwordScalar, Spake2, type Role } from "./spake2.js";

/**
 * One-time pairing over the relay's `/pair/<rendezvous>` room.
 *
 *   joiner (B)                      inviter (A)
 *     ── {t:"pB", p} ──────────────►
 *     ◄────────────── {t:"pA", p, c: confirmA, box: seal(Ke, {secret, name})}
 *     ── {t:"done", c: confirmB, box: seal(Ke, {name})} ►
 *
 * A wrong code fails confirmation on both sides and burns the invite.
 */

type Msg =
  | { t: "peer-joined" }
  | { t: "pB"; p: string }
  | { t: "pA"; p: string; c: string; box: string }
  | { t: "done"; c: string; box: string }
  | { t: "fail"; reason: string };

const WRONG_CODE = "pairing failed: wrong code (or someone else tried to use it). Create a new invite.";

interface Conn {
  ws: WebSocket;
  /** Frames that arrived before a handler was attached (the relay can speak the instant we open). */
  early: string[];
}

function connect(relay: string, rendezvous: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${relay.replace(/\/$/, "")}/pair/${rendezvous}`);
    const early: string[] = [];
    const buffer = (data: WebSocket.RawData) => early.push(data.toString());
    ws.on("message", buffer);
    ws.once("open", () => resolve({ ws, early }));
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(res.statusCode === 409 ? "this invite is already in use" : `relay rejected pairing (${res.statusCode})`)),
    );
    ws.once("error", (e: NodeJS.ErrnoException) =>
      reject(new Error(`can't reach relay ${relay}: ${e.message || e.code || "connection failed"}`)),
    );
  });
}

function run<T>(
  { ws, early }: Conn,
  timeoutMs: number,
  onMsg: (m: Msg, done: (v: T) => void, fail: (e: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      ws.close();
    };
    const done = (v: T) => finish(() => resolve(v));
    const fail = (e: Error) => finish(() => reject(e));
    const timer = setTimeout(() => fail(new Error("pairing timed out")), timeoutMs);
    const handle = (raw: string) => {
      if (settled) return;
      let m: Msg;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.t === "fail") return fail(new Error(WRONG_CODE));
      try {
        onMsg(m, done, fail);
      } catch (e) {
        fail(e as Error);
      }
    };
    ws.removeAllListeners("message");
    ws.on("message", (data) => handle(data.toString()));
    for (const raw of early.splice(0)) handle(raw);
    ws.on("close", () => fail(new Error("pairing connection closed before finishing")));
  });
}

function begin(code: string, role: Role) {
  const parsed = parseInviteCode(code);
  if (!parsed) throw new Error("invalid invite code (expected something like k7q2-9xmd-4tpa)");
  return { ...parsed, spake: new Spake2(role, passwordScalar(parsed.password, parsed.rendezvous)) };
}

/** Wait for someone to join with `code`, then hand them the group secret. */
export async function runInviter(opts: {
  relay: string;
  code: string;
  secret: string;
  name: string;
  timeoutMs?: number;
}): Promise<{ peerName: string }> {
  const { rendezvous, spake } = begin(opts.code, "A");
  const conn = await connect(opts.relay, rendezvous);
  const { ws } = conn;
  let key: Uint8Array | null = null;
  let verifyPeer: ((c: string) => boolean) | null = null;

  return run(conn, opts.timeoutMs ?? 15 * 60_000, (m, done, fail) => {
    if (m.t === "pB" && !key) {
      const r = spake.finish(m.p);
      key = r.key;
      verifyPeer = r.verifyPeer;
      const box = seal(key, JSON.stringify({ secret: opts.secret, name: opts.name }));
      ws.send(JSON.stringify({ t: "pA", p: spake.share, c: r.myConfirm, box }));
    } else if (m.t === "done" && key && verifyPeer) {
      const body = verifyPeer(m.c) ? open(key, m.box) : null;
      if (body === null) {
        ws.send(JSON.stringify({ t: "fail", reason: "confirmation failed" }));
        return fail(new Error(WRONG_CODE));
      }
      done({ peerName: String(JSON.parse(body).name ?? "unknown") });
    }
  });
}

/** Join a group with an invite code; returns the group secret. */
export async function runJoiner(opts: {
  relay: string;
  code: string;
  name: string;
  timeoutMs?: number;
}): Promise<{ secret: string; inviterName: string }> {
  const { rendezvous, spake } = begin(opts.code, "B");
  const conn = await connect(opts.relay, rendezvous);
  const { ws } = conn;
  let sent = false;

  return run(conn, opts.timeoutMs ?? 60_000, (m, done, fail) => {
    if (m.t === "peer-joined" && !sent) {
      sent = true;
      ws.send(JSON.stringify({ t: "pB", p: spake.share }));
    } else if (m.t === "pA") {
      const r = spake.finish(m.p);
      const body = r.verifyPeer(m.c) ? open(r.key, m.box) : null;
      if (body === null) {
        ws.send(JSON.stringify({ t: "fail", reason: "confirmation failed" }));
        return fail(new Error(WRONG_CODE));
      }
      const { secret, name } = JSON.parse(body);
      if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) return fail(new Error("inviter sent a malformed secret"));
      ws.send(JSON.stringify({ t: "done", c: r.myConfirm, box: seal(r.key, JSON.stringify({ name: opts.name })) }));
      // ws flushes queued frames before the close frame, so closing right away is safe.
      done({ secret, inviterName: String(name ?? "unknown") });
    }
  });
}
