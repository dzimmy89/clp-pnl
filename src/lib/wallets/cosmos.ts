"use client";

import type { ClientChainModule, ClientSigned, ClientWallet } from "@/lib/auth/chains/types";

/** Cosmos Hub. The signature is chain-agnostic (ADR-036 uses an empty chain_id). */
const CHAIN_ID = "cosmoshub-4";

/** The part of the Keplr API that Keplr and Leap both inject. */
interface InjectedCosmosWallet {
  enable(chainId: string | string[]): Promise<void>;
  getKey(chainId: string): Promise<{ bech32Address: string; pubKey: Uint8Array; name?: string }>;
  signArbitrary(
    chainId: string,
    signer: string,
    data: string | Uint8Array,
  ): Promise<{ pub_key: { type: string; value: string }; signature: string }>;
}

interface CosmosWindow {
  keplr?: InjectedCosmosWallet;
  leap?: InjectedCosmosWallet;
}

const WALLETS = [
  { key: "keplr", id: "cosmos:keplr", name: "Keplr", event: "keplr_keystorechange" },
  { key: "leap", id: "cosmos:leap", name: "Leap", event: "leap_keystorechange" },
] as const;

function provider(key: (typeof WALLETS)[number]["key"]): InjectedCosmosWallet | undefined {
  if (typeof window === "undefined") return undefined;
  const injected = (window as unknown as CosmosWindow)[key];
  return injected && typeof injected.signArbitrary === "function" ? injected : undefined;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const cosmosWallets: ClientChainModule = {
  installHint: "No Cosmos wallet found in this browser. Install Keplr or Leap.",

  list(): ClientWallet[] {
    return WALLETS.filter((w) => provider(w.key)).map(({ id, name }) => ({ id, name }));
  },

  watch(onChange) {
    if (typeof window === "undefined") return () => {};
    const handler = () => onChange();
    for (const w of WALLETS) window.addEventListener(w.event, handler);
    window.addEventListener("load", handler);
    // Keplr and Leap inject after the page script runs; look again shortly after.
    const timer = window.setTimeout(handler, 600);
    return () => {
      for (const w of WALLETS) window.removeEventListener(w.event, handler);
      window.removeEventListener("load", handler);
      window.clearTimeout(timer);
    };
  },

  async signIn(wallet, build): Promise<ClientSigned> {
    const entry = WALLETS.find((w) => w.id === wallet.id);
    const injected = entry && provider(entry.key);
    if (!injected) throw new Error(`${wallet.name} is no longer available`);
    await injected.enable(CHAIN_ID);
    const key = await injected.getKey(CHAIN_ID);
    const address = key?.bech32Address;
    if (!address) throw new Error("The wallet returned no account");
    const signed = await injected.signArbitrary(CHAIN_ID, address, build(address));
    if (!signed?.signature) throw new Error("The wallet returned no signature");
    return {
      address,
      signature: signed.signature,
      publicKey: signed.pub_key?.value || toBase64(key.pubKey),
    };
  },
};
