import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Address, beginCell, Cell, loadStateInit, storeStateInit, type StateInit } from "@ton/core";
import type { ChainProof, ChainVerifier, ChainVerifyDeps } from "./types";

/**
 * TON sign-in through TON Connect `ton_proof`.
 *
 * TON wallets can't sign arbitrary text. They sign a fixed envelope that binds the wallet
 * address, the app domain, a timestamp and a payload we choose (the server nonce):
 * https://github.com/ton-blockchain/ton-connect/blob/main/spec/requests_responses.md#address-proof-signature-ton_proof
 *
 * Wire format (what the browser signer sends):
 * - `address`: raw `<workchain>:<hex>` (user-friendly forms are accepted too)
 * - `signature`: base64 ed25519 signature from `proof.signature`
 * - `signedMessage`: JSON `{ timestamp, domain: { lengthBytes, value }, payload }`
 * - `extra.stateInit`: base64 BoC of the wallet's StateInit (`account.walletStateInit`)
 * - `publicKey`: hex key the wallet advertised. Untrusted; only used as a hint, never to verify.
 */

/** How far the proof timestamp may be from now, either way. */
export const TON_PROOF_TTL_MS = 15 * 60 * 1000;

const TONCENTER_URL = "https://toncenter.com/api/v2/runGetMethod";

/**
 * Code hashes (hex) of standard wallet contracts, mapped to how many data bits precede the
 * public key. Computed from the code cells shipped in @ton/ton 16.3.0.
 */
const WALLET_KEY_OFFSET: Record<string, number> = {
  // v1r1, v1r2, v1r3, v2r1, v2r2: seqno u32, pubkey
  a0cfc2c48aee16a271f2cfc0b7382d81756cecb1017d077faaab3bb602f6868c: 32,
  d4902fcc9fad74698fa8e353220a68da0dcf72e32bcb2eb9ee04217c17d3062c: 32,
  "587cc789eff1c84f46ec3797e45fc809a14ff5ae24f1e0c7a6a99cc9dc9061ff": 32,
  "5c9a5e68c108e18721a07c42f9956bfb39ad77ec6d624b60c576ec88eee65329": 32,
  fe9530d3243853083ef2ef0b4c2908c0abf6fa1c31ea243aacaa5bf8c7d753f1: 32,
  // v3r1, v3r2, v4r2: seqno u32, subwallet u32, pubkey
  b61041a58a7980b946e8fb9e198e3c904d24799ffa36574ea4251c41a566f581: 64,
  "84dafa449f98a6987789ba232358072bc0f76dc4524002a5d0918b9a75d2d599": 64,
  feb5ff6820e2ff0d9483e7e0d62c817d846789fb4ae580c878866d959dabd5c0: 64,
  // v5 beta: seqno 33 bits, wallet id 80 bits, pubkey
  f3d7ca53493deedac28b381986a849403cbac3d2c584779af081065af0ac4b93: 113,
  // v5r1 (W5): is_signature_allowed 1 bit, seqno u32, wallet_id u32, pubkey
  "20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f": 65,
};

export interface TonProofEnvelope {
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  payload: string;
}

/** Parses `signedMessage`; returns null on anything malformed. */
export function parseTonProofEnvelope(json: string | undefined): TonProofEnvelope | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<TonProofEnvelope>;
    const { timestamp, domain, payload } = raw;
    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0) return null;
    if (!domain || typeof domain.value !== "string" || typeof domain.lengthBytes !== "number") return null;
    if (typeof payload !== "string") return null;
    return { timestamp, domain: { lengthBytes: domain.lengthBytes, value: domain.value }, payload };
  } catch {
    return null;
  }
}

/**
 * The 32 bytes the wallet signs with ed25519:
 * sha256(0xffff ++ "ton-connect" ++ sha256("ton-proof-item-v2/" ++ wc u32 BE ++ hash ++
 * domain_len u32 LE ++ domain ++ timestamp u64 LE ++ payload)).
 */
export function tonProofHash(address: Address, envelope: TonProofEnvelope): Uint8Array {
  const encoder = new TextEncoder();
  const prefix = encoder.encode("ton-proof-item-v2/");
  const domain = encoder.encode(envelope.domain.value);
  const payload = encoder.encode(envelope.payload);
  const message = new Uint8Array(prefix.length + 4 + 32 + 4 + domain.length + 8 + payload.length);
  const view = new DataView(message.buffer);
  let offset = 0;
  message.set(prefix, offset);
  offset += prefix.length;
  view.setInt32(offset, address.workChain, false);
  offset += 4;
  message.set(address.hash, offset);
  offset += 32;
  view.setUint32(offset, domain.length, true);
  offset += 4;
  message.set(domain, offset);
  offset += domain.length;
  view.setBigUint64(offset, BigInt(envelope.timestamp), true);
  offset += 8;
  message.set(payload, offset);

  const head = new Uint8Array([0xff, 0xff, ...encoder.encode("ton-connect")]);
  const full = new Uint8Array(head.length + 32);
  full.set(head, 0);
  full.set(sha256(message), head.length);
  return sha256(full);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Public key from a standard wallet StateInit, or null for code we don't recognize. */
export function publicKeyFromStateInit(init: StateInit): Uint8Array | null {
  if (!init.code || !init.data) return null;
  const offset = WALLET_KEY_OFFSET[toHex(init.code.hash())];
  if (offset === undefined) return null;
  try {
    const slice = init.data.beginParse();
    slice.skip(offset);
    return new Uint8Array(slice.loadBuffer(32));
  } catch {
    return null;
  }
}

interface RunGetMethodResponse {
  ok?: boolean;
  result?: { exit_code?: number; stack?: unknown[] };
}

const TONCENTER_TIMEOUT_MS = 15_000;

/** Calls `get_public_key` on the deployed wallet. Null when it isn't deployed or has no such getter. */
export async function fetchTonPublicKey(address: Address, deps: ChainVerifyDeps = {}): Promise<Uint8Array | null> {
  const doFetch = deps.fetch ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const apiKey = process.env.TONCENTER_API_KEY;
  if (apiKey) headers["x-api-key"] = apiKey;
  const response = await doFetch(process.env.TONCENTER_API_URL ?? TONCENTER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ address: address.toRawString(), method: "get_public_key", stack: [] }),
    signal: AbortSignal.timeout(TONCENTER_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as RunGetMethodResponse;
  if (!body.ok || !body.result || body.result.exit_code !== 0) return null;
  const top = body.result.stack?.[0];
  if (!Array.isArray(top) || top[0] !== "num" || typeof top[1] !== "string") return null;
  let value: bigint;
  try {
    value = BigInt(top[1]);
  } catch {
    return null;
  }
  if (value < BigInt(0) || value >= BigInt(2) ** BigInt(256)) return null;
  return new Uint8Array(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export interface TonVerifyDeps extends ChainVerifyDeps {
  /** Milliseconds since epoch; tests pin it. */
  now?: number;
}

async function verifyTon(proof: ChainProof, deps: TonVerifyDeps = {}): Promise<boolean> {
  let address: Address;
  try {
    address = Address.parse(proof.address.trim());
  } catch {
    return false;
  }

  const envelope = parseTonProofEnvelope(proof.signedMessage);
  if (!envelope) return false;
  if (envelope.payload !== proof.nonce) return false;
  if (envelope.domain.value !== proof.domain) return false;
  if (envelope.domain.lengthBytes !== new TextEncoder().encode(envelope.domain.value).length) return false;
  const now = deps.now ?? Date.now();
  if (Math.abs(now - envelope.timestamp * 1000) > TON_PROOF_TTL_MS) return false;

  let signature: Uint8Array;
  try {
    signature = new Uint8Array(Buffer.from(proof.signature, "base64"));
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  const hash = tonProofHash(address, envelope);

  // The key must come from the chain or from a StateInit that provably belongs to the address,
  // never from what the client claims.
  let publicKey: Uint8Array | null = null;
  const stateInitB64 = proof.extra?.stateInit;
  if (stateInitB64) {
    let init: StateInit;
    try {
      init = loadStateInit(Cell.fromBase64(stateInitB64).beginParse());
    } catch {
      return false;
    }
    const initHash = beginCell().store(storeStateInit(init)).endCell().hash();
    if (!sameBytes(new Uint8Array(initHash), new Uint8Array(address.hash))) return false;
    publicKey = publicKeyFromStateInit(init);
  }
  if (!publicKey) {
    try {
      publicKey = await fetchTonPublicKey(address, deps);
    } catch {
      return false;
    }
  }
  if (!publicKey || publicKey.length !== 32) return false;

  try {
    return ed25519.verify(signature, hash, publicKey);
  } catch {
    return false;
  }
}

export const ton: ChainVerifier & { verify(proof: ChainProof, deps?: TonVerifyDeps): Promise<boolean> } = {
  normalize(address: string): string {
    return Address.parse(address.trim()).toRawString();
  },
  verify: verifyTon,
};
