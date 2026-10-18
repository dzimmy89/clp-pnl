"use client";

import { starknetSignInTypedData } from "@/lib/auth/chains/starknet";
import type { ClientChainModule, ClientSigned, ClientWallet } from "@/lib/auth/chains/types";

/**
 * Starknet sign-in with injected wallets (Ready / Argent X, Braavos). They inject a
 * get-starknet object at `window.starknet_<id>` (and often `window.starknet`). We use the
 * legacy v3 API (`enable`, `selectedAddress`, `account.signMessage`) when present and the
 * SNIP wallet API (`request({ type })`) otherwise.
 */

type Felt = string | number | bigint;
type RawSignature = Felt[] | { r: Felt; s: Felt } | string;

interface InjectedStarknet {
  id?: string;
  name?: string;
  icon?: string | { dark?: string; light?: string };
  selectedAddress?: string;
  enable?(options?: { starknetVersion?: string }): Promise<string[] | undefined>;
  account?: { address?: string; signMessage?(typedData: unknown): Promise<RawSignature> };
  request?(call: { type: string; params?: unknown }): Promise<unknown>;
}

interface Detected {
  wallet: ClientWallet;
  provider: InjectedStarknet;
}

function isProvider(value: unknown): value is InjectedStarknet {
  if (!value || typeof value !== "object") return false;
  const v = value as InjectedStarknet;
  return typeof v.enable === "function" || typeof v.request === "function";
}

function iconOf(provider: InjectedStarknet): string | undefined {
  const icon = provider.icon;
  if (typeof icon === "string") return icon || undefined;
  return icon?.light || icon?.dark || undefined;
}

const KNOWN_NAMES: Record<string, string> = { argentX: "Ready (Argent X)", braavos: "Braavos" };

function detect(): Detected[] {
  if (typeof window === "undefined") return [];
  const w = window as unknown as Record<string, unknown>;
  const out: Detected[] = [];
  const seen = new Set<unknown>();
  // Named keys first (starknet_argentX, starknet_braavos, …), then the generic window.starknet.
  const keys = Object.keys(w)
    .filter((key) => key.startsWith("starknet_"))
    .sort();
  keys.push("starknet");
  for (const key of keys) {
    let provider: unknown;
    try {
      provider = w[key];
    } catch {
      continue;
    }
    if (!isProvider(provider) || seen.has(provider)) continue;
    seen.add(provider);
    const id = provider.id || (key === "starknet" ? "injected" : key.slice("starknet_".length));
    if (out.some((d) => d.wallet.id === `starknet:${id}`)) continue;
    const name = provider.name || KNOWN_NAMES[id] || "Starknet wallet";
    out.push({ wallet: { id: `starknet:${id}`, name, icon: iconOf(provider) }, provider });
  }
  return out;
}

async function connect(provider: InjectedStarknet): Promise<string> {
  let address: string | undefined;
  if (typeof provider.enable === "function") {
    const accounts = await provider.enable({ starknetVersion: "v5" });
    address = provider.selectedAddress || provider.account?.address || accounts?.[0];
  } else if (typeof provider.request === "function") {
    const accounts = await provider.request({ type: "wallet_requestAccounts" });
    if (Array.isArray(accounts) && typeof accounts[0] === "string") address = accounts[0];
  }
  if (!address) throw new Error("Unlock your Starknet wallet and try again");
  return address;
}

function feltToString(value: Felt): string {
  if (typeof value === "string") return value;
  return `0x${BigInt(value).toString(16)}`;
}

function normalizeSignature(raw: unknown): string[] {
  if (Array.isArray(raw) && raw.length > 0) return (raw as Felt[]).map(feltToString);
  if (raw && typeof raw === "object" && "r" in raw && "s" in raw) {
    const { r, s } = raw as { r: Felt; s: Felt };
    return [feltToString(r), feltToString(s)];
  }
  throw new Error("The wallet returned no signature");
}

async function sign(provider: InjectedStarknet, typedData: unknown): Promise<string[]> {
  if (typeof provider.account?.signMessage === "function") {
    return normalizeSignature(await provider.account.signMessage(typedData));
  }
  if (typeof provider.request === "function") {
    return normalizeSignature(await provider.request({ type: "wallet_signTypedData", params: typedData }));
  }
  throw new Error("This wallet cannot sign messages");
}

export const starknetWallets: ClientChainModule = {
  installHint: "No Starknet wallet found in this browser. Install Ready (Argent X) or Braavos.",

  list() {
    return detect().map((d) => d.wallet);
  },

  watch(onChange) {
    if (typeof window === "undefined") return () => {};
    // Extensions inject after the page script runs and get-starknet has no event; look again a few times.
    const timers = [300, 1000, 2500].map((ms) => window.setTimeout(onChange, ms));
    window.addEventListener("load", onChange);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("load", onChange);
    };
  },

  async signIn(wallet, build, { nonce }): Promise<ClientSigned> {
    const found = detect().find((d) => d.wallet.id === wallet.id);
    if (!found) throw new Error(`${wallet.name} is no longer available`);
    const address = await connect(found.provider);
    const typedData = starknetSignInTypedData(build(address), nonce);
    const signature = await sign(found.provider, typedData);
    return { address, signature: JSON.stringify(signature) };
  },
};
