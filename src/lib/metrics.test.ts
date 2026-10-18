import { describe, expect, it } from "vitest";
import { portfolioMetrics, positionMetrics } from "@/lib/metrics";
import type { Leg, Position } from "@/lib/types";

function leg(partial: Omit<Leg, "id"> & { id?: string }): Leg {
  return { id: partial.id ?? `${partial.side}-${partial.symbol}`, ...partial };
}

function position(legs: Leg[], healthFactor?: number): Position {
  return {
    id: "p",
    protocol: "aave",
    chain: "Ethereum",
    wallet: "0xabc",
    label: "test",
    source: "manual",
    legs,
    healthFactor: healthFactor ?? null,
    healthFactorSource: healthFactor != null ? "protocol" : "estimated",
    targetHedgeRatio: 0.2,
  };
}

const btcSupply = leg({
  side: "supply",
  symbol: "WBTC",
  underlying: "BTC",
  kind: "btc",
  amount: 1,
  usd: 100_000,
  apy: 0.01,
  priceUsd: 100_000,
  liquidationThreshold: 0.8,
  liquidationThresholdSource: "protocol",
  isCollateral: true,
});

describe("position metrics", () => {
  it("marks equity at or below zero as underwater and does not divide", () => {
    const metrics = positionMetrics(
      position([
        { ...btcSupply, usd: 10, amount: 0.0001 },
        leg({
          side: "borrow",
          symbol: "USDC",
          underlying: "USDC",
          kind: "stable",
          amount: 20,
          usd: 20,
          apy: 0.05,
        }),
      ]),
      100_000,
    );
    expect(metrics.equity).toBeLessThanOrEqual(0);
    expect(metrics.underwater).toBe(true);
    expect(metrics.leverage).toBeNull();
    expect(metrics.netApy).toBeNull();
  });

  it("computes leverage, net APY, hedge, and 1:1 BTC delta", () => {
    const metrics = positionMetrics(
      position([
        btcSupply,
        leg({
          side: "borrow",
          symbol: "WBTC",
          underlying: "BTC",
          kind: "btc",
          amount: 0.2,
          usd: 20_000,
          apy: 0.02,
        }),
        leg({
          side: "borrow",
          symbol: "USDC",
          underlying: "USDC",
          kind: "stable",
          amount: 40_000,
          usd: 40_000,
          apy: 0.05,
        }),
        leg({
          side: "supply",
          symbol: "ETH",
          underlying: "ETH",
          kind: "volatile",
          amount: 10,
          usd: 30_000,
          apy: 0.03,
          priceUsd: 3_000,
          liquidationThreshold: 0.8,
          liquidationThresholdSource: "protocol",
          isCollateral: true,
        }),
      ]),
      100_000,
    );
    expect(metrics.equity).toBe(70_000);
    expect(metrics.leverage).toBeCloseTo(130_000 / 70_000, 8);
    const income = 100_000 * 0.01 + 30_000 * 0.03 - 20_000 * 0.02 - 40_000 * 0.05;
    expect(metrics.netIncomeUsd).toBeCloseTo(income, 8);
    expect(metrics.netApy).toBeCloseTo(income / 70_000, 8);
    const btcHedge = metrics.hedges.find((line) => line.underlying === "BTC");
    expect(btcHedge?.ratio).toBeCloseTo(0.2, 8);
    expect(metrics.notionalHedgeRatio).toBeCloseTo(20_000 / 130_000, 8);
    expect(metrics.btcDelta).toBeCloseTo(0.8 + (10 * 3_000) / 100_000, 8);
  });

  it("excludes stables from BTC delta and from hedge notionals", () => {
    const metrics = positionMetrics(
      position([
        leg({
          side: "supply",
          symbol: "USDC",
          underlying: "USDC",
          kind: "stable",
          amount: 50_000,
          usd: 50_000,
          apy: 0.04,
          isCollateral: true,
          liquidationThreshold: 0.85,
          liquidationThresholdSource: "protocol",
        }),
        leg({
          side: "borrow",
          symbol: "USDT",
          underlying: "USDT",
          kind: "stable",
          amount: 10_000,
          usd: 10_000,
          apy: 0.05,
        }),
      ]),
      100_000,
    );
    expect(metrics.btcDelta).toBe(0);
    expect(metrics.notionalHedgeRatio).toBeNull();
    expect(metrics.hedges).toHaveLength(0);
  });

  it("counts cbBTC as BTC units, not USD over the BTC price", () => {
    const metrics = positionMetrics(
      position([
        leg({
          side: "supply",
          symbol: "cbBTC",
          underlying: "BTC",
          kind: "btc",
          amount: 2,
          usd: 210_000,
          apy: 0,
          priceUsd: 105_000,
          liquidationThreshold: 0.78,
          liquidationThresholdSource: "protocol",
          isCollateral: true,
        }),
      ]),
      100_000,
    );
    expect(metrics.btcDelta).toBeCloseTo(2, 8);
  });

  it("prefers a protocol health factor and still estimates liquidation price", () => {
    const metrics = positionMetrics(position([btcSupply], 2.4), 100_000);
    expect(metrics.healthFactor).toBeNull();
    const withDebt = positionMetrics(
      position(
        [
          btcSupply,
          leg({
            side: "borrow",
            symbol: "USDC",
            underlying: "USDC",
            kind: "stable",
            amount: 50_000,
            usd: 50_000,
            apy: 0.05,
          }),
        ],
        1.7,
      ),
      100_000,
    );
    expect(withDebt.healthFactor).toBe(1.7);
    expect(withDebt.healthFactorSource).toBe("protocol");
    // The estimate (0.8 × 100k / 50k = 1.6) is put on the protocol's scale, so with one
    // collateral asset the liquidation price is simply spot / health factor.
    expect(withDebt.thresholdScale).toBeCloseTo(1.7 / 1.6, 9);
    expect(withDebt.liquidationPriceUsd).toBeCloseTo(100_000 / 1.7, 6);
    expect(withDebt.liquidationSide).toBe("below");
  });

  it("nets a same-asset borrow out of the liquidation price instead of counting it as fixed debt", () => {
    const usdc = leg({ side: "borrow", symbol: "USDC", underlying: "USDC", kind: "stable", amount: 20_000, usd: 20_000, apy: 0.05 });
    const btcBorrow = leg({ side: "borrow", symbol: "WBTC", underlying: "BTC", kind: "btc", amount: 0.5, usd: 50_000, apy: 0.02, priceUsd: 100_000 });
    const metrics = positionMetrics(position([btcSupply, btcBorrow, usdc]), 100_000);
    // P·1·0.8 = P·0.5 + 20 000  →  P = 20 000 / 0.3
    expect(metrics.liquidationPriceUsd).toBeCloseTo(20_000 / 0.3, 6);
    expect(metrics.liquidationSide).toBe("below");
    expect(metrics.liquidationDistance).toBeCloseTo(1 - 20_000 / 0.3 / 100_000, 9);
    // Treating the 0.5 BTC borrow as fixed USD debt would put the line far higher.
    expect(metrics.liquidationPriceUsd).toBeLessThan(70_000 / 0.8);
  });

  it("says a book with the same asset on both sides and nothing else owed is never liquidated by price", () => {
    const btcBorrow = leg({ side: "borrow", symbol: "WBTC", underlying: "BTC", kind: "btc", amount: 0.5, usd: 50_000, apy: 0.02, priceUsd: 100_000 });
    const metrics = positionMetrics(position([btcSupply, btcBorrow]), 100_000);
    expect(metrics.liquidationPriceUsd).toBeNull();
    expect(metrics.liquidationSide).toBe("never");
    expect(metrics.healthFactor).toBeCloseTo(1.6, 9);
    // Stable collateral on top only widens the gap: still never.
    const usdc = leg({ side: "supply", symbol: "USDC", underlying: "USDC", kind: "stable", amount: 10_000, usd: 10_000, apy: 0.04, liquidationThreshold: 0.8, isCollateral: true });
    expect(positionMetrics(position([btcSupply, btcBorrow, usdc]), 100_000).liquidationSide).toBe("never");
  });

  it("puts a short's liquidation price above spot", () => {
    const usdc = leg({ side: "supply", symbol: "USDC", underlying: "USDC", kind: "stable", amount: 100_000, usd: 100_000, apy: 0.04, liquidationThreshold: 0.8, isCollateral: true });
    const btcBorrow = leg({ side: "borrow", symbol: "WBTC", underlying: "BTC", kind: "btc", amount: 1, usd: 50_000, apy: 0.02, priceUsd: 50_000 });
    const metrics = positionMetrics(position([usdc, btcBorrow]), 50_000);
    expect(metrics.primaryUnderlying).toBe("BTC");
    expect(metrics.liquidationPriceUsd).toBeCloseTo(80_000, 6);
    expect(metrics.liquidationSide).toBe("above");
    expect(metrics.liquidationDistance).toBeCloseTo(0.6, 9);
  });

  it("uses the assumed threshold for the asset class when none is published", () => {
    const unrated = leg({ ...btcSupply, liquidationThreshold: undefined, liquidationThresholdSource: undefined });
    const usdc = leg({ side: "borrow", symbol: "USDC", underlying: "USDC", kind: "stable", amount: 39_000, usd: 39_000, apy: 0.05 });
    const metrics = positionMetrics(position([unrated, usdc]), 100_000);
    expect(metrics.healthFactor).toBeCloseTo(0.78 * 100_000 / 39_000, 9);
    expect(metrics.liquidationPriceUsd).toBeCloseTo(39_000 / 0.78, 6);
    expect(metrics.assumedThreshold).toBe(true);
  });

  it("estimates health factor as collateral USD times threshold over debt", () => {
    const metrics = positionMetrics(
      position([
        btcSupply,
        leg({
          side: "borrow",
          symbol: "USDC",
          underlying: "USDC",
          kind: "stable",
          amount: 50_000,
          usd: 50_000,
          apy: 0.05,
        }),
      ]),
      100_000,
    );
    expect(metrics.healthFactor).toBeCloseTo((100_000 * 0.8) / 50_000, 8);
    expect(metrics.healthFactorSource).toBe("estimated");
  });
});

describe("portfolio metrics", () => {
  it("equity-weights net APY and leverage and drops underwater books", () => {
    const healthyA = position([
      { ...btcSupply, usd: 200, amount: 0.002, apy: 0.1 },
      leg({
        side: "borrow",
        symbol: "USDC",
        underlying: "USDC",
        kind: "stable",
        amount: 100,
        usd: 100,
        apy: 0.1,
      }),
    ]);
    healthyA.id = "a";
    const healthyB: Position = {
      ...position([
        {
          ...btcSupply,
          usd: 300,
          amount: 0.003,
          apy: 0,
        },
      ]),
      id: "b",
    };
    const sunk: Position = {
      ...position([
        { ...btcSupply, usd: 50, amount: 0.0005 },
        leg({
          side: "borrow",
          symbol: "USDC",
          underlying: "USDC",
          kind: "stable",
          amount: 80,
          usd: 80,
          apy: 0.05,
        }),
      ]),
      id: "sunk",
    };
    const book = portfolioMetrics([healthyA, healthyB, sunk], [], 100_000);
    expect(book.underwater).toHaveLength(1);
    expect(book.equity).toBe(400);
    expect(book.netIncomeUsd).toBeCloseTo(200 * 0.1 - 100 * 0.1, 8);
    expect(book.blendedApy).toBeCloseTo(10 / 400, 8);
    expect(book.blendedLeverage).toBeCloseTo(500 / 400, 8);
    expect(book.totalBtcDelta).toBeCloseTo(book.lendingBtcDelta, 8);
  });

  it("adds spot BTC units and prices other spot through the BTC numeraire", () => {
    const book = portfolioMetrics(
      [],
      [
        {
          id: "s1",
          wallet: "w",
          chain: "Wallet",
          symbol: "BTC",
          underlying: "BTC",
          kind: "btc",
          amount: 0.25,
          usd: 25_000,
          priceUsd: 100_000,
          source: "manual",
        },
        {
          id: "s2",
          wallet: "w",
          chain: "Wallet",
          symbol: "ETH",
          underlying: "ETH",
          kind: "volatile",
          amount: 2,
          usd: 6_000,
          priceUsd: 3_000,
          source: "manual",
        },
        {
          id: "s3",
          wallet: "w",
          chain: "Wallet",
          symbol: "USDC",
          underlying: "USDC",
          kind: "stable",
          amount: 1000,
          usd: 1000,
          priceUsd: 1,
          source: "manual",
        },
      ],
      100_000,
    );
    expect(book.spotBtcDelta).toBeCloseTo(0.25 + 0.06, 8);
    expect(book.totalBtcDelta).toBeCloseTo(book.spotBtcDelta, 8);
    expect(book.blendedApy).toBeNull();
    expect(book.blendedLeverage).toBeNull();
  });
});

describe("joint liquidation move", () => {
  const eth = (side: "supply" | "borrow", amount: number) =>
    leg({
      side,
      symbol: "WETH",
      underlying: "ETH",
      kind: "volatile",
      amount,
      usd: amount * 2_500,
      apy: 0.02,
      priceUsd: 2_500,
      ...(side === "supply" ? { liquidationThreshold: 0.83, liquidationThresholdSource: "protocol" as const, isCollateral: true } : {}),
    });
  const btc = (side: "supply" | "borrow", amount: number) =>
    leg({
      side,
      symbol: "WBTC",
      underlying: "BTC",
      kind: "btc",
      amount,
      usd: amount * 80_000,
      apy: 0.01,
      priceUsd: 80_000,
      ...(side === "supply" ? { liquidationThreshold: 0.78, liquidationThresholdSource: "protocol" as const, isCollateral: true } : {}),
    });
  const usdc = (amount: number) => leg({ side: "borrow", symbol: "USDC", underlying: "USDC", kind: "stable", amount, usd: amount, apy: 0.05 });

  it("liquidates a two-asset loop when both assets fall together, long before either alone", () => {
    // Supply 7 ETH + 0.27 BTC, borrow 1.9 ETH + 0.06 BTC + 11 540 USDC: a book like a real Aave loop.
    const metrics = positionMetrics(position([eth("supply", 7), btc("supply", 0.27), eth("borrow", 1.9), btc("borrow", 0.06), usdc(11_540)]), 80_000);
    const cryptoWeighted = 7 * 2_500 * 0.83 + 0.27 * 80_000 * 0.78;
    const cryptoDebt = 1.9 * 2_500 + 0.06 * 80_000;
    const k = 11_540 / (cryptoWeighted - cryptoDebt);
    expect(metrics.primaryUnderlying).toBe("BTC");
    expect(metrics.liquidationSide).toBe("below");
    expect(metrics.liquidationDistance).toBeCloseTo(1 - k, 9);
    expect(metrics.liquidationPriceUsd).toBeCloseTo(80_000 * k, 6);
    expect(metrics.liquidationPrices).toEqual([
      { underlying: "BTC", priceUsd: 80_000, liquidationUsd: expect.closeTo(80_000 * k, 6) },
      { underlying: "ETH", priceUsd: 2_500, liquidationUsd: expect.closeTo(2_500 * k, 6) },
    ]);
    // BTC alone, with ETH held at today's price, has to fall much further.
    const solo = (11_540 + 1.9 * 2_500 - 7 * 2_500 * 0.83) / (0.27 * 0.78 - 0.06);
    expect(metrics.soloLiquidationPriceUsd).toBeCloseTo(solo, 6);
    expect(metrics.soloLiquidationDistance).toBeGreaterThan(metrics.liquidationDistance ?? 0);
  });

  it("agrees with the single-asset line when the book holds one crypto asset", () => {
    const metrics = positionMetrics(position([btc("supply", 1), btc("borrow", 0.5), usdc(20_000)]), 80_000);
    expect(metrics.liquidationPriceUsd).toBeCloseTo(metrics.soloLiquidationPriceUsd ?? 0, 6);
    expect(metrics.liquidationDistance).toBeCloseTo(metrics.soloLiquidationDistance ?? 0, 9);
    expect(metrics.liquidationPrices).toHaveLength(1);
  });

  it("keeps the single-asset line as the depeg case for a staked token against its base asset", () => {
    const jupsol = leg({ side: "supply", symbol: "JupSOL", underlying: "JUPSOL", kind: "volatile", amount: 65, usd: 65 * 130, apy: 0, priceUsd: 130, liquidationThreshold: 0.73, liquidationThresholdSource: "protocol", isCollateral: true });
    const sol = leg({ side: "borrow", symbol: "SOL", underlying: "SOL", kind: "volatile", amount: 32, usd: 32 * 107, apy: 0.06, priceUsd: 107 });
    const metrics = positionMetrics(position([jupsol, sol, usdc(400)]), 80_000);
    // Together: only the 400 USDC is fixed, so SOL and JupSOL can fall a long way.
    const k = 400 / (65 * 130 * 0.73 - 32 * 107);
    expect(metrics.liquidationDistance).toBeCloseTo(1 - k, 9);
    expect(metrics.liquidationPrices.map((a) => a.underlying)).toEqual(["JUPSOL", "SOL"]);
    // Alone: JupSOL losing value against a fixed SOL debt is the nearer line.
    expect(metrics.soloLiquidationPriceUsd).toBeCloseTo((32 * 107 + 400) / (65 * 0.73), 6);
    expect(metrics.soloLiquidationDistance).toBeLessThan(metrics.liquidationDistance ?? 0);
  });

  it("puts a net short's joint line above spot and a covered loop at never", () => {
    const stable = leg({ side: "supply", symbol: "USDC", underlying: "USDC", kind: "stable", amount: 100_000, usd: 100_000, apy: 0.04, liquidationThreshold: 0.8, isCollateral: true });
    const short = positionMetrics(position([stable, btc("borrow", 0.5), eth("borrow", 4)]), 80_000);
    // 80 000 = k · (40 000 + 10 000) → k = 1.6
    expect(short.liquidationSide).toBe("above");
    expect(short.liquidationDistance).toBeCloseTo(0.6, 9);
    expect(short.liquidationPriceUsd).toBeCloseTo(80_000 * 1.6, 6);
    const covered = positionMetrics(position([btc("supply", 1), eth("supply", 2), btc("borrow", 0.3), eth("borrow", 1)]), 80_000);
    expect(covered.liquidationSide).toBe("never");
    expect(covered.liquidationPriceUsd).toBeNull();
    expect(covered.liquidationPrices).toEqual([]);
  });
});
