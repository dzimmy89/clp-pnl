import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@/lib/alerts";
import { setAmountsHidden } from "@/lib/format";
import { positionMetrics } from "@/lib/metrics";
import { healthOnScale, liquidationLine, netWorthMix, positionStory, positionTone, riskRows, spotGroups } from "@/lib/position-view";
import type { Leg, Position, SpotHolding } from "@/lib/types";

setAmountsHidden(false);

function leg(partial: Omit<Leg, "id"> & { id?: string }): Leg {
  return { id: partial.id ?? `${partial.side}-${partial.symbol}`, ...partial };
}

function position(id: string, legs: Leg[], healthFactor?: number): Position {
  return {
    id,
    protocol: "aave",
    chain: "Ethereum",
    wallet: "0xabc",
    label: id,
    source: "manual",
    legs,
    healthFactor: healthFactor ?? null,
    healthFactorSource: healthFactor != null ? "protocol" : "estimated",
  };
}

const btc = (amount: number, side: Leg["side"] = "supply") =>
  leg({ side, symbol: "WBTC", underlying: "BTC", kind: "btc", amount, usd: amount * 100_000, apy: 0.01, priceUsd: 100_000, liquidationThreshold: 0.8, liquidationThresholdSource: "protocol", isCollateral: side === "supply" });
const usdc = (amount: number) => leg({ side: "borrow", symbol: "USDC", underlying: "USDC", kind: "stable", amount, usd: amount, apy: 0.05, priceUsd: 1 });

const levered = (id: string, debt: number) => {
  const p = position(id, [btc(1), usdc(debt)]);
  return { position: p, metrics: positionMetrics(p, 100_000) };
};

describe("health scale", () => {
  it("puts liquidation at the left and 3.0 and above at the right", () => {
    expect(healthOnScale(1)).toBe(0);
    expect(healthOnScale(2)).toBe(0.5);
    expect(healthOnScale(5)).toBe(1);
    expect(healthOnScale(0.7)).toBe(0);
  });
});

describe("liquidation line and story", () => {
  it("leads with the primary asset's price at the joint move", () => {
    const { metrics } = levered("a", 40_000);
    const line = liquidationLine(metrics)!;
    expect(line.side).toBe("below");
    expect(line.asset).toBe("BTC");
    expect(line.priceUsd).toBeCloseTo(100_000);
    // HF = 100k × 0.8 / 40k = 2, so BTC liquidates at half today's price.
    expect(line.liquidationUsd).toBeCloseTo(50_000, 0);
    expect(line.distance).toBeCloseTo(0.5, 3);
    const story = positionStory(metrics);
    expect(story.holds).toContain("$60,000 of your own money");
    expect(story.risk).toBe("Liquidated if crypto prices fall 50% together (BTC at $50,000).");
  });

  it("says when nothing is borrowed or the debt is the same asset", () => {
    const supplyOnly = positionMetrics(position("s", [btc(1)]), 100_000);
    expect(liquidationLine(supplyOnly)).toBeNull();
    expect(positionStory(supplyOnly).risk).toBe("No debt, so it cannot be liquidated.");
    expect(positionTone(supplyOnly, DEFAULT_THRESHOLDS)).toBe("none");

    const sameAsset = positionMetrics(position("h", [btc(1), btc(0.3, "borrow")]), 100_000);
    expect(sameAsset.liquidationSide).toBe("never");
    expect(positionStory(sameAsset).risk).toMatch(/^No crypto price move liquidates it/);
  });

  it("marks a healthy-looking book at risk once crypto sits inside the alert distance", () => {
    const { metrics } = levered("near", 72_000);
    // HF 1.11 is already under the critical line; a book at HF 1.6 just inside 15% would read "risk".
    expect(positionTone(metrics, DEFAULT_THRESHOLDS)).toBe("critical");
    const close = { ...levered("close", 40_000).metrics, healthFactor: 2.4, liquidationDistance: 0.1 };
    expect(positionTone(close, DEFAULT_THRESHOLDS)).toBe("risk");
  });
});

describe("risk rows", () => {
  it("lists only books with debt, worst first", () => {
    const rows = [levered("safe", 20_000), levered("tight", 70_000), { position: position("none", [btc(1)]), metrics: positionMetrics(position("none", [btc(1)]), 100_000) }];
    expect(riskRows(rows, DEFAULT_THRESHOLDS).map((row) => row.row.position.id)).toEqual(["tight", "safe"]);
  });
});

describe("spot groups", () => {
  const holding = (id: string, symbol: string, underlying: string, chain: string, amount: number, price: number, extra: Partial<SpotHolding> = {}): SpotHolding => ({
    id,
    wallet: "w",
    chain,
    symbol,
    underlying,
    kind: "volatile",
    amount,
    usd: amount * price,
    priceUsd: price,
    source: "live",
    ...extra,
  });

  it("merges one asset across chains and keeps unpriced tokens apart", () => {
    const groups = spotGroups([
      holding("1", "ETH", "ETH", "Ethereum", 1, 3000),
      holding("2", "WETH", "ETH", "Arbitrum", 2, 3000),
      holding("3", "SPAM", "SPAM", "Base", 1000, 0, { unpriced: true }),
      holding("4", "SPAM", "SPAM", "Polygon", 5, 0, { unpriced: true }),
      holding("5", "SOL", "SOL", "Solana", 10, 150),
    ]);
    expect(groups.map((group) => group.underlying)).toEqual(["ETH", "SOL", "SPAM", "SPAM"]);
    expect(groups[0]).toMatchObject({ amount: 3, usd: 9000, priceUsd: 3000, symbols: ["ETH", "WETH"], chains: ["Ethereum", "Arbitrum"], unpriced: false });
    expect(groups[0].lines.map((line) => line.id)).toEqual(["2", "1"]);
    expect(groups[2].unpriced).toBe(true);
  });
});

describe("net worth mix", () => {
  it("shares out the positive parts and draws net app debt as nothing", () => {
    const mix = netWorthMix({ lendingUsd: 60, appsUsd: -10, spotUsd: 40 });
    expect(mix.map((part) => part.share)).toEqual([0.6, 0, 0.4]);
    expect(mix[1].usd).toBe(-10);
  });
});
