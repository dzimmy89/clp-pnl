import {
  emptyRead,
  getJson,
  llamaPrices,
  readApp,
  spotRow,
  units,
  type ChainDeps,
  type ChainReader,
} from "@/lib/adapters/chains/common";
import { decodeKaspaAddress } from "@/lib/auth/chains/kaspa";
import type { SpotHolding } from "@/lib/types";

/**
 * Kaspa reader. KAS balance from the public REST API (https://api.kaspa.org/addresses/{address}/balance,
 * in sompi, 8 decimals) and KRC-20 balances from the Kasplex indexer
 * (https://api.kasplex.org/v1/krc20/address/{address}/tokenlist, decimals in each row). KAS is priced as
 * coingecko:kaspa; KRC-20 tokens are priced only where a CoinGecko id is known, else shown unpriced.
 */

const KASPA_API = "https://api.kaspa.org";
const KASPLEX_API = "https://api.kasplex.org/v1";
const CHAIN = "Kaspa";
const MAX_PAGES = 5;

/** KRC-20 tick → CoinGecko id, for the few tokens CoinGecko lists. */
const KRC20_COINGECKO: Record<string, string> = {
  NACHO: "nacho-the-kat",
};

/** Lowercase `kaspa:…` mainnet address. Throws on anything else. */
export function kaspaAddress(address: string): string {
  const trimmed = address.trim();
  const withPrefix = trimmed.includes(":") ? trimmed : `kaspa:${trimmed}`;
  const { prefix } = decodeKaspaAddress(withPrefix);
  if (prefix !== "kaspa") throw new Error("Only Kaspa mainnet addresses are supported");
  return withPrefix.toLowerCase();
}

interface KasplexToken {
  tick?: string;
  ca?: string;
  name?: string;
  balance?: string;
  locked?: string;
  dec?: string;
}
interface KasplexPage {
  message?: string;
  next?: string | null;
  result?: KasplexToken[];
}

async function readKrc20(address: string, deps: ChainDeps): Promise<KasplexToken[]> {
  const tokens: KasplexToken[] = [];
  let next: string | null | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = next ? `?next=${encodeURIComponent(next)}` : "";
    const body = await getJson<KasplexPage>(`${KASPLEX_API}/krc20/address/${address}/tokenlist${query}`, {}, deps);
    if (body.message && body.message !== "successful" && !body.result) throw new Error(body.message);
    tokens.push(...(body.result ?? []));
    next = body.next;
    if (!next || !body.result?.length) break;
  }
  return tokens;
}

export const readKaspa: ChainReader = async (address, deps = {}) => {
  const kaspa = kaspaAddress(address);
  const wallet = address.trim();
  const out = emptyRead();

  const [balance, krc20] = await Promise.all([
    getJson<{ address: string; balance: number | string }>(`${KASPA_API}/addresses/${kaspa}/balance`, {}, deps),
    readApp("KRC-20", out.notes, () => readKrc20(kaspa, deps)),
  ]);

  const tokens = (krc20 ?? []).map((token) => {
    const raw = BigInt(token.balance || "0") + BigInt(token.locked || "0");
    const symbol = (token.tick ?? token.name ?? token.ca ?? "KRC20").toUpperCase();
    return { symbol, id: token.ca ?? symbol, amount: units(raw, Number(token.dec ?? 8)) };
  });

  const prices = await llamaPrices(
    ["coingecko:kaspa", ...tokens.flatMap((token) => (KRC20_COINGECKO[token.symbol] ? [`coingecko:${KRC20_COINGECKO[token.symbol]}`] : []))],
    deps,
  );

  const spot: SpotHolding[] = [];
  const kas = spotRow({ protocol: "kaspa", wallet, chain: CHAIN, symbol: "KAS", amount: units(String(balance.balance ?? 0), 8), price: prices["coingecko:kaspa"] });
  if (kas) spot.push(kas);
  for (const token of tokens) {
    const id = KRC20_COINGECKO[token.symbol];
    const row = spotRow({ protocol: "kaspa", wallet, chain: CHAIN, symbol: token.symbol, amount: token.amount, price: id ? prices[`coingecko:${id}`] : null, tokenId: `krc20:${token.id}` });
    if (row) spot.push(row);
  }

  out.spot = spot.sort((a, b) => b.usd - a.usd).slice(0, 100);
  return out;
};
