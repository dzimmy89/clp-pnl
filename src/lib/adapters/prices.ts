import { fetchJson } from "@/lib/http";

const COINGECKO: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  HYPE: "hyperliquid",
  BNB: "binancecoin",
  NEAR: "near",
  WBTC: "wrapped-bitcoin",
  WETH: "weth",
  STETH: "staked-ether",
  JITOSOL: "jito-staked-sol",
  MSOL: "msol",
  JUPSOL: "jupiter-staked-sol",
  BSOL: "blazestake-staked-sol",
  STNEAR: "staked-near",
};

export interface PriceBook {
  btc: number | null;
  timestamp: number | null;
  bySymbol: Record<string, number>;
  byKey: Record<string, number>;
  error?: string;
}

interface LlamaResponse {
  coins?: Record<string, { price?: number; timestamp?: number; symbol?: string }>;
}

let cache: { at: number; book: PriceBook } | null = null;

export function symbolToLlamaKey(symbol: string): string | null {
  const id = COINGECKO[symbol.toUpperCase()];
  return id ? `coingecko:${id}` : null;
}

export async function fetchPriceBook(extraKeys: string[] = []): Promise<PriceBook> {
  const now = Date.now();
  if (cache && now - cache.at < 45_000 && extraKeys.length === 0) return cache.book;
  const keys = new Set<string>([
    "coingecko:bitcoin",
    "coingecko:ethereum",
    "coingecko:solana",
    "coingecko:hyperliquid",
    "coingecko:binancecoin",
    "coingecko:near",
    "coingecko:wrapped-bitcoin",
    ...extraKeys,
  ]);
  const url = `https://coins.llama.fi/prices/current/${[...keys].join(",")}`;
  try {
    const body = await fetchJson<LlamaResponse>(url);
    const byKey: Record<string, number> = {};
    const bySymbol: Record<string, number> = {};
    let timestamp: number | null = null;
    for (const [key, coin] of Object.entries(body.coins ?? {})) {
      if (coin.price == null || !(coin.price > 0)) continue;
      byKey[key] = coin.price;
      if (coin.symbol) bySymbol[coin.symbol.toUpperCase()] = coin.price;
      if (coin.timestamp && (timestamp == null || coin.timestamp < timestamp)) {
        timestamp = coin.timestamp;
      }
    }
    if (byKey["coingecko:bitcoin"]) bySymbol.BTC = byKey["coingecko:bitcoin"];
    if (byKey["coingecko:ethereum"]) bySymbol.ETH = byKey["coingecko:ethereum"];
    if (byKey["coingecko:solana"]) bySymbol.SOL = byKey["coingecko:solana"];
    if (byKey["coingecko:hyperliquid"]) bySymbol.HYPE = byKey["coingecko:hyperliquid"];
    if (byKey["coingecko:binancecoin"]) bySymbol.BNB = byKey["coingecko:binancecoin"];
    if (byKey["coingecko:near"]) bySymbol.NEAR = byKey["coingecko:near"];
    const book: PriceBook = {
      btc: bySymbol.BTC ?? null,
      timestamp,
      bySymbol,
      byKey,
    };
    if (extraKeys.length === 0) cache = { at: now, book };
    return book;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Price request failed";
    return {
      btc: cache?.book.btc ?? null,
      timestamp: cache?.book.timestamp ?? null,
      bySymbol: cache?.book.bySymbol ?? {},
      byKey: cache?.book.byKey ?? {},
      error: message,
    };
  }
}

export function priceForSymbol(book: PriceBook, symbol: string): number | null {
  const upper = symbol.toUpperCase();
  if (book.bySymbol[upper]) return book.bySymbol[upper];
  if (upper === "WBTC" || upper === "CBBTC" || upper === "TBTC" || upper === "BTCB" || upper === "UBTC" || upper === "CBTC") {
    return book.bySymbol.BTC ?? null;
  }
  if (upper === "WETH") return book.bySymbol.ETH ?? null;
  if (upper === "WBNB") return book.bySymbol.BNB ?? null;
  if (upper === "WHYPE") return book.bySymbol.HYPE ?? null;
  if (upper === "USDC" || upper === "USDT" || upper === "USDT0" || upper === "DAI" || upper === "USDE") {
    return 1;
  }
  return null;
}
