"use client";

import { bech32 } from "@scure/base";
import type { ClientChainModule, ClientSigned, ClientWallet } from "@/lib/auth/chains/types";

/** CIP-30 enabled API: the calls sign-in needs. Addresses are hex CBOR bytes. */
interface Cip30Api {
  getNetworkId(): Promise<number>;
  getUsedAddresses(paginate?: unknown): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getRewardAddresses?(): Promise<string[]>;
  signData(address: string, payload: string): Promise<{ signature: string; key: string }>;
}

/** CIP-30 wallet entry under window.cardano.<key>. */
interface Cip30Wallet {
  name?: string;
  icon?: string;
  apiVersion?: string;
  enable(): Promise<Cip30Api>;
}

function injected(): [string, Cip30Wallet][] {
  if (typeof window === "undefined") return [];
  const root = (window as unknown as { cardano?: Record<string, unknown> }).cardano;
  if (!root || typeof root !== "object") return [];
  const out: [string, Cip30Wallet][] = [];
  const seen = new Set<string>();
  for (const key of Object.keys(root)) {
    let entry: unknown;
    try {
      entry = root[key];
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const wallet = entry as Cip30Wallet;
    if (typeof wallet.enable !== "function" || (!wallet.apiVersion && !wallet.name)) continue;
    // Some wallets register under several keys (e.g. eternl + ccvault, typhon + typhoncip30).
    const dedupe = `${wallet.name ?? key}|${wallet.icon ?? ""}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push([key, wallet]);
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error("The wallet returned a malformed address");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function utf8Hex(text: string): string {
  return Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Raw Cardano address bytes → bech32 (`addr1…`, `stake1…`, `_test` on testnets). */
function toBech32(bytes: Uint8Array): string {
  if (!bytes.length) throw new Error("The wallet returned no address");
  const type = bytes[0] >> 4;
  const hrp = (type === 14 || type === 15 ? "stake" : "addr") + ((bytes[0] & 0x0f) === 1 ? "" : "_test");
  return bech32.encode(hrp, bech32.toWords(bytes), 1023);
}

export const cardanoWallets: ClientChainModule = {
  installHint: "No Cardano wallet found in this browser. Install Eternl, Lace or Vespr.",

  list(): ClientWallet[] {
    return injected().map(([key, wallet]) => ({
      id: `cardano:${key}`,
      name: wallet.name || key.charAt(0).toUpperCase() + key.slice(1),
      icon: wallet.icon || undefined,
    }));
  },

  watch(onChange) {
    if (typeof window === "undefined") return () => {};
    // CIP-30 has no announce event and wallets inject at different times; poll briefly.
    let last = injected()
      .map(([key]) => key)
      .join(",");
    let ticks = 0;
    const check = () => {
      const now = injected()
        .map(([key]) => key)
        .join(",");
      if (now !== last) {
        last = now;
        onChange();
      }
      if (++ticks >= 20) window.clearInterval(timer);
    };
    const timer = window.setInterval(check, 500);
    window.addEventListener("load", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("load", check);
    };
  },

  async signIn(wallet, build): Promise<ClientSigned> {
    const key = wallet.id.replace(/^cardano:/, "");
    const entry = injected().find(([k]) => k === key)?.[1];
    if (!entry) throw new Error(`${wallet.name} is no longer available`);
    const api = await entry.enable();
    const network = await api.getNetworkId().catch(() => 1);
    if (network !== 1) throw new Error(`Switch ${wallet.name} to Cardano mainnet and try again`);

    const used = await api.getUsedAddresses().catch(() => [] as string[]);
    const raw = used?.[0] ?? (await api.getChangeAddress());
    if (!raw) throw new Error("The wallet returned no address");
    // CIP-30 returns hex bytes; tolerate the odd wallet that hands back bech32.
    const bytes = /^(addr|stake)/i.test(raw)
      ? bech32.fromWords(bech32.decode(raw.toLowerCase() as `${string}1${string}`, 1023).words)
      : hexToBytes(raw);
    const addressHex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const address = toBech32(bytes);

    const signed = await api.signData(addressHex, utf8Hex(build(address)));
    if (!signed?.signature || !signed.key) throw new Error("The wallet returned no signature");
    return { address, signature: signed.signature, publicKey: signed.key };
  },
};
