"use client";

import type { ClientChainModule, ClientSigned, ClientWallet } from "@/lib/auth/chains/types";

/** The slice of KasWare's injected provider (window.kasware) sign-in needs. */
interface KasWare {
  requestAccounts(): Promise<string[]>;
  getPublicKey?(): Promise<string>;
  /**
   * `type` defaults to "auto" (Schnorr, or ECDSA for Tangem accounts). Schnorr goes through
   * kaspa-wasm `signMessage`, which returns the 64-byte signature as hex.
   */
  signMessage(text: string, params?: { type?: "auto" | "schnorr" | "ecdsa"; noAuxRand?: boolean }): Promise<string>;
  on?(event: string, handler: () => void): void;
  removeListener?(event: string, handler: () => void): void;
}

const WALLET: ClientWallet = { id: "kaspa:kasware", name: "KasWare" };

function provider(): KasWare | undefined {
  if (typeof window === "undefined") return undefined;
  const kasware = (window as unknown as { kasware?: KasWare }).kasware;
  return kasware && typeof kasware.signMessage === "function" ? kasware : undefined;
}

/**
 * Version 1 (PubKeyECDSA) addresses start with "q" followed by one of y/9/x/8: the version byte
 * fills the first 8 bits of the base32 payload. Version 0 (Schnorr) gives q + q/p/z/r.
 */
function isEcdsaAddress(address: string): boolean {
  const body = address.slice(address.indexOf(":") + 1);
  return body[0] === "q" && "y9x8".includes(body[1] ?? "");
}

/** KasWare returns hex; convert base64 if a build ever returns that. */
function toHex(signature: string): string {
  const s = signature.trim().replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return s.toLowerCase();
  const binary = atob(s);
  return Array.from(binary, (ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

export const kaspaWallets: ClientChainModule = {
  installHint: "No Kaspa wallet found in this browser. Install KasWare.",

  list(): ClientWallet[] {
    return provider() ? [WALLET] : [];
  },

  watch(onChange) {
    if (typeof window === "undefined") return () => {};
    let present = Boolean(provider());
    const check = () => {
      const now = Boolean(provider());
      if (now !== present) {
        present = now;
        onChange();
      }
    };
    // KasWare injects after the page script runs; look again for a few seconds.
    const timers = [300, 1000, 3000].map((ms) => window.setTimeout(check, ms));
    window.addEventListener("load", check);
    const kasware = provider();
    kasware?.on?.("accountsChanged", onChange);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("load", check);
      kasware?.removeListener?.("accountsChanged", onChange);
    };
  },

  async signIn(wallet, build): Promise<ClientSigned> {
    const kasware = provider();
    if (!kasware) throw new Error(`${wallet.name} is no longer available`);
    const [raw] = await kasware.requestAccounts();
    if (!raw) throw new Error("The wallet returned no account");
    const address = raw.trim().toLowerCase();
    if (!address.startsWith("kaspa:")) throw new Error("Switch KasWare to Kaspa mainnet and try again");

    const type = isEcdsaAddress(address) ? "ecdsa" : "schnorr";
    const signature = await kasware.signMessage(build(address), { type });
    if (!signature) throw new Error("The wallet returned no signature");
    const publicKey = await kasware.getPublicKey?.().catch(() => undefined);
    return {
      address,
      signature: toHex(signature),
      ...(publicKey ? { publicKey } : {}),
      extra: { type },
    };
  },
};
