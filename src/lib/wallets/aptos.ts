"use client";

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getWallets } from "@wallet-standard/app";
import type { Wallet } from "@wallet-standard/base";
import type { ClientChainModule, ClientSigned, ClientWallet } from "@/lib/auth/chains/types";

/**
 * AIP-62 Wallet Standard (Petra, Nightly, OKX, Pontem…). The ts-sdk classes the wallets hand
 * back (AccountAddress, Ed25519PublicKey, Ed25519Signature) are read structurally, so the SDK
 * itself is not needed here. Older wallets return plain strings; both shapes are accepted.
 */

type UserResponse<T> = { status: "Approved"; args: T } | { status: "Rejected" };

type AccountInfo = { address: unknown; publicKey: unknown };

type SignMessageOutput = { fullMessage: string; signature: unknown };

type AptosFeatures = {
  "aptos:connect": { connect(silent?: boolean): Promise<UserResponse<AccountInfo> | AccountInfo> };
  "aptos:account"?: { account(): Promise<AccountInfo> };
  "aptos:signMessage": {
    signMessage(input: {
      message: string;
      nonce: string;
      address?: boolean;
      application?: boolean;
      chainId?: boolean;
    }): Promise<UserResponse<SignMessageOutput> | SignMessageOutput>;
  };
};

function canSignIn(wallet: Wallet): boolean {
  return "aptos:connect" in wallet.features && "aptos:signMessage" in wallet.features;
}

function aptosStandardWallets(): Wallet[] {
  if (typeof window === "undefined") return [];
  try {
    return getWallets().get().filter(canSignIn);
  } catch {
    return [];
  }
}

function unwrap<T extends object>(response: UserResponse<T> | T): T {
  if (response && typeof response === "object" && "status" in response) {
    const status = (response as { status: unknown }).status;
    if (status === "Approved" && "args" in response) return (response as { args: T }).args;
    if (status === "Rejected") throw new Error("Request rejected in the wallet");
  }
  return response as T;
}

/** Same canonical form the server uses: lowercase 0x + 64 hex. */
function normalize(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new Error("The wallet returned an invalid Aptos address");
  return `0x${hex.padStart(64, "0")}`;
}

function addressString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as { toStringLong?: () => string; toString?: () => string };
    if (typeof v.toStringLong === "function") return v.toStringLong();
    if (typeof v.toString === "function") return v.toString();
  }
  throw new Error("The wallet returned no Aptos address");
}

/** Uint8Array, hex string, or an SDK object with toUint8Array()/toString()/data. */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const hex = value.trim().replace(/^0x/i, "");
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
    return hexToBytes(hex.toLowerCase());
  }
  if (value && typeof value === "object") {
    const v = value as { toUint8Array?: () => Uint8Array; data?: unknown; toString?: () => string };
    if (typeof v.toUint8Array === "function") return v.toUint8Array();
    if (v.data !== undefined) {
      const inner = v.data as { data?: unknown } | Uint8Array;
      if (inner instanceof Uint8Array) return inner;
      if (inner && typeof inner === "object" && inner.data instanceof Uint8Array) return inner.data;
    }
    if (typeof v.toString === "function" && v.toString !== Object.prototype.toString) return toBytes(v.toString());
  }
  return null;
}

/** Only legacy single-key Ed25519 accounts are supported for now. */
function ed25519Hex(value: unknown, length: number, what: string): string {
  const bytes = toBytes(value);
  if (!bytes || bytes.length !== length) {
    throw new Error(`Unsupported ${what} from this wallet. Only Ed25519 Aptos accounts can sign in for now.`);
  }
  return `0x${bytesToHex(bytes)}`;
}

export const aptosWallets: ClientChainModule = {
  installHint: "No Aptos wallet found in this browser. Install Petra or Nightly.",

  list(): ClientWallet[] {
    return aptosStandardWallets().map((wallet) => ({ id: `aptos:${wallet.name}`, name: wallet.name, icon: wallet.icon }));
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

  async signIn(entry, build, ctx): Promise<ClientSigned> {
    const wallet = aptosStandardWallets().find((w) => `aptos:${w.name}` === entry.id);
    if (!wallet) throw new Error(`${entry.name} is no longer available`);
    const features = wallet.features as unknown as AptosFeatures;

    let account = unwrap(await features["aptos:connect"].connect());
    if (!account?.publicKey && features["aptos:account"]) account = await features["aptos:account"].account();
    if (!account) throw new Error("The wallet returned no account");

    const address = normalize(addressString(account.address));
    const publicKey = ed25519Hex(account.publicKey, 32, "account key");

    const output = unwrap(
      await features["aptos:signMessage"].signMessage({
        message: build(address),
        nonce: ctx.nonce,
        address: true,
        application: true,
      }),
    );
    if (typeof output?.fullMessage !== "string") throw new Error("The wallet returned no signed message");
    const signature = ed25519Hex(output.signature, 64, "signature");

    return { address, signature, publicKey, signedMessage: output.fullMessage };
  },
};
