import { describe, expect, it } from "vitest";
import { appendPoint, changeOver, MIN_GAP_MS, pointsInRange } from "@/lib/history";
import { portfolioMetrics } from "@/lib/metrics";
import { assetSlices, bookTotals, borrowPowerUsed, healthTone, legRows, lowestHealth } from "@/lib/overview";
import type { Leg, Position, SpotHolding } from "@/lib/types";

function leg(side: Leg["side"], symbol: string, usd: number, apy: number, extra: Partial<Leg> = {}): Leg {
  const underlying = symbol === "WBTC" ? "BTC" : symbol;
  const kind = symbol === "USDC" ? "stable" : symbol === "WBTC" ? "btc" : "volatile";
  return { id: `${side}-${symbol}`, side, symbol, underlying, kind, amount: usd / 100, usd, apy, ...extra };
}

function position(id: string, legs: Leg[], healthFactor: number | null): Position {
  return { id, protocol: "aave", chain: "Ethereum", wallet: "0xabc", label: id, source: "live", legs, healthFactor, healthFactorSource: "protocol" };
}

const rows = portfolioMetrics(
  [
    position("a", [leg("supply", "WBTC", 10_000, 0.01, { liquidationThreshold: 0.8 }), leg("borrow", "USDC", 4_000, 0.06)], 2.0),
    position("b", [leg("supply", "ETH", 5_000, 0.03), leg("borrow", "ETH", 1_000, 0.02)], 1.4),
  ],
  [],
  100_000,
).rows;

const spot = [{ id: "s", wallet: "0xabc", chain: "Ethereum", symbol: "ETH", underlying: "ETH", kind: "volatile", amount: 1, usd: 2_000, priceUsd: 2_000, source: "live" }] as SpotHolding[];

describe("book totals", () => {
  it("adds supplies, subtracts borrows, adds spot", () => {
    const totals = bookTotals(rows, spot);
    expect(totals.suppliedUsd).toBe(15_000);
    expect(totals.borrowedUsd).toBe(5_000);
    expect(totals.netWorthUsd).toBe(12_000);
    expect(totals.supplyApy).toBeCloseTo((10_000 * 0.01 + 5_000 * 0.03) / 15_000);
    expect(totals.yearlyCostUsd).toBeCloseTo(4_000 * 0.06 + 1_000 * 0.02);
  });

  it("has no APY on an empty side", () => {
    expect(bookTotals([], []).supplyApy).toBeNull();
  });
});

describe("leg rows and asset slices", () => {
  it("lists supplies largest first", () => {
    expect(legRows(rows, "supply").map((r) => r.symbol)).toEqual(["WBTC", "ETH"]);
  });

  it("nets each asset across positions and spot", () => {
    const eth = assetSlices(rows, spot).find((s) => s.underlying === "ETH");
    expect(eth).toMatchObject({ suppliedUsd: 5_000, borrowedUsd: 1_000, spotUsd: 2_000, netUsd: 6_000 });
  });
});

describe("risk", () => {
  it("reports the weakest health factor", () => {
    expect(lowestHealth(rows)).toEqual({ value: 1.4, label: "b" });
  });

  it("limits each book on its protocol's scale: debt times the reported health factor", () => {
    const power = borrowPowerUsed(rows);
    // Book a: 10 000 × 0.8 agrees with health 2.0. Book b: the 75% assumption would say 3 750,
    // but the protocol reports health 1.4 on 1 000 of debt, so its line is at 1 400.
    expect(power?.limitUsd).toBeCloseTo(10_000 * 0.8 + 1_000 * 1.4);
    expect(power?.used).toBeCloseTo(5_000 / 9_400);
  });

  it("grades health against the alert thresholds", () => {
    const t = { healthWarning: 1.5, healthCritical: 1.2 };
    expect([2.5, 1.8, 1.3, 1.1, null].map((v) => healthTone(v, t))).toEqual(["healthy", "monitor", "risk", "critical", "none"]);
  });
});

describe("net worth history", () => {
  it("replaces a reading taken within the gap and appends a later one", () => {
    let points = appendPoint([], { t: 0, usd: 1 });
    points = appendPoint(points, { t: MIN_GAP_MS - 1, usd: 2 });
    expect(points).toEqual([{ t: MIN_GAP_MS - 1, usd: 2 }]);
    points = appendPoint(points, { t: MIN_GAP_MS * 3, usd: 3 });
    expect(points).toHaveLength(2);
  });

  it("filters to a range and measures the change", () => {
    const day = 86_400_000;
    const points = [{ t: 0, usd: 100 }, { t: 20 * day, usd: 110 }, { t: 29 * day, usd: 121 }];
    expect(pointsInRange(points, "7d", 30 * day)).toHaveLength(1);
    expect(changeOver(pointsInRange(points, "30d", 30 * day))).toBeCloseTo(0.21);
  });
});
