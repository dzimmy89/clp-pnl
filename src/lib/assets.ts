import type { AssetKind } from "@/lib/types";

const BTC_LIKE = new Set([
  "BTC",
  "WBTC",
  "CBBTC",
  "TBTC",
  "BTCB",
  "UBTC",
  "CBTC",
  "WBTC.E",
]);

const STABLES = new Set([
  "USDC",
  "USDT",
  "USDT0",
  "DAI",
  "USDE",
  "SUSDE",
  "GHO",
  "FRAX",
  "USDHL",
  "USDH",
  "USR",
  "VAI",
  "USDS",
  "LUSD",
  "CRVUSD",
  "PYUSD",
  "USD1",
  "USDC.E",
  "USDT.E",
  "FDUSD",
  "TUSD",
  "USDBC",
  "USDHL",
  "USD₮",
  "USDD",
  "USDJ",
  "STUSDT",
  "DJED",
  "IUSD",
  "BUCK",
  "AUSD",
]);

const UNDERLYING_ALIAS: Record<string, string> = {
  WETH: "ETH",
  UETH: "ETH",
  WSOL: "SOL",
  WBNB: "BNB",
  WHYPE: "HYPE",
  WNEAR: "NEAR",
};

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\s+/g, "");
}

export function isBtcLike(symbol: string): boolean {
  return BTC_LIKE.has(normalizeSymbol(symbol));
}

export function isStableSymbol(symbol: string): boolean {
  const normalized = normalizeSymbol(symbol);
  if (STABLES.has(normalized)) return true;
  return normalized.startsWith("USD") && normalized.length <= 6;
}

export function assetKind(symbol: string): AssetKind {
  if (isBtcLike(symbol)) return "btc";
  if (isStableSymbol(symbol)) return "stable";
  return "volatile";
}

export function underlyingOf(symbol: string): string {
  const normalized = normalizeSymbol(symbol);
  if (isBtcLike(normalized)) return "BTC";
  return UNDERLYING_ALIAS[normalized] ?? normalized;
}

export function assumedLiquidationThreshold(kind: AssetKind): number {
  if (kind === "btc") return 0.78;
  if (kind === "stable") return 0.8;
  return 0.75;
}
