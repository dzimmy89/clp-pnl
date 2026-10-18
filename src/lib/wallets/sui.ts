"use client";

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { ClientChainModule, ClientSigned, ClientWallet } from "@/lib/auth/chains/types";

type ConnectFeature = {
  "standard:connect": { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
};
type SignPersonalMessageFeature = {
  "sui:signPersonalMessage"?: {
    signPersonalMessage(input: {
      message: Uint8Array;
      account: WalletAccount;
      chain?: string;
    }): Promise<{ bytes: string; signature: string }>;
  };
  /** Deprecated predecessor, still the only one some older wallets ship. Same signature format. */
  "sui:signMessage"?: {
    signMessage(input: { message: Uint8Array; account: WalletAccount }): Promise<{ messageBytes: string; signature: string }>;
  };
};

const MAINNET = "sui:mainnet";

function canSignIn(wallet: Wallet): boolean {
  return (
    wallet.chains.some((chain) => chain.startsWith("sui:")) &&
    "standard:connect" in wallet.features &&
    ("sui:signPersonalMessage" in wallet.features || "sui:signMessage" in wallet.features)
  );
}

function suiStandardWallets(): Wallet[] {
  if (typeof window === "undefined") return [];
  try {
    return getWallets().get().filter(canSignIn);
  } catch {
    return [];
  }
}

/** Same canonical form the server uses: lowercase 0x + 64 hex. */
function normalize(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new Error("The wallet returned an invalid Sui address");
  return `0x${hex.padStart(64, "0")}`;
}

/** Wallet Standard: Slush (Sui Wallet), Suiet, Phantom, OKX and others register here. */
export const suiWallets: ClientChainModule = {
  installHint: "No Sui wallet found in this browser. Install Slush, Suiet or Phantom.",

  list(): ClientWallet[] {
    return suiStandardWallets().map((wallet) => ({ id: `sui:${wallet.name}`, name: wallet.name, icon: wallet.icon }));
  },

  watch(onChange) {
    if (typeof window === "undefined") return () => {};
    const api = getWallets();
    const offRegister = api.on("register", onChange);
    const offUnregister = api.on("unregister", onChange);
    return () => {
      offRegister();
      offUnregister();
    };
  },

  async signIn(entry, build): Promise<ClientSigned> {
    const wallet = suiStandardWallets().find((w) => `sui:${w.name}` === entry.id);
    if (!wallet) throw new Error(`${entry.name} is no longer available`);

    const { accounts } = await (wallet.features as unknown as ConnectFeature)["standard:connect"].connect();
    const account =
      accounts.find((a) => a.chains.includes(MAINNET)) ??
      accounts.find((a) => a.chains.some((c) => c.startsWith("sui:"))) ??
      accounts[0];
    if (!account) throw new Error("The wallet returned no account");

    const address = normalize(account.address);
    const message = new TextEncoder().encode(build(address));
    const features = wallet.features as unknown as SignPersonalMessageFeature;

    let signature: string;
    if (features["sui:signPersonalMessage"]) {
      ({ signature } = await features["sui:signPersonalMessage"].signPersonalMessage({ message, account, chain: MAINNET }));
    } else if (features["sui:signMessage"]) {
      ({ signature } = await features["sui:signMessage"].signMessage({ message, account }));
    } else {
      throw new Error(`${entry.name} cannot sign messages`);
    }
    return { address, signature };
  },
};
