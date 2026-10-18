import type { Address } from "viem";
import type { ChainKey } from "./chains";

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  /** True for the chain's native currency (V4 pools can hold it directly). */
  isNative: boolean;
  priceUsd: number | null;
}

export type Protocol = "v3" | "v4";

/** One open Uniswap concentrated-liquidity position, as read live from the chain. */
export interface LpPosition {
  id: string; // `${chain}-${protocol}-${tokenId}`
  chain: ChainKey;
  protocol: Protocol;
  tokenId: string;
  pool: Address | `0x${string}`; // V3 pool address or V4 poolId
  token0: TokenInfo;
  token1: TokenInfo;
  /** Fee tier in hundredths of a bip (500 = 0.05%). V4 dynamic fee pools report the current LP fee. */
  fee: number;
  tickSpacing: number;
  hooks: Address | null;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  sqrtPriceX96: string;
  liquidity: string;
  inRange: boolean;
  /** Human price of token1 per token0 at current, lower and upper. */
  price: { current: number; lower: number; upper: number };
  /** Token amounts the position would withdraw now (decimal-adjusted). */
  amount0: number;
  amount1: number;
  /** Uncollected fees (decimal-adjusted). */
  fees0: number;
  fees1: number;
  valueUsd: number | null;
  feesUsd: number | null;
  explorerUrl: string;
}

export interface LpChainResult {
  chain: ChainKey;
  positions: LpPosition[];
  closedCount: number;
  warnings: string[];
  /** Protocols whose read threw on this chain, so another source may still cover them. */
  failed: Protocol[];
  error?: string;
}
