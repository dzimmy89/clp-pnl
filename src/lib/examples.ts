import { assumedLiquidationThreshold } from "@/lib/assets";
import type { AssetKind, Leg, Position, SpotHolding } from "@/lib/types";

export const EXAMPLE_BTC_PRICE = 100_000;

const MARKS: Record<string, number> = {
  BTC: 100_000,
  ETH: 3_000,
  SOL: 150,
  HYPE: 25,
  BNB: 600,
  NEAR: 5,
  USDC: 1,
  USDT: 1,
  USDT0: 1,
};

function leg(input: {
  side: "supply" | "borrow";
  symbol: string;
  underlying: string;
  kind: AssetKind;
  amount: number;
  apy: number;
  liquidationThreshold?: number;
}): Leg {
  const price = MARKS[input.underlying] ?? MARKS[input.symbol] ?? 1;
  const threshold =
    input.side === "supply"
      ? (input.liquidationThreshold ?? assumedLiquidationThreshold(input.kind))
      : undefined;
  return {
    id: `${input.side}-${input.symbol}`,
    side: input.side,
    symbol: input.symbol,
    underlying: input.underlying,
    kind: input.kind,
    amount: input.amount,
    usd: input.amount * price,
    apy: input.apy,
    priceUsd: price,
    liquidationThreshold: threshold,
    liquidationThresholdSource: "assumed",
    isCollateral: input.side === "supply",
  };
}

function book(
  id: string,
  protocol: Position["protocol"],
  chain: string,
  label: string,
  legs: Leg[],
  targetHedgeRatio: number,
  note?: string,
): Position {
  return {
    id,
    protocol,
    chain,
    wallet: "example-book",
    label,
    source: "example",
    legs,
    targetHedgeRatio,
    healthFactor: null,
    healthFactorSource: "estimated",
    note,
  };
}

export const EXAMPLE_POSITIONS: Position[] = [
  book(
    "example-aave",
    "aave",
    "Ethereum",
    "WBTC collateral, USDC borrow, partial WBTC hedge",
    [
      leg({
        side: "supply",
        symbol: "WBTC",
        underlying: "BTC",
        kind: "btc",
        amount: 1.5,
        apy: 0.002,
        liquidationThreshold: 0.78,
      }),
      leg({
        side: "borrow",
        symbol: "USDC",
        underlying: "USDC",
        kind: "stable",
        amount: 40_000,
        apy: 0.05,
      }),
      leg({
        side: "borrow",
        symbol: "WBTC",
        underlying: "BTC",
        kind: "btc",
        amount: 0.3,
        apy: 0.004,
      }),
    ],
    0.2,
    "Illustrative Ethereum book. BTC supply yield is thin, so net carry is negative.",
  ),
  book(
    "example-kamino",
    "kamino",
    "Solana",
    "SOL collateral, USDC borrow, partial SOL hedge",
    [
      leg({
        side: "supply",
        symbol: "SOL",
        underlying: "SOL",
        kind: "volatile",
        amount: 100,
        apy: 0.06,
        liquidationThreshold: 0.75,
      }),
      leg({
        side: "borrow",
        symbol: "USDC",
        underlying: "USDC",
        kind: "stable",
        amount: 5_000,
        apy: 0.08,
      }),
      leg({
        side: "borrow",
        symbol: "SOL",
        underlying: "SOL",
        kind: "volatile",
        amount: 20,
        apy: 0.03,
      }),
    ],
    0.2,
  ),
  book(
    "example-hyperlend",
    "hyperlend",
    "HyperEVM",
    "HYPE collateral, USDT0 borrow, partial HYPE hedge",
    [
      leg({
        side: "supply",
        symbol: "HYPE",
        underlying: "HYPE",
        kind: "volatile",
        amount: 2_000,
        apy: 0.04,
        liquidationThreshold: 0.7,
      }),
      leg({
        side: "borrow",
        symbol: "USDT0",
        underlying: "USDT0",
        kind: "stable",
        amount: 12_000,
        apy: 0.06,
      }),
      leg({
        side: "borrow",
        symbol: "HYPE",
        underlying: "HYPE",
        kind: "volatile",
        amount: 800,
        apy: 0.02,
      }),
    ],
    0.25,
    "Hedge is intentionally wide of the 0.25 target so the drift alert is visible.",
  ),
  book(
    "example-venus",
    "venus",
    "BNB Chain",
    "BNB collateral, USDT borrow, partial BNB hedge",
    [
      leg({
        side: "supply",
        symbol: "BNB",
        underlying: "BNB",
        kind: "volatile",
        amount: 40,
        apy: 0.03,
        liquidationThreshold: 0.62,
      }),
      leg({
        side: "borrow",
        symbol: "USDT",
        underlying: "USDT",
        kind: "stable",
        amount: 14_000,
        apy: 0.07,
      }),
      leg({
        side: "borrow",
        symbol: "BNB",
        underlying: "BNB",
        kind: "volatile",
        amount: 8,
        apy: 0.04,
      }),
    ],
    0.2,
  ),
  book(
    "example-rhea",
    "rhea",
    "NEAR",
    "NEAR collateral, USDC borrow, partial NEAR hedge",
    [
      leg({
        side: "supply",
        symbol: "NEAR",
        underlying: "NEAR",
        kind: "volatile",
        amount: 5_000,
        apy: 0.08,
        liquidationThreshold: 0.8,
      }),
      leg({
        side: "borrow",
        symbol: "USDC",
        underlying: "USDC",
        kind: "stable",
        amount: 4_000,
        apy: 0.1,
      }),
      leg({
        side: "borrow",
        symbol: "NEAR",
        underlying: "NEAR",
        kind: "volatile",
        amount: 1_000,
        apy: 0.05,
      }),
    ],
    0.2,
    "Rhea rates on a live book are the protocol APR used as the annual rate.",
  ),
  book(
    "example-alpend",
    "alpend",
    "Canton",
    "CBTC collateral, USDC borrow, partial CBTC hedge",
    [
      leg({
        side: "supply",
        symbol: "CBTC",
        underlying: "BTC",
        kind: "btc",
        amount: 0.8,
        apy: 0.01,
        liquidationThreshold: 0.73,
      }),
      leg({
        side: "borrow",
        symbol: "USDC",
        underlying: "USDC",
        kind: "stable",
        amount: 42_000,
        apy: 0.05,
      }),
      leg({
        side: "borrow",
        symbol: "CBTC",
        underlying: "BTC",
        kind: "btc",
        amount: 0.16,
        apy: 0.005,
      }),
    ],
    0.2,
    "Alpend has no public read API. This row shows the manual-entry shape.",
  ),
];

export const EXAMPLE_SPOT: SpotHolding[] = [
  {
    id: "example-spot-btc",
    wallet: "example-book",
    chain: "Wallet",
    symbol: "BTC",
    underlying: "BTC",
    kind: "btc",
    amount: 0.25,
    usd: 25_000,
    priceUsd: 100_000,
    source: "example",
  },
  {
    id: "example-spot-eth",
    wallet: "example-book",
    chain: "Wallet",
    symbol: "ETH",
    underlying: "ETH",
    kind: "volatile",
    amount: 2,
    usd: 6_000,
    priceUsd: 3_000,
    source: "example",
  },
];
