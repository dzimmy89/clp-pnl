import { describe, expect, it } from "vitest";
import { estimateHealthFactor } from "@/lib/metrics";
import { runScenario, shockLegs } from "@/lib/scenario";
import type { Leg, Position } from "@/lib/types";

function position(legs: Leg[]): Position {
  return {
    id: "p",
    protocol: "aave",
    chain: "Ethereum",
    wallet: "0xabc",
    label: "test",
    source: "manual",
    legs,
    targetHedgeRatio: 0.2,
  };
}

const legs: Leg[] = [
  {
    id: "s-btc",
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
  },
  {
    id: "b-btc",
    side: "borrow",
    symbol: "WBTC",
    underlying: "BTC",
    kind: "btc",
    amount: 0.2,
    usd: 20_000,
    apy: 0.02,
    priceUsd: 100_000,
  },
  {
    id: "b-usd",
    side: "borrow",
    symbol: "USDC",
    underlying: "USDC",
    kind: "stable",
    amount: 40_000,
    usd: 40_000,
    apy: 0.05,
  },
  {
    id: "s-eth",
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
  },
];

describe("price shocks", () => {
  it("leaves stables unchanged and scales only the shocked asset", () => {
    const shocked = shockLegs(legs, { ETH: -0.2 });
    const eth = shocked.find((leg) => leg.underlying === "ETH");
    const btc = shocked.find((leg) => leg.id === "s-btc");
    const usdc = shocked.find((leg) => leg.underlying === "USDC");
    expect(eth?.usd).toBeCloseTo(24_000, 8);
    expect(eth?.amount).toBe(10);
    expect(btc?.usd).toBe(100_000);
    expect(usdc?.usd).toBe(40_000);
  });

  it("scales a stable only when that stable is in the shock map", () => {
    const shocked = shockLegs(legs, { USDC: -0.01 });
    expect(shocked.find((leg) => leg.underlying === "USDC")?.usd).toBeCloseTo(39_600, 6);
  });

  it("recomputes equity, pnl, leverage, and health without changing unit hedge", () => {
    const scenario = runScenario([position(legs)], [], 100_000, { BTC: -0.2 });
    const row = scenario.positions[0];
    expect(row.before.equity).toBe(70_000);
    expect(row.after.equity).toBeCloseTo(70_000 - 0.2 * 80_000, 6);
    expect(row.pnl).toBeCloseTo(-16_000, 6);
    expect(scenario.pnl).toBeCloseTo(-16_000, 6);
    expect(row.after.leverage).toBeCloseTo(row.after.supplyUsd / row.after.equity, 8);
    const beforeHedge = row.before.hedges.find((line) => line.underlying === "BTC");
    const afterHedge = row.after.hedges.find((line) => line.underlying === "BTC");
    expect(afterHedge?.ratio).toBeCloseTo(beforeHedge?.ratio ?? -1, 8);
    expect(row.after.notionalHedgeRatio).not.toBeCloseTo(row.before.notionalHedgeRatio ?? -1, 4);
    expect(scenario.hedgeUnitsUnchanged).toBe(true);
    expect(row.after.healthFactorSource).toBe("estimated");
    expect(row.after.healthFactor).not.toBe(row.before.healthFactor);
  });

  it("keeps notional hedge unchanged when both legs of an asset move together", () => {
    const btcOnly = legs.filter((leg) => leg.underlying === "BTC" || leg.underlying === "USDC");
    const scenario = runScenario([position(btcOnly)], [], 100_000, { BTC: -0.2 });
    const row = scenario.positions[0];
    expect(row.after.notionalHedgeRatio).toBeCloseTo(row.before.notionalHedgeRatio ?? 0, 8);
    expect(row.after.btcDelta).toBeCloseTo(row.before.btcDelta, 8);
  });

  it("moves non-BTC delta when the BTC numeraire is shocked", () => {
    const ethOnly: Leg[] = [
      {
        id: "s-eth",
        side: "supply",
        symbol: "ETH",
        underlying: "ETH",
        kind: "volatile",
        amount: 10,
        usd: 30_000,
        apy: 0.02,
        priceUsd: 3_000,
        liquidationThreshold: 0.8,
        liquidationThresholdSource: "protocol",
        isCollateral: true,
      },
    ];
    const scenario = runScenario([position(ethOnly)], [], 100_000, { BTC: -0.2 });
    expect(scenario.positions[0].before.btcDelta).toBeCloseTo(0.3, 8);
    expect(scenario.positions[0].after.btcDelta).toBeCloseTo(0.3 / 0.8, 6);
    expect(scenario.pnl).toBeCloseTo(0, 8);
  });

  it("keeps a shocked health factor on the protocol's scale", () => {
    const live: Position = { ...position(legs), healthFactor: 2.0, healthFactorSource: "protocol" };
    const flat = runScenario([live], [], 100_000, {});
    expect(flat.positions[0].before.healthFactor).toBe(2.0);
    // No move, same number: the estimate is scaled to meet the protocol's figure.
    expect(flat.positions[0].after.healthFactor).toBeCloseTo(2.0, 9);
    expect(flat.after.rows[0].metrics.healthFactor).toBeCloseTo(2.0, 9);
    const down = runScenario([live], [], 100_000, { BTC: -0.5 });
    // The shocked estimate, scaled by the same factor that made the flat estimate meet 2.0.
    const estimate = estimateHealthFactor(shockLegs(legs, { BTC: -0.5 })).value!;
    expect(down.positions[0].after.healthFactor).toBeCloseTo(estimate * flat.positions[0].before.thresholdScale, 9);
    expect(down.positions[0].after.healthFactor).toBeLessThan(2.0);
  });
});
