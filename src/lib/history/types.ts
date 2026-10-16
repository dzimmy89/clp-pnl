import type { Hex } from "viem";

export type FlowKind = "deposit" | "withdraw" | "collect";

/**
 * One liquidity event on a position, in human token units with USD prices
 * as of the block it happened in.
 */
export interface Flow {
  kind: FlowKind;
  txHash: Hex;
  blockNumber: string;
  timestamp: number; // unix seconds
  amount0: number;
  amount1: number;
  price0Usd: number | null;
  price1Usd: number | null;
  /** USD value of amount0+amount1 at the time; null if either price is unknown. */
  valueUsd: number | null;
  /** Gas paid for the whole transaction, in native units and USD. */
  gasNative: number;
  gasUsd: number | null;
  /** True when the collect amounts could not be split between fees and principal. */
  estimated?: boolean;
}

export interface PositionHistory {
  positionId: string;
  openedAt: number;
  flows: Flow[];
  /** Totals in token units. */
  deposited0: number;
  deposited1: number;
  withdrawn0: number;
  withdrawn1: number;
  feesCollected0: number;
  feesCollected1: number;
  /** Totals in USD at the time of each flow. */
  costBasisUsd: number | null;
  withdrawnUsd: number | null;
  feesCollectedUsd: number | null;
  gasUsd: number | null;
  gasNative: number;
  warnings: string[];
}

export interface PositionPnl {
  history: PositionHistory;
  /** Current principal value and uncollected fees, from the live read. */
  currentValueUsd: number | null;
  uncollectedFeesUsd: number | null;
  /** What the net deposited tokens would be worth today if simply held. */
  hodlValueUsd: number | null;
  impermanentLossUsd: number | null;
  impermanentLossPct: number | null;
  totalFeesUsd: number | null;
  netPnlUsd: number | null;
  netPnlPct: number | null;
  hodlPnlUsd: number | null;
  /** netPnl - hodlPnl: how much better (or worse) LPing did than holding. */
  vsHodlUsd: number | null;
  feeAprPct: number | null;
  ageDays: number;
}
