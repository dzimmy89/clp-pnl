import { describe, expect, it } from "vitest";
import { applyViewFilter, appGroups, filterOptions, NO_FILTER, validFilter } from "@/lib/view-filter";
import { bookTotals, borrowPowerUsed } from "@/lib/overview";
import { portfolioMetrics } from "@/lib/metrics";
import type { Leg, Position, SpotHolding } from "@/lib/types";

function leg(side: Leg["side"], symbol: string, usd: number, extra: Partial<Leg> = {}): Leg {
  return { id: `${side}-${symbol}`, side, symbol, underlying: symbol, kind: "volatile", amount: usd, usd, apy: 0.05, ...extra };
}

function position(id: string, app: string, chain: string, legs: Leg[], category?: Position["category"]): Position {
  return { id, protocol: "zerion", app, category, chain, wallet: "0xabc", label: id, source: "live", legs };
}

const spot: SpotHolding[] = [
  { id: "s1", wallet: "0xabc", chain: "Sui", symbol: "SUI", underlying: "SUI", kind: "volatile", amount: 10, usd: 30, priceUsd: 3, source: "live" },
  { id: "s2", wallet: "0xabc", chain: "Base", symbol: "ETH", underlying: "ETH", kind: "volatile", amount: 1, usd: 2000, priceUsd: 2000, source: "live" },
];

const positions = [
  position("a", "Suilend", "Sui", [leg("supply", "SUI", 1000), leg("borrow", "USDC", 400)], "lending"),
  position("b", "Lido", "Ethereum", [leg("supply", "ETH", 5000, { isCollateral: false })], "staking"),
  position("c", "Uniswap V3", "Base", [leg("supply", "ETH", 300), leg("supply", "USDC", 300)], "liquidity"),
];

describe("view filter", () => {
  it("narrows by chain across positions and balances", () => {
    const view = applyViewFilter(positions, spot, { ...NO_FILTER, chain: "Base" });
    expect(view.positions.map((p) => p.id)).toEqual(["c"]);
    expect(view.spot.map((s) => s.id)).toEqual(["s2"]);
  });

  it("hides wallet balances when an app or position type is picked, and shows only them for 'wallet'", () => {
    expect(applyViewFilter(positions, spot, { ...NO_FILTER, app: "Lido" }).spot).toEqual([]);
    expect(applyViewFilter(positions, spot, { ...NO_FILTER, type: "staking" }).positions.map((p) => p.id)).toEqual(["b"]);
    const wallet = applyViewFilter(positions, spot, { ...NO_FILTER, type: "wallet" });
    expect(wallet.positions).toEqual([]);
    expect(wallet.spot).toHaveLength(2);
  });

  it("lists choices by value and drops stale picks", () => {
    const options = filterOptions(positions, spot);
    expect(options.apps).toEqual(["Lido", "Suilend", "Uniswap V3"]);
    expect(options.chains[0]).toBe("Ethereum");
    expect(options.types).toEqual(["lending", "staking", "liquidity", "wallet"]);
    expect(validFilter({ chain: "Kaspa", app: "Lido", type: null }, options)).toEqual({ chain: null, app: "Lido", type: null });
  });

  it("groups positions by app", () => {
    const groups = appGroups([...positions, position("d", "Lido", "Arbitrum", [leg("supply", "ETH", 100)], "staking")]);
    expect(groups[0]).toMatchObject({ app: "Lido", chains: ["Ethereum", "Arbitrum"], types: ["staking"], netUsd: 5100 });
    expect(groups.map((g) => g.app)).toEqual(["Lido", "Suilend", "Uniswap V3"]);
  });
});

describe("totals with non-lending positions", () => {
  it("keeps staking and LP out of supplied and borrow power but in net worth", () => {
    const { rows } = portfolioMetrics(positions, spot, 60000);
    const totals = bookTotals(rows, spot);
    expect(totals.suppliedUsd).toBe(1000);
    expect(totals.borrowedUsd).toBe(400);
    expect(totals.appsUsd).toBe(5600);
    expect(totals.netWorthUsd).toBe(1000 - 400 + 5600 + 2030);
    expect(borrowPowerUsed(rows)?.limitUsd).toBeCloseTo(750);
  });

  it("leaves unrated positions out of net APY", () => {
    const unrated = position("z", "Morpho", "Base", [leg("supply", "USDC", 10_000, { apy: 0, apyUnknown: true })], "lending");
    const book = portfolioMetrics([positions[0], unrated], [], 60000);
    expect(book.rows[1].metrics.netApy).toBeNull();
    expect(book.blendedApy).toBeCloseTo((1000 * 0.05 - 400 * 0.05) / 600);
  });
});
