import { ed25519 } from "@noble/curves/ed25519.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { ChainProof, ChainVerifier, ChainVerifyDeps } from "./types";

/**
 * Aptos sign-in (AIP-62 `aptos:signMessage`).
 *
 * The wallet wraps our text in an envelope and signs the UTF-8 of that `fullMessage`:
 *   APTOS
 *   address: 0x...          (optional)
 *   application: https://.. (optional)
 *   chainId: 1              (optional)
 *   message: <our text>
 *   nonce: <server nonce>
 * Wallets differ on whether `nonce:` or `message:` comes last, so both orders are accepted.
 *
 * Proof fields: `signedMessage` = fullMessage, `signature` = 0x hex (64 bytes),
 * `publicKey` = 0x hex Ed25519 key (32 bytes). Only legacy Ed25519 accounts are supported.
 */

export const APTOS_ACCOUNT_API = "https://api.mainnet.aptoslabs.com/v1/accounts";

const ED25519_SCHEME = 0x00;
const HEADER_FIELDS = new Set(["address", "application", "chainId"]);

function normalize(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new Error("Invalid Aptos address");
  return `0x${hex.padStart(64, "0")}`;
}

function decodeHex(value: string | undefined, length: number): Uint8Array | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (hex.length !== length * 2 || !/^[0-9a-f]+$/.test(hex)) return null;
  return hexToBytes(hex);
}

/** Legacy single-key Ed25519 authentication key: sha3-256(publicKey || 0x00). */
export function aptosAuthKey(publicKey: Uint8Array): string {
  const data = new Uint8Array(publicKey.length + 1);
  data.set(publicKey, 0);
  data[publicKey.length] = ED25519_SCHEME;
  return `0x${bytesToHex(sha3_256(data))}`;
}

function sameApplication(application: string, domain: string): boolean {
  if (application === domain) return true;
  try {
    return new URL(application).host === domain;
  } catch {
    return false;
  }
}

/** True when `fullMessage` is an AIP-62 envelope around exactly our text, nonce and domain. */
export function checkAptosEnvelope(fullMessage: string, proof: ChainProof, address: string): boolean {
  const prefix = "APTOS\n";
  if (!fullMessage.startsWith(prefix)) return false;
  const body = fullMessage.slice(prefix.length);
  const tails = [
    `message: ${proof.message}\nnonce: ${proof.nonce}`,
    `nonce: ${proof.nonce}\nmessage: ${proof.message}`,
  ];
  const tail = tails.find((t) => body === t || body.endsWith(`\n${t}`));
  if (!tail) return false;
  const header = body.slice(0, body.length - tail.length);
  if (header === "") return true;

  const seen = new Set<string>();
  for (const line of header.slice(0, -1).split("\n")) {
    const match = /^([A-Za-z]+): (.*)$/.exec(line);
    if (!match || !HEADER_FIELDS.has(match[1]) || seen.has(match[1])) return false;
    seen.add(match[1]);
    const [, key, value] = match;
    if (key === "address") {
      try {
        if (normalize(value) !== address) return false;
      } catch {
        return false;
      }
    } else if (key === "application") {
      if (!sameApplication(value, proof.domain)) return false;
    } else if (!/^\d+$/.test(value)) {
      return false;
    }
  }
  return true;
}

/** For accounts whose key was rotated, the on-chain authentication key is the source of truth. */
async function onChainAuthKey(address: string, deps?: ChainVerifyDeps): Promise<string | null> {
  const doFetch = deps?.fetch ?? fetch;
  const response = await doFetch(`${APTOS_ACCOUNT_API}/${address}`, { headers: { accept: "application/json" } });
  if (!response.ok) return null;
  const body = (await response.json()) as { authentication_key?: unknown };
  if (typeof body.authentication_key !== "string") return null;
  return normalize(body.authentication_key);
}

async function verify(proof: ChainProof, deps?: ChainVerifyDeps): Promise<boolean> {
  try {
    const address = normalize(proof.address);
    const fullMessage = proof.signedMessage ?? "";
    const publicKey = decodeHex(proof.publicKey, 32);
    const signature = decodeHex(proof.signature, 64);
    if (!publicKey || !signature) return false;
    if (!checkAptosEnvelope(fullMessage, proof, address)) return false;
    if (!ed25519.verify(signature, new TextEncoder().encode(fullMessage), publicKey)) return false;

    // A valid signature only proves control of the key; the key must also own the account.
    const authKey = aptosAuthKey(publicKey);
    if (authKey === address) return true;
    return (await onChainAuthKey(address, deps)) === authKey;
  } catch {
    return false;
  }
}

export const aptos: ChainVerifier = { normalize, verify };
