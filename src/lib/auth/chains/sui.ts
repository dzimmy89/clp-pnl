import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import type { ChainProof, ChainVerifier } from "./types";

/**
 * Sui sign-in.
 *
 * Wallets sign with `sui:signPersonalMessage` and return the serialized signature as base64:
 * `flag || signature || publicKey`. The signed bytes are the UTF-8 of our sign-in text.
 * `proof.signature` is that base64 string; `proof.publicKey` / `signedMessage` are unused.
 */

const FLAG_ED25519 = 0x00;
const FLAG_SECP256K1 = 0x01;
const FLAG_SECP256R1 = 0x02;

const SCHEMES: Record<number, { publicKeyLength: number }> = {
  [FLAG_ED25519]: { publicKeyLength: 32 },
  [FLAG_SECP256K1]: { publicKeyLength: 33 },
  [FLAG_SECP256R1]: { publicKeyLength: 33 },
};

/** IntentScope::PersonalMessage (3), IntentVersion::V0 (0), AppId::Sui (0). */
const PERSONAL_MESSAGE_INTENT = [3, 0, 0];

function uleb128(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return out;
}

/** blake2b-256(intent || bcs(vector<u8> message)): what a Sui key actually signs. */
export function suiPersonalMessageDigest(message: Uint8Array): Uint8Array {
  const length = uleb128(message.length);
  const data = new Uint8Array(PERSONAL_MESSAGE_INTENT.length + length.length + message.length);
  data.set(PERSONAL_MESSAGE_INTENT, 0);
  data.set(length, PERSONAL_MESSAGE_INTENT.length);
  data.set(message, PERSONAL_MESSAGE_INTENT.length + length.length);
  return blake2b(data, { dkLen: 32 });
}

/** 0x + hex(blake2b-256(flag || publicKey)). */
export function suiAddressFromPublicKey(flag: number, publicKey: Uint8Array): string {
  const data = new Uint8Array(1 + publicKey.length);
  data[0] = flag;
  data.set(publicKey, 1);
  return `0x${bytesToHex(blake2b(data, { dkLen: 32 }))}`;
}

function normalize(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new Error("Invalid Sui address");
  return `0x${hex.padStart(64, "0")}`;
}

function verifyScheme(flag: number, signature: Uint8Array, digest: Uint8Array, publicKey: Uint8Array): boolean {
  // Ed25519 signs the 32-byte digest directly. The ECDSA schemes sign sha256(digest), which is
  // noble's default `prehash: true` behaviour, and Sui only accepts low-S signatures.
  if (flag === FLAG_ED25519) return ed25519.verify(signature, digest, publicKey);
  if (flag === FLAG_SECP256K1) return secp256k1.verify(signature, digest, publicKey);
  if (flag === FLAG_SECP256R1) return p256.verify(signature, digest, publicKey);
  return false;
}

async function verify(proof: ChainProof): Promise<boolean> {
  try {
    const address = normalize(proof.address);
    const serialized = base64.decode(proof.signature.trim());
    const flag = serialized[0];
    // Multisig (0x03), zkLogin (0x05), passkey (0x06) and anything else are not supported.
    const scheme = SCHEMES[flag];
    if (!scheme) return false;
    if (serialized.length !== 1 + 64 + scheme.publicKeyLength) return false;
    const signature = serialized.slice(1, 65);
    const publicKey = serialized.slice(65);
    if (suiAddressFromPublicKey(flag, publicKey) !== address) return false;
    const digest = suiPersonalMessageDigest(new TextEncoder().encode(proof.message));
    return verifyScheme(flag, signature, digest, publicKey);
  } catch {
    return false;
  }
}

export const sui: ChainVerifier = { normalize, verify };
