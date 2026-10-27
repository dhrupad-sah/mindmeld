import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { scryptSync, timingSafeEqual } from "node:crypto";

/**
 * SPAKE2 (RFC 9382 structure) over ristretto255, a prime-order group.
 *
 * A low-entropy pairing password becomes a high-entropy shared key. An eavesdropper,
 * or a relay operator, learns nothing they can brute-force offline; an active attacker
 * gets exactly one online guess per run.
 *
 * Deviations from the RFC's ciphersuites, all deliberate:
 * - M and N are derived by hash-to-curve from fixed strings (verifiably nothing-up-my-sleeve)
 *   instead of the RFC's edwards25519 constants, because we use ristretto255.
 * - The transcript hash is SHA-512, giving a 32-byte Ke and a 32-byte Ka.
 * - w = scrypt(password) mod L, which also slows down online guessing.
 */

const Point = ristretto255.Point;
type Pt = InstanceType<typeof Point>;
const ORDER = Point.Fn.ORDER;
const DST = utf8ToBytes("claude-share-spake2-v1");
const M = ristretto255_hasher.hashToCurve(utf8ToBytes("claude-share/spake2/M"), { DST }) as unknown as Pt;
const N = ristretto255_hasher.hashToCurve(utf8ToBytes("claude-share/spake2/N"), { DST }) as unknown as Pt;
const ID_A = utf8ToBytes("claude-share/inviter");
const ID_B = utf8ToBytes("claude-share/joiner");

export type Role = "A" | "B";

function mod(a: bigint): bigint {
  const r = a % ORDER;
  return r >= 0n ? r : r + ORDER;
}

function bytesToBigIntLE(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function randomScalar(): bigint {
  // 64 random bytes reduced mod L: bias is negligible (~2^-260).
  let s = 0n;
  while (s === 0n) s = mod(bytesToBigIntLE(randomBytes(64)));
  return s;
}

/** Password → scalar w. The salt binds it to this pairing's rendezvous id. */
export function passwordScalar(password: string, salt: string): bigint {
  const out = scryptSync(password, "claude-share/spake2/" + salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return mod(bytesToBigIntLE(out));
}

function lenPrefixed(...parts: Uint8Array[]): Uint8Array {
  return concatBytes(
    ...parts.flatMap((p) => {
      const len = new Uint8Array(8);
      new DataView(len.buffer).setBigUint64(0, BigInt(p.length), true);
      return [len, p];
    }),
  );
}

export interface Spake2Result {
  /** 32-byte shared secret for encrypting the rest of the exchange. */
  key: Uint8Array;
  /** Confirmation MAC this side sends. */
  myConfirm: string;
  /** Checks the peer's confirmation MAC (constant-time). */
  verifyPeer: (confirm: string) => boolean;
}

export class Spake2 {
  private readonly x = randomScalar();
  /** The public share to send to the peer (hex). */
  readonly share: string;
  private readonly myBlind: Pt;
  private readonly peerBlind: Pt;

  constructor(
    private readonly role: Role,
    private readonly w: bigint,
  ) {
    this.myBlind = role === "A" ? M : N;
    this.peerBlind = role === "A" ? N : M;
    this.share = Point.BASE.multiply(this.x).add(this.myBlind.multiply(w)).toHex();
  }

  /** Combine with the peer's share. Throws on malformed or identity points. */
  finish(peerShareHex: string): Spake2Result {
    const peerShare = Point.fromHex(peerShareHex); // validates the ristretto encoding
    if (peerShare.is0()) throw new Error("invalid peer share");
    const K = peerShare.subtract(this.peerBlind.multiply(this.w)).multiply(this.x);
    if (K.is0()) throw new Error("invalid peer share");

    const [pA, pB] = this.role === "A" ? [this.share, peerShareHex] : [peerShareHex, this.share];
    const wBytes = hexToBytes(this.w.toString(16).padStart(64, "0"));
    const TT = lenPrefixed(ID_A, ID_B, hexToBytes(pA), hexToBytes(pB), K.toBytes(), wBytes);
    const h = sha512(TT);
    const Ke = h.subarray(0, 32);
    const Ka = h.subarray(32);
    const kc = hkdf(sha512, Ka, undefined, utf8ToBytes("ConfirmationKeys"), 64);
    const KcA = kc.subarray(0, 32);
    const KcB = kc.subarray(32);
    // Each side MACs the share it received, per RFC 9382.
    const cA = bytesToHex(hmac(sha512, KcA, hexToBytes(pB)));
    const cB = bytesToHex(hmac(sha512, KcB, hexToBytes(pA)));
    const [mine, theirs] = this.role === "A" ? [cA, cB] : [cB, cA];
    return {
      key: Uint8Array.from(Ke),
      myConfirm: mine,
      verifyPeer: (c) => {
        const a = Buffer.from(c, "hex");
        const b = Buffer.from(theirs, "hex");
        return a.length === b.length && timingSafeEqual(a, b);
      },
    };
  }
}
