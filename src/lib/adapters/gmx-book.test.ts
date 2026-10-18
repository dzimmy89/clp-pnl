import { describe, expect, it } from "vitest";
import { gmxPositionBook, type GmxMarket, type GmxPosition } from "@/lib/adapters/gmx-book";
import { positionMetrics } from "@/lib/metrics";
import type { Position } from "@/lib/types";

const market: GmxMarket = {
  market: "0xmarket",
  indexToken: "0xbtc",
  indexSymbol: "BTC",
  indexDecimals: 8,
  minCollateralFactor: 0.01,
};
const usdc = { symbol: "USDC", decimals: 6 };

function position(overrides: Partial<GmxPosition>): GmxPosition {
  return { key: "k", market: market.market, collateralToken: "0xusdc", isLong: false, sizeUsd: 100_000, sizeInTokens: 1, collateralAmount: 20_000, ...overrides };
}

function asPosition(legs: Position["legs"], healthFactor: number | null): Position {
  return { id: "p", protocol: "gmx", app: "GMX", category: "other", chain: "Arbitrum", wallet: "0x", label: "t", source: "live", legs, healthFactor, healthFactorSource: "protocol", fetchedAt: "" };
}

describe("gmxPositionBook", () => {
  it("maps a short to a borrowed index leg, a supplied entry leg and the collateral", () => {
    const book = gmxPositionBook({ position: position({}), market, collateral: usdc, indexPrice: 90_000, collateralPrice: 1 });
    expect(book.entryPrice).toBe(100_000);
    expect(book.leverage).toBe(5);
    expect(book.pnlUsd).toBe(10_000);
    const index = book.legs.find((leg) => leg.symbol === "BTC")!;
    expect(index.side).toBe("borrow");
    expect(index.usd).toBe(90_000);
    const entry = book.legs.find((leg) => leg.symbol === "USD")!;
    expect(entry.side).toBe("supply");
    expect(entry.usd).toBe(100_000);
    // (C + E) / (P·S·(1 + f)) = 120000 / (90000 · 1.01)
    expect(book.healthFactor).toBeCloseTo(120_000 / 90_900, 6);
  });

  it("puts a short's liquidation price where GMX liquidates it, after the joint solve", () => {
    const book = gmxPositionBook({ position: position({}), market, collateral: usdc, indexPrice: 90_000, collateralPrice: 1 });
    const metrics = positionMetrics(asPosition(book.legs, book.healthFactor), 100_000);
    // Short: liquidates when C + E = P·S·(1 + f) → P = 120000 / 1.01
    expect(metrics.liquidationSide).toBe("above");
    expect(metrics.liquidationPriceUsd).toBeCloseTo(120_000 / 1.01, 2);
    expect(metrics.healthFactor).toBeCloseTo(book.healthFactor!, 6);
  });

  it("puts a long's liquidation price where GMX liquidates it", () => {
    const long = position({ isLong: true, sizeUsd: 100_000, sizeInTokens: 1, collateralAmount: 20_000 });
    const book = gmxPositionBook({ position: long, market, collateral: usdc, indexPrice: 110_000, collateralPrice: 1 });
    expect(book.pnlUsd).toBe(10_000);
    // (P·S·(1 − f) + C) / E
    expect(book.healthFactor).toBeCloseTo((110_000 * 0.99 + 20_000) / 100_000, 6);
    const metrics = positionMetrics(asPosition(book.legs, book.healthFactor), 100_000);
    // Long: liquidates when P·S·(1 − f) + C = E → P = 80000 / 0.99
    expect(metrics.liquidationSide).toBe("below");
    expect(metrics.liquidationPriceUsd).toBeCloseTo(80_000 / 0.99, 2);
  });

  it("treats crypto collateral as part of the same move", () => {
    const short = position({ collateralToken: "0xwbtc", collateralAmount: 0.2 });
    const book = gmxPositionBook({ position: short, market, collateral: { symbol: "WBTC", decimals: 8 }, indexPrice: 100_000, collateralPrice: 100_000 });
    const metrics = positionMetrics(asPosition(book.legs, book.healthFactor), 100_000);
    // C(P) + E = P·S·(1 + f) with C = 0.2·P → 100000 = P·(1.01 − 0.2)
    expect(metrics.liquidationSide).toBe("above");
    expect(metrics.liquidationPriceUsd).toBeCloseTo(100_000 / 0.81, 2);
  });
});
