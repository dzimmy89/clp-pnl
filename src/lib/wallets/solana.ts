"use client";

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";

type ConnectFeature = {
  "standard:connect": { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
};
type SignMessageFeature = {
  "solana:signMessage": {
    signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<{ signature: Uint8Array }[]>;
  };
};

export interface SolanaWallet {
  id: string;
  name: string;
  icon: string;
  wallet: Wallet;
}

function canSignIn(wallet: Wallet): boolean {
  return (
    wallet.chains.some((chain) => chain.startsWith("solana:")) &&
    "standard:connect" in wallet.features &&
    "solana:signMessage" in wallet.features
  );
}

/** Wallet Standard: Phantom, Solflare, Backpack and others register here. */
export function solanaWallets(): SolanaWallet[] {
  return getWallets()
    .get()
    .filter(canSignIn)
    .map((wallet) => ({ id: `solana:${wallet.name}`, name: wallet.name, icon: wallet.icon, wallet }));
}

export function watchSolanaWallets(onChange: () => void): () => void {
  const api = getWallets();
  const offRegister = api.on("register", onChange);
  const offUnregister = api.on("unregister", onChange);
  return () => {
    offRegister();
    offUnregister();
  };
}

export async function connectSolana(entry: SolanaWallet): Promise<WalletAccount> {
  const features = entry.wallet.features as unknown as ConnectFeature;
  const { accounts } = await features["standard:connect"].connect();
  const account = accounts.find((a) => a.chains.some((c) => c.startsWith("solana:"))) ?? accounts[0];
  if (!account) throw new Error("The wallet returned no account");
  return account;
}

export async function signSolana(entry: SolanaWallet, account: WalletAccount, message: string): Promise<string> {
  const features = entry.wallet.features as unknown as SignMessageFeature;
  const [result] = await features["solana:signMessage"].signMessage({
    account,
    message: new TextEncoder().encode(message),
  });
  return bs58.encode(result.signature);
}
