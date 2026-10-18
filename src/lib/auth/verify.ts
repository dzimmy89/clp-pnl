import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { createPublicClient, http, verifyMessage, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { fetchJson } from "@/lib/http";
import { chainVerifier } from "./chains";
import type { ChainVerifyDeps } from "./chains/types";
import { buildSignInMessage, nonceBytes, normalizeAddress, NONCE_TTL_MS, type SignInFields } from "./message";

export interface SignInProof extends SignInFields {
  /** EVM: 0x hex. Solana: base58. NEAR: base64 (as NEP-413 wallets return it). Others: per plugin. */
  signature: string;
  /** NEAR: `ed25519:<base58>` key the wallet signed with. Others: per plugin. */
  publicKey?: string;
  /** Plugin chains: the envelope the wallet actually signed, when it wraps our text. */
  signedMessage?: string;
  extra?: Record<string, string>;
}

export interface VerifyOptions {
  /** Domain and origin the server is actually serving; the message must name them. */
  domain: string;
  uri: string;
  now?: number;
  /** NEAR: confirms the key is a full-access key of the account. Swappable for tests. */
  nearKeyCheck?: (accountId: string, publicKey: string) => Promise<boolean>;
  /** EVM: fallback for smart-contract wallets (EIP-1271 / 6492). Swappable for tests. */
  evmContractCheck?: (address: Hex, message: string, signature: Hex) => Promise<boolean>;
  /** Plugin chains: chain-state lookups. Swappable for tests. */
  chainDeps?: ChainVerifyDeps;
}

export class SignInError extends Error {}

/** Checks a signed sign-in message. Returns the canonical address or throws SignInError. */
export async function verifySignIn(proof: SignInProof, options: VerifyOptions): Promise<string> {
  const now = options.now ?? Date.now();
  const issued = Date.parse(proof.issuedAt);
  if (!Number.isFinite(issued)) throw new SignInError("Missing issue time");
  if (issued > now + 60_000 || now - issued > NONCE_TTL_MS) {
    throw new SignInError("Sign-in message expired. Try again.");
  }

  const message = buildSignInMessage({ ...proof, domain: options.domain, uri: options.uri });

  if (proof.chain !== "evm" && proof.chain !== "solana" && proof.chain !== "near") {
    const verifier = chainVerifier(proof.chain);
    let canonical: string;
    try {
      canonical = verifier.normalize(proof.address);
    } catch {
      throw new SignInError("Invalid address");
    }
    let ok = false;
    try {
      ok = await verifier.verify(
        {
          address: proof.address,
          message,
          signature: proof.signature,
          publicKey: proof.publicKey,
          signedMessage: proof.signedMessage,
          extra: proof.extra,
          domain: options.domain,
          nonce: proof.nonce,
        },
        options.chainDeps,
      );
    } catch {
      ok = false;
    }
    if (!ok) throw new SignInError("Signature did not match this wallet");
    return canonical;
  }

  let address: string;
  try {
    address = normalizeAddress(proof.chain, proof.address);
  } catch {
    throw new SignInError("Invalid address");
  }

  let valid = false;
  if (proof.chain === "evm") valid = await verifyEvm(address as Hex, message, proof.signature, options);
  else if (proof.chain === "solana") valid = verifySolana(address, message, proof.signature);
  else valid = await verifyNear(address, message, proof, options);

  if (!valid) throw new SignInError("Signature did not match this wallet");
  return address;
}

async function verifyEvm(address: Hex, message: string, signature: string, options: VerifyOptions) {
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  const sig = signature as Hex;
  try {
    if (await verifyMessage({ address, message, signature: sig })) return true;
  } catch {
    // Not an EOA signature; fall through to the contract-wallet check.
  }
  const contractCheck = options.evmContractCheck ?? verifyEvmContract;
  try {
    return await contractCheck(address, message, sig);
  } catch {
    return false;
  }
}

async function verifyEvmContract(address: Hex, message: string, signature: Hex) {
  const client = createPublicClient({ chain: mainnet, transport: http() });
  return client.verifyMessage({ address, message, signature });
}

export function verifySolana(address: string, message: string, signature: string): boolean {
  try {
    const publicKey = bs58.decode(address);
    const sig = bs58.decode(signature);
    if (publicKey.length !== 32 || sig.length !== 64) return false;
    return ed25519.verify(sig, new TextEncoder().encode(message), publicKey);
  } catch {
    return false;
  }
}

/** NEP-413: sha256 over borsh(tag u32, message, nonce[32], recipient, callbackUrl: None). */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  const encoder = new TextEncoder();
  const msg = encoder.encode(message);
  const rec = encoder.encode(recipient);
  const out = new Uint8Array(4 + 4 + msg.length + 32 + 4 + rec.length + 1);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint32(offset, 2 ** 31 + 413, true);
  offset += 4;
  view.setUint32(offset, msg.length, true);
  offset += 4;
  out.set(msg, offset);
  offset += msg.length;
  out.set(nonce, offset);
  offset += 32;
  view.setUint32(offset, rec.length, true);
  offset += 4;
  out.set(rec, offset);
  offset += rec.length;
  out[offset] = 0; // callbackUrl: None
  return sha256(out);
}

async function verifyNear(accountId: string, message: string, proof: SignInProof, options: VerifyOptions) {
  const publicKey = proof.publicKey ?? "";
  if (!publicKey.startsWith("ed25519:")) return false;
  let valid = false;
  try {
    const key = bs58.decode(publicKey.slice("ed25519:".length));
    const sig = Uint8Array.from(Buffer.from(proof.signature, "base64"));
    if (key.length !== 32 || sig.length !== 64) return false;
    valid = ed25519.verify(sig, nep413Hash(message, nonceBytes(proof.nonce), options.domain), key);
  } catch {
    return false;
  }
  if (!valid) return false;
  // A valid signature only proves control of the key. The key must also belong to the account.
  const keyCheck = options.nearKeyCheck ?? isFullAccessKey;
  return keyCheck(accountId, publicKey);
}

const NEAR_RPC = "https://rpc.mainnet.near.org";

async function isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
  const body = await fetchJson<{ result?: { permission?: unknown }; error?: unknown }>(NEAR_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "omnifolio",
      method: "query",
      params: {
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      },
    }),
  });
  return body.result?.permission === "FullAccess";
}
