"use client";

import type { ClientChainModule, ClientSigned, ClientWallet } from "@/lib/auth/chains/types";

/** The slice of TronWeb that injected Tron wallets expose. */
interface InjectedTronWeb {
  defaultAddress?: { base58?: string | false };
  trx: { signMessageV2(message: string): Promise<string> };
}

/** TronLink-style provider (TronLink, OKX, Bitget, TokenPocket…). */
interface InjectedTronLink {
  ready?: boolean;
  request?(args: { method: string; params?: unknown }): Promise<unknown>;
  tronWeb?: InjectedTronWeb | false;
}

interface TronWindow {
  tronLink?: InjectedTronLink;
  tronWeb?: InjectedTronWeb | false;
  okxwallet?: { tronLink?: InjectedTronLink };
  bitkeep?: { tronLink?: InjectedTronLink };
}

interface Detected {
  wallet: ClientWallet;
  provider: InjectedTronLink;
}

function tronWindow(): TronWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as TronWindow);
}

function detect(): Detected[] {
  const w = tronWindow();
  if (!w) return [];
  const out: Detected[] = [];
  const seen = new Set<unknown>();
  const add = (id: string, name: string, provider: InjectedTronLink | undefined) => {
    if (!provider || seen.has(provider)) return;
    seen.add(provider);
    out.push({ wallet: { id: `tron:${id}`, name }, provider });
  };
  // Named providers first, so a wallet that also claims window.tronLink keeps its own name.
  add("okx", "OKX Wallet", w.okxwallet?.tronLink);
  add("bitget", "Bitget Wallet", w.bitkeep?.tronLink);
  add("tronlink", "TronLink", w.tronLink);
  // Wallets (older TokenPocket, in-app browsers) that only inject a TronWeb instance.
  if (!out.length && w.tronWeb) add("injected", "Tron wallet", { tronWeb: w.tronWeb });
  return out;
}

function tronWebOf(provider: InjectedTronLink): InjectedTronWeb | null {
  if (provider.tronWeb) return provider.tronWeb;
  const fallback = tronWindow()?.tronWeb;
  return fallback || null;
}

function addressOf(provider: InjectedTronLink): string | null {
  const address = tronWebOf(provider)?.defaultAddress?.base58;
  return typeof address === "string" && address ? address : null;
}

async function connect(provider: InjectedTronLink): Promise<string> {
  if (provider.request) {
    const result = (await provider.request({ method: "tron_requestAccounts" })) as { code?: number; message?: string } | string | undefined;
    // TronLink answers { code: 200 } when approved, 4000 when a request is already open,
    // 4001 when the user refuses, and an empty value when the wallet is locked.
    if (result && typeof result === "object" && typeof result.code === "number" && result.code !== 200) {
      throw new Error(result.code === 4001 ? "The wallet refused the connection" : result.message || "Could not connect the wallet");
    }
  }
  const address = addressOf(provider);
  if (!address) throw new Error("Unlock your Tron wallet and try again");
  return address;
}

export const tronWallets: ClientChainModule = {
  installHint: "No Tron wallet found in this browser. Install TronLink.",

  list() {
    return detect().map((d) => d.wallet);
  },

  watch(onChange) {
    if (typeof window === "undefined") return () => {};
    const onMessage = (event: MessageEvent) => {
      const action = (event.data as { message?: { action?: string } } | null)?.message?.action;
      if (typeof action === "string" && /^(tronLink#initialized|setAccount|accountsChanged|connect|disconnect)$/.test(action)) {
        onChange();
      }
    };
    const onReady = () => onChange();
    window.addEventListener("tronLink#initialized", onReady);
    window.addEventListener("message", onMessage);
    window.addEventListener("load", onReady);
    // Extensions inject after the page script runs; look again shortly after.
    const timer = window.setTimeout(onReady, 600);
    return () => {
      window.removeEventListener("tronLink#initialized", onReady);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("load", onReady);
      window.clearTimeout(timer);
    };
  },

  async signIn(wallet, build): Promise<ClientSigned> {
    const found = detect().find((d) => d.wallet.id === wallet.id);
    if (!found) throw new Error(`${wallet.name} is no longer available`);
    const address = await connect(found.provider);
    const tronWeb = tronWebOf(found.provider);
    if (!tronWeb?.trx?.signMessageV2) throw new Error(`${wallet.name} cannot sign messages`);
    const signature = await tronWeb.trx.signMessageV2(build(address));
    if (typeof signature !== "string" || !signature) throw new Error("The wallet returned no signature");
    return { address, signature };
  },
};
