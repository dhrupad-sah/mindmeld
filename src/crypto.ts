import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i

function randomChars(n: number): string {
  // Rejection sampling keeps every character uniformly likely.
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < limit && out.length < n) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

/** A random 256-bit group secret, shared by every paired member. Never leaves a machine in the clear. */
export function generateGroupSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * A one-time invite code like `k7q2-9xmd-4tpa`. The first group is a rendezvous id the relay
 * sees; the last two groups (~39 bits) are the SPAKE2 password, which the relay never sees.
 */
export function generateInviteCode(): string {
  const c = randomChars(12);
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

export function parseInviteCode(code: string): { rendezvous: string; password: string } | null {
  const c = code.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (c.length !== 12 || [...c].some((ch) => !ALPHABET.includes(ch))) return null;
  return { rendezvous: c.slice(0, 4), password: c.slice(4) };
}

/** The only value derived from the group secret that the relay ever sees. */
export function roomIdFor(secret: string): string {
  return createHash("sha256").update("claude-share/room/" + secret).digest("hex");
}

export function keyFor(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "hex"), "claude-share/salt", "claude-share/key", 32));
}

/** AES-256-GCM; output is base64(nonce | ciphertext | tag). */
export function seal(key: Uint8Array, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** Returns null if the frame was not sealed with this key or was tampered with. */
export function open(key: Uint8Array, sealed: string): string | null {
  try {
    const buf = Buffer.from(sealed, "base64");
    if (buf.length < 28) return null;
    const nonce = buf.subarray(0, 12);
    const tag = buf.subarray(buf.length - 16);
    const body = buf.subarray(12, buf.length - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
