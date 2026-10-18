import { getAddress } from "viem";
import { createSiweMessage } from "viem/siwe";

/** Chains a wallet can sign in with. Canton has no browser wallet, so it stays paste-in. */
export const WALLET_CHAINS = ["evm", "solana", "near", "sui", "aptos", "ton", "tron", "cosmos", "starknet", "cardano", "kaspa"] as const;
export type WalletChain = (typeof WALLET_CHAINS)[number];

/** Chains whose sign-in lives in a plugin under `src/lib/auth/chains/`. */
export type PluginChain = Exclude<WalletChain, "evm" | "solana" | "near">;

export const CHAIN_LABEL: Record<WalletChain, string> = {
  evm: "EVM",
  solana: "Solana",
  near: "NEAR",
  sui: "Sui",
  aptos: "Aptos",
  ton: "TON",
  tron: "Tron",
  cosmos: "Cosmos",
  starknet: "Starknet",
  cardano: "Cardano",
  kaspa: "Kaspa",
};

export const SIGN_IN_STATEMENT =
  "Sign in to Omnifolio. This only proves you own this wallet. It is not a transaction and costs no gas.";

/** How long a nonce, and the message carrying it, stays valid. */
export const NONCE_TTL_MS = 10 * 60 * 1000;

export interface SignInFields {
  chain: WalletChain;
  address: string;
  /** Host the app is served from, e.g. `ledger.example.com` or `127.0.0.1:43127`. */
  domain: string;
  /** Origin the app is served from, e.g. `https://ledger.example.com`. */
  uri: string;
  nonce: string;
  /** ISO timestamp chosen by the client when the message was built. */
  issuedAt: string;
  /** EVM only: the chain id the wallet reported. */
  chainId?: number;
}

export function isWalletChain(value: unknown): value is WalletChain {
  return typeof value === "string" && (WALLET_CHAINS as readonly string[]).includes(value);
}

/**
 * Canonical form of an address, used both for display and as the unique key.
 * EVM is checksummed, NEAR is lowercase, Solana base58 is case-sensitive and kept as is.
 */
export function normalizeAddress(chain: WalletChain, address: string): string {
  const trimmed = address.trim();
  if (chain === "evm") return getAddress(trimmed);
  if (chain === "near") return trimmed.toLowerCase();
  // Solana is case-sensitive. Plugin chains are signed exactly as the wallet reported them;
  // the server canonicalizes them separately (see chainVerifier().normalize).
  return trimmed;
}

/**
 * The exact text a wallet signs. Client and server both build it from the same fields,
 * so the server never has to parse what the client sent: it rebuilds the message with
 * its own domain and checks the signature against that.
 */
export function buildSignInMessage(fields: SignInFields): string {
  const address = normalizeAddress(fields.chain, fields.address);
  if (fields.chain === "evm") {
    return createSiweMessage({
      address: address as `0x${string}`,
      chainId: fields.chainId ?? 1,
      domain: fields.domain,
      uri: fields.uri,
      nonce: fields.nonce,
      issuedAt: new Date(fields.issuedAt),
      statement: SIGN_IN_STATEMENT,
      version: "1",
    });
  }
  const account = CHAIN_LABEL[fields.chain];
  return [
    `${fields.domain} wants you to sign in with your ${account} account:`,
    address,
    "",
    SIGN_IN_STATEMENT,
    "",
    `URI: ${fields.uri}`,
    "Version: 1",
    `Nonce: ${fields.nonce}`,
    `Issued At: ${new Date(fields.issuedAt).toISOString()}`,
  ].join("\n");
}

/** NEP-413 wants a 32-byte nonce. Server nonces are 32 random bytes in hex. */
export function nonceBytes(nonce: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(nonce)) throw new Error("Nonce must be 32 bytes of hex");
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(nonce.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
