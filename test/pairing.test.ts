import type { Server } from "node:http";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateGroupSecret, generateInviteCode, parseInviteCode } from "../src/crypto.js";
import { runInviter, runJoiner } from "../src/pairing.js";
import { startRelay } from "../src/relay.js";

let relay: Server;
let relayUrl: string;

// RELAY_URL=ws://… runs the suite against an external relay (e.g. the Cloudflare Worker).
beforeEach(async () => {
  if (process.env.RELAY_URL) {
    relayUrl = process.env.RELAY_URL;
    return;
  }
  relay = await startRelay(0, "127.0.0.1");
  relayUrl = `ws://127.0.0.1:${(relay.address() as { port: number }).port}`;
});
afterEach(async () => {
  if (process.env.RELAY_URL) return;
  relay.closeAllConnections?.();
  await new Promise((r) => relay.close(r));
});

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

describe("pairing", () => {
  it("hands the group secret to a joiner with the right code", async () => {
    const code = generateInviteCode();
    const secret = generateGroupSecret();
    const inviter = runInviter({ relay: relayUrl, code, secret, name: "dhrupad" });
    await tick();
    const joined = await runJoiner({ relay: relayUrl, code: code.toUpperCase(), name: "sarim" });
    expect(joined).toEqual({ secret, inviterName: "dhrupad" });
    expect(await inviter).toEqual({ peerName: "sarim" });
  });

  it("fails on both sides with a wrong code and leaks no secret", async () => {
    const code = generateInviteCode();
    const { rendezvous } = parseInviteCode(code)!;
    const wrong = `${rendezvous}-aaaa-aaaa`;
    const inviter = runInviter({ relay: relayUrl, code, secret: generateGroupSecret(), name: "a" });
    const inviterResult = inviter.catch((e) => e as Error);
    await tick();
    await expect(runJoiner({ relay: relayUrl, code: wrong, name: "mallory" })).rejects.toThrow(/wrong code/);
    expect(String(await inviterResult)).toMatch(/wrong code|closed/);
  });

  it("lets only two sockets into a pairing room", async () => {
    const code = generateInviteCode();
    const { rendezvous } = parseInviteCode(code)!;
    const a = new WebSocket(`${relayUrl}/pair/${rendezvous}`);
    const b = new WebSocket(`${relayUrl}/pair/${rendezvous}`);
    await Promise.all([a, b].map((s) => new Promise((r) => s.once("open", r))));
    await expect(runJoiner({ relay: relayUrl, code, name: "third" })).rejects.toThrow(/already in use/);
    a.close();
    b.close();
  });

  it("times out if nobody joins", async () => {
    await expect(
      runInviter({ relay: relayUrl, code: generateInviteCode(), secret: generateGroupSecret(), name: "a", timeoutMs: 100 }),
    ).rejects.toThrow(/timed out/);
  });
});
