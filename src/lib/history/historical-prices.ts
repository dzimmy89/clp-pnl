import { zeroAddress } from "viem";
import type { ChainKey } from "../chains";
import { isStable } from "../prices";
import type { TokenInfo } from "../types";

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

function coinId(chain: ChainKey, t: Pick<TokenInfo, "address" | "isNative">): string | null {
  if (t.isNative || t.address.toLowerCase() === zeroAddress) return NATIVE_COIN[chain];
  const slug = LLAMA_CHAIN[chain];
  return slug ? `${slug}:${t.address}` : null;
}

const cache = new Map<string, Promise<number | null>>();

/**
 * USD price of a token at a point in time, from DefiLlama's historical
 * endpoint (nearest price within a few hours). Stablecoins short-circuit to 1.
 */
export function historicalPrice(
  chain: ChainKey,
  token: Pick<TokenInfo, "address" | "isNative" | "symbol">,
  timestamp: number,
): Promise<number | null> {
  if (isStable(token.symbol)) return Promise.resolve(1);
  const id = coinId(chain, token);
  if (!id) return Promise.resolve(null);
  // Round to the hour so repeated flows in the same hour share a lookup.
  const ts = Math.floor(timestamp / 3600) * 3600;
  const k = `${id}@${ts}`;
  let p = cache.get(k);
  if (!p) {
    p = fetch(`https://coins.llama.fi/prices/historical/${ts}/${id}?searchWidth=6h`, {
      next: { revalidate: 86_400 },
    })
      .then(async (r) => {
        if (!r.ok) return null;
        const data = (await r.json()) as { coins: Record<string, { price: number }> };
        const hit = Object.entries(data.coins).find(([c]) => c.toLowerCase() === id.toLowerCase());
        return hit ? hit[1].price : null;
      })
      .catch(() => null);
    cache.set(k, p);
  }
  return p;
}

/** Native-token USD price at a time, for gas costs. */
export function historicalNativePrice(chain: ChainKey, timestamp: number): Promise<number | null> {
  return historicalPrice(chain, { address: zeroAddress, isNative: true, symbol: "" }, timestamp);
}
