import { WALLET_KINDS, emptyWalletSet, type PastedWallet, type Position, type ProtocolFetch, type SpotHolding, type WalletKind, type WalletSet } from "@/lib/types";

/** Hard cap per address kind, so one request can't fan out into hundreds of RPC calls. */
export const MAX_WALLETS_PER_KIND = 12;

export type AddressKind = WalletKind;

/**
 * Comparison key for an address. Hex addresses (EVM, Sui, Aptos, Starknet) and NEAR are
 * case-insensitive; base58 and base64 ones (Solana, Tron, TON) and Canton party ids are not.
 */
export function walletKey(address: string): string {
  const trimmed = address.trim();
  return /^0x[0-9a-fA-F]+$/.test(trimmed) || /\.(near|tg)$|^[a-f0-9]{64}$/i.test(trimmed)
    ? trimmed.toLowerCase()
    : trimmed;
}

export function uniqueAddresses(list: string[], kind: AddressKind): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const address = kind === "near" ? raw.trim().toLowerCase() : raw.trim();
    if (!address) continue;
    const key = walletKey(address);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
    if (out.length >= MAX_WALLETS_PER_KIND) break;
  }
  return out;
}

export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Folds one protocol's per-wallet fetches into one. It is "ok" when any wallet read
 * cleanly; failures from the other wallets stay visible in the message, named by wallet.
 */
export function mergeProtocolFetches(fetches: { address: string; fetch: ProtocolFetch }[]): ProtocolFetch {
  const [first] = fetches;
  if (fetches.length === 1) return first.fetch;
  const statuses = fetches.map(({ fetch }) => fetch.status);
  const status: ProtocolFetch["status"] = statuses.includes("ok")
    ? "ok"
    : statuses.includes("manual")
      ? "manual"
      : statuses.every((s) => s === "skipped")
        ? "skipped"
        : "error";
  const problems = fetches
    .filter(({ fetch }) => fetch.status === "error" && fetch.message)
    .map(({ address, fetch }) => `${shortAddress(address)}: ${fetch.message}`);
  return {
    ...first.fetch,
    status,
    message: problems.length ? problems.join(" · ") : undefined,
    positions: fetches.flatMap(({ fetch }) => fetch.positions),
    spot: fetches.flatMap(({ fetch }) => fetch.spot),
  };
}

/** A wallet the book reads: one linked to the signed-in account, or one pasted on this device. */
export interface TrackedWallet {
  kind: AddressKind;
  address: string;
  label: string;
  source: "account" | "pasted";
}

/** Account wallets first, then pasted addresses that aren't already on the account. */
export function trackedWallets(
  account: { chain: string; address: string; label: string }[],
  pasted: PastedWallet[],
): TrackedWallet[] {
  // Account wallets on chains the book can't read are kept on the account but not queried.
  const out: TrackedWallet[] = account
    .filter((w): w is typeof w & { chain: AddressKind } => (WALLET_KINDS as readonly string[]).includes(w.chain))
    .map((w) => ({ kind: w.chain, address: w.address, label: w.label, source: "account" }));
  const seen = new Set(out.map((w) => `${w.kind}:${walletKey(w.address)}`));
  for (const wallet of pasted) {
    const address = wallet.kind === "near" ? wallet.address.trim().toLowerCase() : wallet.address.trim();
    const key = `${wallet.kind}:${walletKey(address)}`;
    if (!address || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: wallet.kind, address, label: wallet.label?.trim() ?? "", source: "pasted" });
  }
  return out;
}

export function walletSetOf(wallets: TrackedWallet[]): WalletSet {
  const set = emptyWalletSet();
  for (const wallet of wallets) set[wallet.kind].push(wallet.address);
  return set;
}

/** Query string the book API reads: one repeated key per kind, e.g. `evm=0xa&evm=0xb`. */
export function walletQuery(set: WalletSet): string {
  const params = new URLSearchParams();
  for (const kind of WALLET_KINDS) {
    for (const address of set[kind] ?? []) params.append(kind, address);
  }
  return params.toString();
}

/** Keeps only rows that belong to `wallet`, or everything when it is null. */
export function filterByWallet<T extends Position | SpotHolding>(rows: T[], wallet: string | null): T[] {
  if (!wallet) return rows;
  const key = walletKey(wallet);
  return rows.filter((row) => walletKey(row.wallet) === key);
}
