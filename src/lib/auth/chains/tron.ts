import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createBase58check } from "@scure/base";
import type { ChainProof, ChainVerifier } from "./types";

/**
 * Tron sign-in.
 *
 * Wallets (TronLink, OKX, TokenPocket…) sign with `tronWeb.trx.signMessageV2(text)`, which is
 * TronWeb's `utils.message.signMessage`: keccak256("\x19TRON Signed Message:\n" + byteLength +
 * bytes), signed with secp256k1 and serialized as 0x + r(32) + s(32) + v(1), v = 27/28.
 *
 * The address is base58check(0x41 || last 20 bytes of keccak256(uncompressed pubkey without 0x04)),
 * i.e. the EVM address of the same key with a 0x41 prefix.
 */

const TRON_MESSAGE_PREFIX = "\x19TRON Signed Message:\n";
const ADDRESS_VERSION = 0x41;

const b58c = createBase58check(sha256);
const encoder = new TextEncoder();

/** The digest `signMessageV2` signs (TronWeb `utils.message.hashMessage`). */
export function tronMessageHash(message: string): Uint8Array {
  const body = encoder.encode(message);
  const head = encoder.encode(`${TRON_MESSAGE_PREFIX}${body.length}`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  return keccak_256(all);
}

/** Base58check Tron address for an uncompressed (65-byte) or compressed (33-byte) secp256k1 key. */
export function tronAddressFromPublicKey(publicKey: Uint8Array): string {
  const uncompressed =
    publicKey.length === 65 ? publicKey : secp256k1.Point.fromBytes(publicKey).toBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  const payload = new Uint8Array(21);
  payload[0] = ADDRESS_VERSION;
  payload.set(hash.subarray(12), 1);
  return b58c.encode(payload);
}

function normalize(address: string): string {
  const trimmed = address.trim();
  if (!trimmed.startsWith("T")) throw new Error("Tron addresses start with T");
  const payload = b58c.decode(trimmed); // throws on a bad checksum or alphabet
  if (payload.length !== 21 || payload[0] !== ADDRESS_VERSION) throw new Error("Not a Tron address");
  return b58c.encode(payload);
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Recovers the Tron address that produced a signMessageV2 signature, or null. */
export function recoverTronAddress(message: string, signature: string): string | null {
  const sig = hexToBytes(signature);
  if (!sig || sig.length !== 65) return null;
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const parsed = secp256k1.Signature.fromBytes(sig.subarray(0, 64), "compact").addRecoveryBit(v);
    const point = parsed.recoverPublicKey(tronMessageHash(message));
    return tronAddressFromPublicKey(point.toBytes(false));
  } catch {
    return null;
  }
}

export const tron: ChainVerifier = {
  normalize,
  async verify(proof: ChainProof): Promise<boolean> {
    let address: string;
    try {
      address = normalize(proof.address);
    } catch {
      return false;
    }
    return recoverTronAddress(proof.message, proof.signature) === address;
  },
};
