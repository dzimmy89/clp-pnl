import { describe, expect, it } from "vitest";
import {
  Q96,
  getAmountsForLiquidity,
  getFeeGrowthInside,
  getSqrtRatioAtTick,
  getUncollectedFees,
  sqrtPriceToPrice,
  tickToPrice,
} from "./math";

describe("getSqrtRatioAtTick", () => {
  it("matches the Solidity constants at the extremes", () => {
    expect(getSqrtRatioAtTick(-887272)).toBe(4295128739n);
    expect(getSqrtRatioAtTick(887272)).toBe(
      1461446703485210103287273052203988822378723970342n,
    );
  });
  it("is 2^96 at tick 0", () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
  });
  it("grows by sqrt(1.0001) per tick", () => {
    const a = Number(getSqrtRatioAtTick(1000)) / Number(Q96);
    expect(a ** 2).toBeCloseTo(1.0001 ** 1000, 6);
  });
});

describe("getAmountsForLiquidity", () => {
  it("is all token0 below the range and all token1 above", () => {
    const L = 10n ** 18n;
    const below = getAmountsForLiquidity(getSqrtRatioAtTick(-1000), -500, 500, L);
    expect(below.amount1).toBe(0n);
    expect(below.amount0).toBeGreaterThan(0n);
    const above = getAmountsForLiquidity(getSqrtRatioAtTick(1000), -500, 500, L);
    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
  });
  it("splits at the midpoint of a symmetric range", () => {
    const L = 10n ** 18n;
    const { amount0, amount1 } = getAmountsForLiquidity(Q96, -1000, 1000, L);
    // At price 1 with a symmetric range the two sides hold equal value.
    expect(Number(amount0) / Number(amount1)).toBeCloseTo(1, 3);
  });
});

describe("fee growth", () => {
  it("computes inside growth when the tick is within range", () => {
    const inside = getFeeGrowthInside(100n, 10n, 20n, -10, 10, 0);
    expect(inside).toBe(70n);
  });
  it("wraps like uint256 when growth has overflowed", () => {
    const max = (1n << 256n) - 1n;
    const inside = getFeeGrowthInside(5n, max, 0n, -10, 10, 0);
    expect(inside).toBe(6n);
  });
  it("turns growth deltas into token amounts", () => {
    const L = 1000n;
    const fees = getUncollectedFees(L, 3n << 128n, 1n << 128n);
    expect(fees).toBe(2000n);
  });
});

describe("prices", () => {
  it("adjusts for decimals (USDC/WETH style)", () => {
    // tick where raw price is ~1e-12 gives roughly 1 after 6/18 adjustment
    const p = tickToPrice(0, 6, 18);
    expect(p).toBeCloseTo(1e-12, 20);
    expect(sqrtPriceToPrice(Q96, 18, 18)).toBeCloseTo(1, 12);
  });
});
