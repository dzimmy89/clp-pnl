import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, evaluateAlerts } from "@/lib/alerts";
import { positionMetrics } from "@/lib/metrics";
import type { Leg, Position, Thresholds } from "@/lib/types";

const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };

function row(legs: Leg[], extras: Partial<Position> = {}) {
  const position: Position = {
    id: "book-1",
    protocol: "aave",
    chain: "Ethereum",
    wallet: "0x1111111111111111111111111111111111111111",
    label: "desk",
    source: "manual",
    targetHedgeRatio: 0.25,
    legs,
    ...extras,
  };
  return { position, metrics: positionMetrics(position, 100_000) };
}

describe("alerts", () => {
  it("states the position, the breach, and one action", () => {
    const supply: Leg = {
      id: "s",
      side: "supply",
      symbol: "WBTC",
      underlying: "BTC",
      kind: "btc",
      amount: 1,
      usd: 100_000,
      apy: 0,
      priceUsd: 100_000,
      liquidationThreshold: 0.8,
      liquidationThresholdSource: "protocol",
      isCollateral: true,
    };
    const alerts = evaluateAlerts(
      [
        row(
        [
          supply,
          {
            id: "b",
            side: "borrow",
            symbol: "USDC",
            underlying: "USDC",
            kind: "stable",
            amount: 70_000,
            usd: 70_000,
            apy: 0.08,
          },
        ],
        { healthFactor: 1.14, healthFactorSource: "protocol" },
        ),
      ],
      thresholds,
    );
    const critical = alerts.find((alert) => alert.id.endsWith("hf-critical"));
    expect(critical?.sentence).toBe(
      "Aave on Ethereum (0x1111…1111) health factor is 1.14, under the 1.20 critical line — add collateral or repay debt.",
    );
    expect(critical?.sentence.endsWith(".")).toBe(true);
  });

  it("warns between 1.2 and 1.5 and flags negative carry, leverage, hedge drift, and liquidation proximity", () => {
    const supply: Leg = {
      id: "s",
      side: "supply",
      symbol: "ETH",
      underlying: "ETH",
      kind: "volatile",
      amount: 10,
      usd: 30_000,
      apy: 0.01,
      priceUsd: 3_000,
      liquidationThreshold: 0.5,
      liquidationThresholdSource: "protocol",
      isCollateral: true,
    };
    const borrowEth: Leg = {
      id: "be",
      side: "borrow",
      symbol: "ETH",
      underlying: "ETH",
      kind: "volatile",
      amount: 4,
      usd: 12_000,
      apy: 0.02,
    };
    const borrowUsd: Leg = {
      id: "bu",
      side: "borrow",
      symbol: "USDC",
      underlying: "USDC",
      kind: "stable",
      amount: 4_000,
      usd: 4_000,
      apy: 0.1,
    };
    const alerts = evaluateAlerts(
      [row([supply, borrowEth, borrowUsd], { healthFactor: 1.35, healthFactorSource: "protocol" })],
      // Health 1.35 on the protocol's scale puts the ETH liquidation line 58% below spot.
      { ...thresholds, maxLeverage: 2, hedgeTolerance: 0.05, liquidationProximity: 0.6 },
    );
    const keys = alerts.map((alert) => alert.id.split(":")[1]);
    expect(keys).toContain("hf-warning");
    expect(keys).toContain("apy");
    expect(keys).toContain("leverage");
    expect(keys).toContain("hedge-notional");
    expect(keys).toContain("liq");
    expect(alerts.find((alert) => alert.id.endsWith("apy"))?.sentence).toContain(
      "consider reducing borrow or exiting",
    );
    expect(alerts.find((alert) => alert.id.endsWith("leverage"))?.sentence).toContain(
      "repay debt or add collateral",
    );
    expect(alerts.find((alert) => alert.id.endsWith("hedge-notional"))?.sentence).toContain(
      "adjust the same-asset borrow toward the target",
    );
    expect(alerts.find((alert) => alert.id.endsWith("liq"))?.sentence).toContain(
      "add collateral or repay",
    );
  });

  it("does not alert a book inside every threshold", () => {
    const alerts = evaluateAlerts(
      [
        row([
        {
          id: "s",
          side: "supply",
          symbol: "WBTC",
          underlying: "BTC",
          kind: "btc",
          amount: 1,
          usd: 100_000,
          apy: 0.05,
          priceUsd: 100_000,
          liquidationThreshold: 0.8,
          liquidationThresholdSource: "protocol",
          isCollateral: true,
        },
        {
          id: "b",
          side: "borrow",
          symbol: "WBTC",
          underlying: "BTC",
          kind: "btc",
          amount: 0.25,
          usd: 25_000,
          apy: 0.01,
        },
        {
          id: "u",
          side: "borrow",
          symbol: "USDC",
          underlying: "USDC",
          kind: "stable",
          amount: 10_000,
          usd: 10_000,
          apy: 0.04,
        },
        ]),
      ],
      thresholds,
    );
    expect(alerts).toHaveLength(0);
  });
});
