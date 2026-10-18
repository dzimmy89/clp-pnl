import type { ChainKey } from "./chains";
import type { LpPosition, TokenInfo } from "./types";

/**
 * USD prices from DefiLlama's free coins API (no key, generous limits).
 * Chains it does not index fall back to inference from stablecoin pairs.
 */
const LLAMA_CHAIN: Partial<Record<ChainKey, string>> = {
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  bnb: "bsc",
  robinhood: "robinhood",
  arc: "arc",
};

const NATIVE_COIN: Record<ChainKey, string> = {
  ethereum: "coingecko:ethereum",
  base: "coingecko:ethereum",
  arbitrum: "coingecko:ethereum",
  bnb: "coingecko:binancecoin",
  robinhood: "coingecko:ethereum",
  arc: "coingecko:usd-coin",
};

const STABLE_SYMBOLS = new Set([
  "USDC", "USDC.E", "USDBC", "USDT", "USDT0", "DAI", "USDS", "USD1", "FDUSD", "PYUSD", "USDE", "GHO", "LUSD", "FRAX", "BUSD", "TUSD", "USDP", "EURC",
]);

export function isStable(symbol: string): boolean {
  return STABLE_SYMBOLS.has(symbol.toUpperCase());
}

export async function fetchPrices(
  chain: ChainKey,
  tokens: TokenInfo[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = new Set<string>();
  for (const t of tokens) {
    if (t.isNative) ids.add(NATIVE_COIN[chain]);
    else if (LLAMA_CHAIN[chain]) ids.add(`${LLAMA_CHAIN[chain]}:${t.address}`);
  }
  if (ids.size === 0) return out;
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${[...ids].join(",")}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return out;
    const data = (await res.json()) as { coins: Record<string, { price: number }> };
    for (const t of tokens) {
      const id = t.isNative ? NATIVE_COIN[chain] : `${LLAMA_CHAIN[chain]}:${t.address}`;
      const hit = Object.entries(data.coins).find(([k]) => k.toLowerCase() === id.toLowerCase());
      if (hit) out.set(t.address.toLowerCase(), hit[1].price);
    }
  } catch {
    // leave prices empty; caller infers from stable pairs where it can
  }
  return out;
}

/**
 * Fill in prices for both tokens of a position: from the price map first,
 * then by inferring the other side through the pool price when one side is
 * a stablecoin or already priced.
 */
export function applyPrices(p: LpPosition, prices: Map<string, number>): void {
  const p0 = prices.get(p.token0.address.toLowerCase()) ?? (isStable(p.token0.symbol) ? 1 : null);
  const p1 = prices.get(p.token1.address.toLowerCase()) ?? (isStable(p.token1.symbol) ? 1 : null);
  // price.current is token1 per token0
  p.token0.priceUsd = p0 ?? (p1 != null ? p1 * p.price.current : null);
  p.token1.priceUsd = p1 ?? (p0 != null && p.price.current > 0 ? p0 / p.price.current : null);

  if (p.token0.priceUsd != null && p.token1.priceUsd != null) {
    p.valueUsd = p.amount0 * p.token0.priceUsd + p.amount1 * p.token1.priceUsd;
    p.feesUsd = p.fees0 * p.token0.priceUsd + p.fees1 * p.token1.priceUsd;
  }
}
