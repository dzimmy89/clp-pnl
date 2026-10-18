import bs58 from "bs58";
import { CHAIN_LABEL } from "@/lib/auth/message";
import { WALLET_KINDS, type WalletKind } from "@/lib/types";

/**
 * Works out which chain a pasted address belongs to, so a list of mixed addresses can be
 * pasted in one go. The checks are format-only; each chain reader still validates its
 * input and reports a bad address as a note. Some formats are shared (a 0x + 64 hex
 * address can be Sui, Aptos or Starknet), so detection returns every candidate.
 */

export const WALLET_KIND_LABEL: Record<WalletKind, string> = { ...CHAIN_LABEL, canton: "Canton" };

/** Bech32 prefixes the Cosmos reader can't use: those chains derive keys differently. */
const NON_COSMOS_PREFIXES = new Set(["addr", "stake", "bc", "tb", "ltc", "inj", "evmos", "terra", "secret", "cro", "kava", "band", "dym", "thor", "zeta"]);

function base58Bytes(value: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return null;
  try {
    return bs58.decode(value);
  } catch {
    return null;
  }
}

/** Every chain `raw` could be an address on, most likely first. Empty when none fits. */
export function detectKinds(raw: string): WalletKind[] {
  const value = raw.trim();
  if (!value) return [];
  if (value.includes("::")) return ["canton"];
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return ["evm"];
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return ["sui", "aptos", "starknet"];
  // Starknet addresses often drop leading zeros; Aptos allows short forms too.
  if (/^0x[0-9a-fA-F]{1,63}$/.test(value)) return ["starknet", "aptos"];
  if (/^kaspa:[a-z0-9]+$/i.test(value)) return ["kaspa"];
  if (/^(addr|stake)1[a-z0-9]+$/i.test(value)) return ["cardano"];
  if (/^-?[01]:[0-9a-fA-F]{64}$/.test(value) || /^[EUk0][Qf][A-Za-z0-9_+/-]{46}$/.test(value)) return ["ton"];
  const bech = /^([a-z]+)1[02-9ac-hj-np-z]{38,}$/.exec(value.toLowerCase());
  if (bech && !NON_COSMOS_PREFIXES.has(bech[1])) return ["cosmos"];
  if (/\.(near|tg)$/i.test(value) || /^[a-f0-9]{64}$/.test(value)) return ["near"];
  const bytes = base58Bytes(value);
  if (bytes?.length === 32) return ["solana"];
  if (bytes?.length === 25 && bytes[0] === 0x41) return ["tron"];
  return [];
}

export interface ParsedAddress {
  address: string;
  /** Chains it could be on. One entry means the chain is settled. */
  kinds: WalletKind[];
}

/**
 * Splits pasted text into addresses (commas, spaces, semicolons or new lines) and detects
 * each one's chain. `chain:address` (e.g. `aptos:0x1…`) forces the chain.
 */
export function parseAddressList(text: string): ParsedAddress[] {
  const out: ParsedAddress[] = [];
  const seen = new Set<string>();
  for (const token of text.split(/[\s,;]+/)) {
    if (!token) continue;
    const forced = /^([a-z]+):(.+)$/i.exec(token);
    const kind = forced?.[1].toLowerCase();
    // `kaspa:` is part of a Kaspa address itself, not a chain override.
    const explicit = kind && kind !== "kaspa" && (WALLET_KINDS as readonly string[]).includes(kind) ? (kind as WalletKind) : null;
    const address = explicit ? forced![2] : token;
    const key = `${explicit ?? "auto"}|${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ address, kinds: explicit ? [explicit] : detectKinds(address) });
  }
  return out;
}
