import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import type { ChainProof, ChainVerifier } from "./types";

/**
 * Kaspa sign-in (KasWare `signMessage`).
 *
 * Message hash (rusty-kaspa `wallet/core/src/message.rs`, `kaspa_hashes::PersonalMessageSigningHash`):
 * blake2b with a 32-byte digest, keyed with the ASCII bytes "PersonalMessageSigningHash", over the
 * utf8 message. The digest is then signed with BIP340 Schnorr over secp256k1 (x-only key). KasWare
 * calls the kaspa-wasm `signMessage`, which returns the 64-byte signature as hex.
 *
 * Addresses are `kaspa:` + a cashaddr-style base32 payload of (version byte || key) with a 40-bit
 * checksum (rusty-kaspa `crypto/addresses/src/bech32.rs`). Version 0 holds a 32-byte x-only
 * Schnorr key, version 1 a 33-byte compressed ECDSA key, version 8 a script hash (rejected).
 * The key comes from the address itself, so `publicKey` is not needed.
 *
 * Version-1 (ECDSA, e.g. Tangem) addresses: KasWare signs with its own `signMessageECDSA`, which
 * is not in upstream rusty-kaspa and whose exact digest is undocumented. We accept an ECDSA
 * signature (64-byte compact, 65-byte recoverable or DER; hex or base64) over either the same
 * personal-message hash or sha256 of it. Both commit to the exact message.
 *
 * `signature`: hex (base64 also accepted). `extra.type`: "schnorr" | "ecdsa", informational; the
 * scheme is chosen by the address version.
 */

const PREFIX = "kaspa";
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const PERSONAL_MESSAGE_KEY = new TextEncoder().encode("PersonalMessageSigningHash");

export const KASPA_VERSION = { PubKey: 0, PubKeyECDSA: 1, ScriptHash: 8 } as const;
const PAYLOAD_LENGTH: Record<number, number> = { 0: 32, 1: 33, 8: 32 };

export function kaspaPersonalMessageHash(message: string): Uint8Array {
  return blake2b(new TextEncoder().encode(message), { dkLen: 32, key: PERSONAL_MESSAGE_KEY });
}

function polymod(values: number[]): bigint {
  const generators = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= generators[i];
  }
  return c ^ 1n;
}

function checksum(prefix: string, payload5: number[]): bigint {
  const prefix5 = Array.from(prefix, (ch) => ch.charCodeAt(0) & 0x1f);
  return polymod([...prefix5, 0, ...payload5, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function convertBits(data: ArrayLike<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (let i = 0; i < data.length; i++) {
    acc = (acc << from) | data[i];
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
    acc &= (1 << bits) - 1;
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max);
  return out;
}

/** Encodes (version, payload) as a Kaspa address under `prefix` (default mainnet). */
export function encodeKaspaAddress(version: number, payload: Uint8Array, prefix = PREFIX): string {
  const data5 = convertBits([version, ...payload], 8, 5, true);
  const sum = checksum(prefix, data5);
  const sum5: number[] = [];
  for (let i = 7; i >= 0; i--) sum5.push(Number((sum >> BigInt(i * 5)) & 31n));
  return `${prefix}:${[...data5, ...sum5].map((v) => CHARSET[v]).join("")}`;
}

/** Decodes and checksums a Kaspa address. Throws on anything malformed. */
export function decodeKaspaAddress(address: string): { prefix: string; version: number; payload: Uint8Array } {
  const trimmed = address.trim();
  if (trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()) throw new Error("Mixed-case Kaspa address");
  const lower = trimmed.toLowerCase();
  const sep = lower.indexOf(":");
  if (sep <= 0) throw new Error("Kaspa address needs a prefix");
  const prefix = lower.slice(0, sep);
  const body = lower.slice(sep + 1);
  if (body.length < 9 || body.length > 200) throw new Error("Bad Kaspa address length");
  const values: number[] = [];
  for (const ch of body) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) throw new Error("Bad Kaspa address character");
    values.push(v);
  }
  const payload5 = values.slice(0, -8);
  let sum = 0n;
  for (const v of values.slice(-8)) sum = (sum << 5n) | BigInt(v);
  if (checksum(prefix, payload5) !== sum) throw new Error("Bad Kaspa address checksum");
  const bytes = convertBits(payload5, 5, 8, false);
  const [version, ...rest] = bytes;
  if (version === undefined || PAYLOAD_LENGTH[version] === undefined) throw new Error("Unknown Kaspa address version");
  if (rest.length !== PAYLOAD_LENGTH[version]) throw new Error("Bad Kaspa address payload");
  return { prefix, version, payload: Uint8Array.from(rest) };
}

function signatureBytes(signature: string): Uint8Array | null {
  const s = signature.trim().replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return Uint8Array.from(Buffer.from(s, "hex"));
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return Uint8Array.from(Buffer.from(s, "base64"));
  return null;
}

function verifyEcdsa(sig: Uint8Array, hash: Uint8Array, key: Uint8Array): boolean {
  // prehash: false checks the digest as is; prehash: true checks sha256(digest).
  const attempts: { format: "compact" | "der"; bytes: Uint8Array }[] = [];
  if (sig.length === 64) attempts.push({ format: "compact", bytes: sig });
  else if (sig.length === 65) {
    // Recoverable: Bitcoin-style header byte first, or recovery id last.
    attempts.push({ format: "compact", bytes: sig.slice(1) }, { format: "compact", bytes: sig.slice(0, 64) });
  } else if (sig[0] === 0x30) attempts.push({ format: "der", bytes: sig });
  for (const { format, bytes } of attempts) {
    for (const prehash of [false, true]) {
      try {
        if (secp256k1.verify(bytes, hash, key, { prehash, lowS: false, format })) return true;
      } catch {
        // Try the next interpretation.
      }
    }
  }
  return false;
}

export const kaspa: ChainVerifier = {
  normalize(address: string): string {
    const { prefix, version, payload } = decodeKaspaAddress(address);
    if (prefix !== PREFIX) throw new Error("Only Kaspa mainnet addresses are supported");
    if (version !== KASPA_VERSION.PubKey && version !== KASPA_VERSION.PubKeyECDSA) {
      throw new Error("Script-hash Kaspa addresses cannot sign in");
    }
    return encodeKaspaAddress(version, payload);
  },

  async verify(proof: ChainProof): Promise<boolean> {
    try {
      const { version, payload } = decodeKaspaAddress(kaspa.normalize(proof.address));
      const sig = signatureBytes(proof.signature);
      if (!sig) return false;
      const hash = kaspaPersonalMessageHash(proof.message);
      if (version === KASPA_VERSION.PubKey) {
        return sig.length === 64 && schnorr.verify(sig, hash, payload);
      }
      return verifyEcdsa(sig, hash, payload);
    } catch {
      return false;
    }
  },
};
