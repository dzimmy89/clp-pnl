import { describe, expect, it } from "vitest";
import type { Position } from "../types";
import { computePnl, summarizeFlows } from "./pnl";
import type { Flow } from "./types";

const flow = (over: Partial<Flow>): Flow => ({
  kind: "deposit",
  txHash: "0x01",
  blockNumber: "1",
  timestamp: 1_700_000_000,
  amount0: 0,
  amount1: 0,
  price0Usd: 1,
  price1Usd: 2000,
  valueUsd: 0,
  gasNative: 0.001,
  gasUsd: 2,
  ...over,
});

const live = (over: Partial<Position>): Position =>
  ({
    token0: { priceUsd: 1 },
    token1: { priceUsd: 4000 },
    valueUsd: 0,
    feesUsd: 0,
    ...over,
  }) as Position;

describe("summarizeFlows", () => {
  it("totals deposits, withdrawals, collects and counts gas once per tx", () => {
    const h = summarizeFlows("x", [
      flow({ kind: "deposit", amount0: 1000, amount1: 0.5, valueUsd: 2000, txHash: "0xa" }),
      flow({ kind: "withdraw", amount0: 200, amount1: 0.1, valueUsd: 400, txHash: "0xb" }),
      flow({ kind: "collect", amount0: 10, amount1: 0.005, valueUsd: 20, txHash: "0xb" }),
    ]);
    expect(h.deposited0).toBe(1000);
    expect(h.withdrawn1).toBeCloseTo(0.1);
    expect(h.feesCollected0).toBe(10);
    expect(h.costBasisUsd).toBe(2000);
    expect(h.gasUsd).toBe(4); // two distinct txs
  });
});

describe("computePnl", () => {
  it("IL is zero when price is unchanged and the position holds the same tokens", () => {
    const h = summarizeFlows("x", [flow({ amount0: 2000, amount1: 1, valueUsd: 4000 })]);
    const p = computePnl(h, live({ token0: { priceUsd: 1 }, token1: { priceUsd: 2000 }, valueUsd: 4000, feesUsd: 0 } as Partial<Position>));
    expect(p.hodlValueUsd).toBe(4000);
    expect(p.impermanentLossUsd).toBe(0);
    expect(p.netPnlUsd).toBe(-2); // only gas
  });

  it("shows IL when ETH doubles and the LP is left holding more of the stable", () => {
    // Deposited 2000 USDC + 1 ETH at $2000. ETH now $4000: HODL = 2000 + 4000 = 6000.
    // A full-range-ish position would hold ~ sqrt(2) * 2000 * 2 = 5657 -> IL ~ -343.
    const h = summarizeFlows("x", [flow({ amount0: 2000, amount1: 1, valueUsd: 4000 })]);
    const p = computePnl(h, live({ valueUsd: 5657, feesUsd: 100 }));
    expect(p.hodlValueUsd).toBe(6000);
    expect(p.impermanentLossUsd).toBeCloseTo(-343);
    expect(p.impermanentLossPct).toBeCloseTo(-5.72, 1);
    expect(p.netPnlUsd).toBeCloseTo(5657 + 100 - 4000 - 2);
    expect(p.hodlPnlUsd).toBe(2000);
    // vsHodl = fees + IL - gas
    expect(p.vsHodlUsd).toBeCloseTo(100 - 343 - 2);
  });

  it("returns nulls rather than guesses when a price is missing", () => {
    const h = summarizeFlows("x", [flow({ amount0: 1, amount1: 1, valueUsd: null, price0Usd: null })]);
    const p = computePnl(h, live({ valueUsd: 10, feesUsd: 0 }));
    expect(p.netPnlUsd).toBeNull();
    expect(p.hodlValueUsd).toBe(4001);
  });
});
