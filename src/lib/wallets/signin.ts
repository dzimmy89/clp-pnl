"use client";

import { buildSignInMessage, type PluginChain, type SignInFields, type WalletChain } from "@/lib/auth/message";
import type { ClientWallet } from "@/lib/auth/chains/types";
import type { AccountView } from "@/lib/account";
import { connectEvm, signEvm, type EvmWallet } from "./evm";
import { signInNear } from "./near";
import { PLUGIN_WALLETS } from "./plugins";
import { connectSolana, signSolana, type SolanaWallet } from "./solana";

export type WalletChoice =
  | { chain: "evm"; wallet: EvmWallet }
  | { chain: "solana"; wallet: SolanaWallet }
  | { chain: "near" }
  | { chain: PluginChain; wallet: ClientWallet };

export type SignInIntent = "signin" | "link";

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data;
}

/**
 * Connect, sign one message, and hand the proof to the server. Nothing is sent on-chain.
 * `signin` finds or creates the account for this wallet; `link` adds it to the current account.
 */
export async function signInWithWallet(choice: WalletChoice, intent: SignInIntent): Promise<AccountView> {
  const { nonce } = await postJson<{ nonce: string }>("/api/auth/nonce");
  const base = {
    domain: window.location.host,
    uri: window.location.origin,
    nonce,
    issuedAt: new Date().toISOString(),
  };

  let proof: SignInFields & { signature: string; publicKey?: string; signedMessage?: string; extra?: Record<string, string> };
  if (choice.chain === "evm") {
    const { address, chainId } = await connectEvm(choice.wallet);
    const fields: SignInFields = { ...base, chain: "evm", address, chainId };
    proof = { ...fields, signature: await signEvm(choice.wallet, address, buildSignInMessage(fields)) };
  } else if (choice.chain === "solana") {
    const account = await connectSolana(choice.wallet);
    const fields: SignInFields = { ...base, chain: "solana", address: account.address };
    proof = { ...fields, signature: await signSolana(choice.wallet, account, buildSignInMessage(fields)) };
  } else if (choice.chain !== "near") {
    const chain = choice.chain;
    const signed = await PLUGIN_WALLETS[chain].signIn(
      choice.wallet,
      (address) => buildSignInMessage({ ...base, chain, address }),
      { nonce, domain: base.domain },
    );
    proof = { ...base, chain, ...signed };
  } else {
    const signed = await signInNear(nonce, base.domain, (accountId) =>
      buildSignInMessage({ ...base, chain: "near", address: accountId }),
    );
    proof = { ...base, chain: "near", address: signed.accountId, signature: signed.signature, publicKey: signed.publicKey };
  }

  const { account } = await postJson<{ account: AccountView }>("/api/auth/verify", { ...proof, intent });
  return account;
}

export async function signOut(): Promise<void> {
  await postJson("/api/auth/logout");
}

export function walletErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = (error as { code?: number })?.code;
  if (code === 4001 || /reject|denied|cancel/i.test(message)) return "You cancelled the request in your wallet.";
  return message || "Something went wrong with the wallet.";
}

export type { WalletChain };
