import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i

/** A pairing code like `k7q2-9xmd-4tpa` (~59 bits). */
export function generateCode(): string {
  const bytes = randomBytes(12);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

export function normalizeCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The only value derived from the code that the relay ever sees. */
export function roomIdFor(code: string): string {
  return createHash("sha256").update("claude-share/room/" + normalizeCode(code)).digest("hex");
}

export function keyFor(code: string): Buffer {
  return scryptSync(normalizeCode(code), "claude-share/key", 32);
}

/** AES-256-GCM; output is base64(nonce | ciphertext | tag). */
export function seal(key: Buffer, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** Returns null if the frame was not sealed with this key or was tampered with. */
export function open(key: Buffer, sealed: string): string | null {
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
