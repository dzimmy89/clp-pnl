import { describe, expect, it } from "vitest";
import type { LpPosition } from "@/lib/lp/types";
import { coveredKey, lpToPosition, readDirectly } from "./uniswap";

const lp: LpPosition = {
  id: "base-v3-1234",
  chain: "base",
  protocol: "v3",
  tokenId: "1234",
  pool: "0x0000000000000000000000000000000000000001",
  token0: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18, isNative: false, priceUsd: 3000 },
  token1: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6, isNative: false, priceUsd: 1 },
  fee: 500,
  tickSpacing: 10,
  hooks: null,
  tickLower: -200000,
  tickUpper: -190000,
  currentTick: -195000,
  sqrtPriceX96: "0",
  liquidity: "1000",
  inRange: true,
  price: { current: 3000, lower: 2000, upper: 4000 },
  amount0: 1,
  amount1: 3000,
  fees0: 0.01,
  fees1: 30,
  valueUsd: 6000,
  feesUsd: 60,
  explorerUrl: "https://basescan.org/nft/0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1/1234",
};

describe("lpToPosition", () => {
  it("makes one liquidity row with a supply leg per token, fees included", () => {
    const position = lpToPosition(lp, "0xabc", "2026-10-18T00:00:00.000Z");
    expect(position.protocol).toBe("uniswap");
    expect(position.app).toBe("Uniswap V3");
    expect(position.category).toBe("liquidity");
    expect(position.chain).toBe("Base");
    expect(position.wallet).toBe("0xabc");
    expect(position.legs.map((leg) => leg.side)).toEqual(["supply", "supply"]);
    expect(position.legs[0]).toMatchObject({ symbol: "WETH", underlying: "ETH", kind: "volatile", amount: 1.01, usd: 1.01 * 3000, apyUnknown: true, isCollateral: false });
    expect(position.legs[1]).toMatchObject({ symbol: "USDC", underlying: "USDC", kind: "stable", amount: 3030, usd: 3030 });
    expect(position.lp).toBe(lp);
    expect(position.label).toContain("WETH/USDC 0.05% · Base");
  });

  it("values an unpriced side at zero and says so", () => {
    const position = lpToPosition({ ...lp, token1: { ...lp.token1, priceUsd: null }, valueUsd: null }, "0xabc", "now");
    expect(position.legs[1].usd).toBe(0);
    expect(position.legs[1].priceUsd).toBeUndefined();
    expect(position.note).toContain("partial");
  });
});

describe("readDirectly", () => {
  const covered = new Set([coveredKey("Base", "v3")]);
  it("drops Zerion's copy of a pool the direct reader covered", () => {
    expect(readDirectly({ app: "Uniswap V3", category: "liquidity", chain: "Base" }, covered)).toBe(true);
    expect(readDirectly({ app: "Uniswap", category: "liquidity", chain: "Base" }, covered)).toBe(true);
  });
  it("keeps pools the direct reader missed or does not read", () => {
    expect(readDirectly({ app: "Uniswap V4", category: "liquidity", chain: "Base" }, covered)).toBe(false);
    expect(readDirectly({ app: "Uniswap V3", category: "liquidity", chain: "Optimism" }, covered)).toBe(false);
    expect(readDirectly({ app: "Uniswap V2", category: "liquidity", chain: "Base" }, covered)).toBe(false);
    expect(readDirectly({ app: "Uniswap V3", category: "staking", chain: "Base" }, covered)).toBe(false);
    expect(readDirectly({ app: "Aerodrome", category: "liquidity", chain: "Base" }, covered)).toBe(false);
    expect(readDirectly({ app: "Uniswap V3", category: "liquidity", chain: "Base" }, new Set())).toBe(false);
  });
});
