import { describe, expect, it } from "vitest";
import type { Position, ProtocolFetch, SpotHolding } from "@/lib/types";
import {
  filterByWallet,
  MAX_WALLETS_PER_KIND,
  mergeProtocolFetches,
  trackedWallets,
  uniqueAddresses,
  walletKey,
  walletQuery,
  walletSetOf,
} from "./wallet-set";

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const B = "0xbBbBBBbbbBbBBBbBbBBbBBbbbBBbBbBBbbBBBBbB";

function position(wallet: string): Position {
  return { id: `aave:${wallet.toLowerCase()}`, protocol: "aave", chain: "Ethereum", wallet, label: "Aave", source: "live", legs: [] };
}

function fetchFor(wallet: string, status: ProtocolFetch["status"], message?: string): { address: string; fetch: ProtocolFetch } {
  return {
    address: wallet,
    fetch: { id: "aave", name: "Aave", chain: "Ethereum", status, message, positions: status === "ok" ? [position(wallet)] : [], spot: [] },
  };
}

describe("uniqueAddresses", () => {
  it("drops blanks and case-only EVM duplicates", () => {
    expect(uniqueAddresses([A, " ", A.toLowerCase(), B], "evm")).toEqual([A, B]);
  });

  it("lowercases NEAR accounts", () => {
    expect(uniqueAddresses(["Alice.near", "alice.near"], "near")).toEqual(["alice.near"]);
  });

  it("caps each kind", () => {
    const many = Array.from({ length: 30 }, (_, i) => `0x${i.toString(16).padStart(40, "0")}`);
    expect(uniqueAddresses(many, "evm")).toHaveLength(MAX_WALLETS_PER_KIND);
  });
});

describe("mergeProtocolFetches", () => {
  it("keeps one wallet's fetch as is", () => {
    const only = fetchFor(A, "skipped", "No EVM address saved.");
    expect(mergeProtocolFetches([only])).toBe(only.fetch);
  });

  it("is ok when any wallet read, and names the wallet that failed", () => {
    const merged = mergeProtocolFetches([fetchFor(A, "ok"), fetchFor(B, "error", "timeout")]);
    expect(merged.status).toBe("ok");
    expect(merged.positions).toHaveLength(1);
    expect(merged.message).toBe("0xbBbB…BBbB: timeout");
  });

  it("concatenates positions from every wallet", () => {
    const merged = mergeProtocolFetches([fetchFor(A, "ok"), fetchFor(B, "ok")]);
    expect(merged.positions.map((p) => p.wallet)).toEqual([A, B]);
    expect(merged.message).toBeUndefined();
  });
});

describe("tracked wallets", () => {
  const account = [
    { chain: "evm" as const, address: A, label: "Main" },
    { chain: "solana" as const, address: "So1anaWa11et111111111111111111111111111111", label: "" },
  ];

  it("lists account wallets, then pasted ones not already on the account", () => {
    const tracked = trackedWallets(account, [{ kind: "evm", address: A.toLowerCase() }, { kind: "near", address: "bob.near" }]);
    expect(tracked.map((w) => [w.kind, w.source])).toEqual([
      ["evm", "account"],
      ["solana", "account"],
      ["near", "pasted"],
    ]);
  });

  it("builds a repeated-key query", () => {
    const tracked = trackedWallets(account, [{ kind: "evm", address: B }]);
    expect(walletQuery(walletSetOf(tracked))).toBe(
      `evm=${A}&evm=${B}&solana=So1anaWa11et111111111111111111111111111111`,
    );
  });
});

describe("filterByWallet", () => {
  const spot = [{ wallet: A }, { wallet: B }] as SpotHolding[];

  it("returns everything with no filter", () => {
    expect(filterByWallet(spot, null)).toHaveLength(2);
  });

  it("matches EVM addresses regardless of case", () => {
    expect(filterByWallet(spot, B.toLowerCase())).toEqual([{ wallet: B }]);
  });
});

describe("wallets on the newer chains", () => {
  const sui = `0x${"ab".repeat(32)}`;
  it("queries account wallets on every readable chain and skips unknown ones", () => {
    const wallets = trackedWallets(
      [
        { chain: "sui", address: sui, label: "Slush" },
        { chain: "kaspa", address: "kaspa:qqexample", label: "" },
        { chain: "dogecoin", address: "D123", label: "" },
      ],
      [],
    );
    expect(wallets.map((w) => w.kind)).toEqual(["sui", "kaspa"]);
    expect(walletQuery(walletSetOf(wallets))).toBe(`sui=${sui}&kaspa=kaspa%3Aqqexample`);
  });

  it("tracks several pasted addresses per chain, once each", () => {
    const wallets = trackedWallets(
      [{ chain: "sui", address: sui, label: "" }],
      [
        { kind: "sui", address: sui.toUpperCase().replace("0X", "0x") },
        { kind: "sui", address: `0x${"cd".repeat(32)}`, label: " Vault " },
        { kind: "tron", address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE" },
        { kind: "tron", address: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE" },
        { kind: "near", address: "Bob.near" },
      ],
    );
    expect(wallets.map((w) => [w.kind, w.source, w.label])).toEqual([
      ["sui", "account", ""],
      ["sui", "pasted", "Vault"],
      ["tron", "pasted", ""],
      ["near", "pasted", ""],
    ]);
    expect(wallets[3].address).toBe("bob.near");
  });

  it("treats hex addresses of any length as case-insensitive", () => {
    expect(walletKey(sui.toUpperCase().replace("0X", "0x"))).toBe(sui);
  });
});
