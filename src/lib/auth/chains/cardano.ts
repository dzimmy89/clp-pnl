import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bech32 } from "@scure/base";
import { Decoder, Tag } from "cbor-x";
import type { ChainProof, ChainVerifier } from "./types";

/**
 * Cardano sign-in (CIP-30 `signData`, CIP-8 message signing).
 *
 * The wallet returns `{ signature, key }`: `signature` is a hex COSE_Sign1
 * `[protected: bstr, unprotected: map, payload: bstr | null, signature: bstr]` (optionally tag 18),
 * `key` is a hex COSE_Key map with the Ed25519 public key under label -2.
 *
 * Checks:
 * - protected header has alg (1) = -8 (EdDSA) and "address" = the raw bytes of the sign-in address;
 * - payload is utf8(message), or blake2b-224(utf8(message)) when unprotected "hashed" is true
 *   (a detached null payload is treated as utf8(message));
 * - Ed25519 over Sig_structure = ["Signature1", protected (bytes as received), h'', payload];
 * - blake2b-224(public key) equals the address's key credential: the payment credential of a
 *   base (header type 0, 2) or enterprise (type 6) address, or the stake credential of a reward
 *   address (type 14, 0xe1). Script credentials are rejected.
 *
 * Proof fields: `address` bech32 (`addr1…` / `stake1…`, mainnet only), `signature` COSE_Sign1 hex,
 * `publicKey` COSE_Key hex (a bare 32-byte key in hex is also accepted).
 */

const BECH32_LIMIT = 1023;
const KEY_HASH_TYPES = new Set([0, 2, 6, 14]);
const decoder = new Decoder({ mapsAsObjects: false, useRecords: false });

function decodeAddress(address: string): { hrp: string; bytes: Uint8Array } {
  const lower = address.trim().toLowerCase();
  const { prefix, words } = bech32.decode(lower as `${string}1${string}`, BECH32_LIMIT);
  return { hrp: prefix, bytes: bech32.fromWords(words) };
}

/** The 28-byte key hash the address commits to, or null when it is a script or unsupported type. */
export function cardanoKeyCredential(address: Uint8Array): Uint8Array | null {
  if (address.length < 29) return null;
  const type = address[0] >> 4;
  if (!KEY_HASH_TYPES.has(type)) return null;
  const expected = type === 0 || type === 2 ? 57 : 29;
  if (address.length !== expected) return null;
  return address.slice(1, 29);
}

/** bech32 for raw Cardano address bytes (`addr`/`stake`, `_test` on testnets). */
export function cardanoAddressToBech32(bytes: Uint8Array): string {
  const type = bytes[0] >> 4;
  const network = bytes[0] & 0x0f;
  const hrp = (type === 14 || type === 15 ? "stake" : "addr") + (network === 1 ? "" : "_test");
  return bech32.encode(hrp, bech32.toWords(bytes), BECH32_LIMIT);
}

function bytesFromHex(value: string): Uint8Array {
  const s = value.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new Error("Expected hex");
  return Uint8Array.from(Buffer.from(s, "hex"));
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function untag(value: unknown): unknown {
  return value instanceof Tag ? value.value : value;
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/** CBOR head for major type `major` and length/value `n` (definite length). */
function cborHead(major: number, n: number): Uint8Array {
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** RFC 9052 Sig_structure for COSE_Sign1 with empty external_aad, encoded as canonical CBOR. */
export function coseSign1SigStructure(protectedBytes: Uint8Array, payload: Uint8Array): Uint8Array {
  const context = new TextEncoder().encode("Signature1");
  return concat([
    cborHead(4, 4),
    cborHead(3, context.length),
    context,
    cborHead(2, protectedBytes.length),
    protectedBytes,
    cborHead(2, 0),
    cborHead(2, payload.length),
    payload,
  ]);
}

function publicKeyFrom(hex: string): Uint8Array | null {
  const raw = bytesFromHex(hex);
  if (raw.length === 32) return raw;
  const key = untag(decoder.decode(raw));
  if (!(key instanceof Map)) return null;
  const kty = key.get(1);
  const alg = key.get(3);
  const crv = key.get(-1);
  if (kty !== undefined && kty !== 1) return null; // OKP
  if (alg !== undefined && alg !== -8) return null; // EdDSA
  if (crv !== undefined && crv !== 6) return null; // Ed25519
  const x = key.get(-2);
  return isBytes(x) && x.length === 32 ? Uint8Array.from(x) : null;
}

export const cardano: ChainVerifier = {
  normalize(address: string): string {
    const { hrp, bytes } = decodeAddress(address);
    if (hrp !== "addr" && hrp !== "stake") throw new Error("Only Cardano mainnet addresses are supported");
    if (bytes.length === 0 || (bytes[0] & 0x0f) !== 1) throw new Error("Only Cardano mainnet addresses are supported");
    const type = bytes[0] >> 4;
    if ((hrp === "stake") !== (type === 14 || type === 15)) throw new Error("Address prefix does not match its type");
    return cardanoAddressToBech32(bytes);
  },

  async verify(proof: ChainProof): Promise<boolean> {
    try {
      const addressBytes = decodeAddress(cardano.normalize(proof.address)).bytes;
      const credential = cardanoKeyCredential(addressBytes);
      if (!credential) return false;

      const publicKey = publicKeyFrom(proof.publicKey ?? "");
      if (!publicKey || !equal(blake2b(publicKey, { dkLen: 28 }), credential)) return false;

      const sign1 = untag(decoder.decode(bytesFromHex(proof.signature)));
      if (!Array.isArray(sign1) || sign1.length !== 4) return false;
      const [protectedBytes, unprotected, payload, signature] = sign1 as unknown[];
      if (!isBytes(protectedBytes) || !isBytes(signature) || signature.length !== 64) return false;

      const headers = protectedBytes.length ? decoder.decode(protectedBytes) : new Map();
      if (!(headers instanceof Map) || headers.get(1) !== -8) return false;
      const headerAddress = headers.get("address");
      if (!isBytes(headerAddress) || !equal(headerAddress, addressBytes)) return false;

      const hashed = unprotected instanceof Map && unprotected.get("hashed") === true;
      const text = new TextEncoder().encode(proof.message);
      const expected = hashed ? blake2b(text, { dkLen: 28 }) : text;
      let signedPayload: Uint8Array;
      if (payload === null || payload === undefined) signedPayload = expected;
      else if (isBytes(payload) && equal(payload, expected)) signedPayload = payload;
      else return false;

      return ed25519.verify(signature, coseSign1SigStructure(protectedBytes, signedPayload), publicKey);
    } catch {
      return false;
    }
  },
};
