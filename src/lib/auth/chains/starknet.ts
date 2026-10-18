import { hash, typedData, validateAndParseAddress, type TypedData } from "starknet";
import type { ChainProof, ChainVerifier, ChainVerifyDeps } from "./types";

/**
 * Starknet sign-in with SNIP-12 (revision 1) typed data.
 *
 * Starknet accounts are contracts, so there is no address-derived key to check. The wallet signs
 * the typed-data hash and the account contract itself decides whether the signature is valid
 * (`is_valid_signature`, SNIP-6). That needs a deployed account.
 *
 * Wire format (what the browser signer sends):
 * - `address`: the account address (any hex form; normalized to 0x + 64 hex)
 * - `signature`: JSON array of felts (hex or decimal strings), exactly as the wallet returned them
 *
 * This module is pure apart from `verify`, so the client imports `starknetSignInTypedData` from here.
 */

export const STARKNET_DOMAIN = { name: "Omnifolio", version: "1", chainId: "SN_MAIN", revision: "1" } as const;

/** First 62 hex chars of the 64-hex nonce: 248 bits, always below the field prime. */
export function nonceFelt(nonce: string): string {
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error("Nonce must be 32 bytes of hex");
  return `0x${nonce.slice(0, 62)}`;
}

/**
 * The sign-in text as one line. starknet.js (and the wallets built on it) encode `string` values
 * with a regex that skips newlines and mis-encodes other control characters, so multi-line text
 * can't be hashed the same way on both sides. Lines are joined with " | " (blank lines dropped),
 * and anything outside printable ASCII is rejected.
 */
export function starknetSignInText(message: string): string {
  const text = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(" | ");
  if (!/^[\x20-\x7e]*$/.test(text)) throw new Error("Sign-in text must be printable ASCII for Starknet");
  return text;
}

/**
 * The typed data the wallet signs. `message` is the canonical sign-in text flattened by
 * `starknetSignInText` (a revision-1 `string`, i.e. a ByteArray, so it can be longer than
 * 31 chars); `nonce` repeats the nonce as a felt.
 */
export function starknetSignInTypedData(message: string, nonce: string): TypedData {
  return {
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      SignIn: [
        { name: "message", type: "string" },
        { name: "nonce", type: "felt" },
      ],
    },
    primaryType: "SignIn",
    domain: { ...STARKNET_DOMAIN },
    message: { message: starknetSignInText(message), nonce: nonceFelt(nonce) },
  };
}

const DEFAULT_RPC_URL = "https://api.zan.top/public/starknet-mainnet/rpc/v0_10";
const RPC_TIMEOUT_MS = 15_000;
const MAX_SIGNATURE_FELTS = 64;
const FELT_LIMIT = BigInt("0x800000000000011000000000000000000000000000000000000000000000001");

/** 'VALID' as a short string; Cairo 0 accounts return 1 instead. */
const VALID_RESULTS = new Set([BigInt("0x56414c4944"), BigInt(1)]);

function toFelt(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  try {
    const n = BigInt(value);
    if (n < BigInt(0) || n >= FELT_LIMIT) return null;
    return `0x${n.toString(16)}`;
  } catch {
    return null;
  }
}

/** Parses the JSON felt array the client sent. Null on anything malformed. */
export function parseStarknetSignature(signature: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(signature);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SIGNATURE_FELTS) return null;
  const felts = raw.map(toFelt);
  return felts.every((f): f is string => f !== null) ? felts : null;
}

interface RpcResponse {
  result?: unknown;
  error?: unknown;
}

async function callIsValidSignature(
  doFetch: typeof fetch,
  rpcUrl: string,
  address: string,
  entrypoint: string,
  messageHash: string,
  signature: string[],
): Promise<RpcResponse> {
  const response = await doFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "starknet_call",
      params: {
        request: {
          contract_address: address,
          entry_point_selector: hash.getSelectorFromName(entrypoint),
          // (hash: felt252, signature: Array<felt252>) => hash, len, ...items
          calldata: [messageHash, `0x${signature.length.toString(16)}`, ...signature],
        },
        block_id: "latest",
      },
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) return { error: `${response.status}` };
  return (await response.json()) as RpcResponse;
}

function isValidResult(result: unknown): boolean {
  if (!Array.isArray(result) || result.length === 0) return false;
  try {
    return VALID_RESULTS.has(BigInt(result[0] as string));
  } catch {
    return false;
  }
}

async function verifyStarknet(proof: ChainProof, deps: ChainVerifyDeps = {}): Promise<boolean> {
  let address: string;
  let messageHash: string;
  try {
    address = validateAndParseAddress(proof.address.trim());
    messageHash = typedData.getMessageHash(starknetSignInTypedData(proof.message, proof.nonce), address);
  } catch {
    return false;
  }
  const signature = parseStarknetSignature(proof.signature);
  if (!signature) return false;

  const doFetch = deps.fetch ?? fetch;
  const rpcUrl = process.env.STARKNET_RPC_URL || DEFAULT_RPC_URL;
  // Cairo 1 accounts (SNIP-6) expose snake_case; older Cairo 0 accounts use camelCase.
  for (const entrypoint of ["is_valid_signature", "isValidSignature"]) {
    let body: RpcResponse;
    try {
      body = await callIsValidSignature(doFetch, rpcUrl, address, entrypoint, messageHash, signature);
    } catch {
      return false;
    }
    if (body.error === undefined) return isValidResult(body.result);
    // An error usually means the entrypoint is missing or the account rejected the signature
    // (Argent asserts). Try the other name, then give up.
  }
  return false;
}

export const starknet: ChainVerifier = {
  normalize(address: string): string {
    return validateAndParseAddress(address.trim()).toLowerCase();
  },
  verify: verifyStarknet,
};
