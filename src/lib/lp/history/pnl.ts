import type { LpPosition } from "../types";
import type { Flow, PositionHistory, PositionPnl } from "./types";

function sumOrNull(values: (number | null)[]): number | null {
  if (values.length === 0) return 0;
  if (values.some((v) => v == null)) return null;
  return values.reduce<number>((s, v) => s + (v as number), 0);
}

/** Roll flows up into position-level totals. Collects are split by the caller into fees vs principal. */
export function summarizeFlows(positionId: string, flows: Flow[], warnings: string[] = []): PositionHistory {
  const deposits = flows.filter((f) => f.kind === "deposit");
  const withdrawals = flows.filter((f) => f.kind === "withdraw");
  const collects = flows.filter((f) => f.kind === "collect");
  const sum = (fs: Flow[], k: "amount0" | "amount1") => fs.reduce((s, f) => s + f[k], 0);

  // A tx's gas is counted once even if it emitted several events.
  const gasByTx = new Map<string, { native: number; usd: number | null }>();
  for (const f of flows) gasByTx.set(f.txHash, { native: f.gasNative, usd: f.gasUsd });
  const gasRows = [...gasByTx.values()];

  return {
    positionId,
    openedAt: flows.length ? Math.min(...flows.map((f) => f.timestamp)) : 0,
    flows: [...flows].sort((a, b) => a.timestamp - b.timestamp),
    deposited0: sum(deposits, "amount0"),
    deposited1: sum(deposits, "amount1"),
    withdrawn0: sum(withdrawals, "amount0"),
    withdrawn1: sum(withdrawals, "amount1"),
    feesCollected0: sum(collects, "amount0"),
    feesCollected1: sum(collects, "amount1"),
    costBasisUsd: sumOrNull(deposits.map((f) => f.valueUsd)),
    withdrawnUsd: sumOrNull(withdrawals.map((f) => f.valueUsd)),
    feesCollectedUsd: sumOrNull(collects.map((f) => f.valueUsd)),
    gasUsd: sumOrNull(gasRows.map((g) => g.usd)),
    gasNative: gasRows.reduce((s, g) => s + g.native, 0),
    warnings,
  };
}

/**
 * LpPosition PnL versus simply holding.
 *
 *   hodlValue  = (deposited - withdrawn) tokens valued at today's prices
 *   IL         = current principal value - hodlValue
 *   netPnl     = currentValue + uncollectedFees + withdrawnUsd + feesCollectedUsd - costBasis - gas
 *   hodlPnl    = hodlValue + withdrawnUsd - costBasis
 *   vsHodl     = netPnl - hodlPnl   (= total fees + IL - gas)
 */
export function computePnl(history: PositionHistory, live: LpPosition | null, now = Date.now() / 1000): PositionPnl {
  const p0 = live?.token0.priceUsd ?? null;
  const p1 = live?.token1.priceUsd ?? null;
  const currentValueUsd = live?.valueUsd ?? null;
  const uncollectedFeesUsd = live?.feesUsd ?? null;

  const net0 = history.deposited0 - history.withdrawn0;
  const net1 = history.deposited1 - history.withdrawn1;
  const hodlValueUsd = p0 != null && p1 != null ? Math.max(0, net0) * p0 + Math.max(0, net1) * p1 : null;

  const impermanentLossUsd = currentValueUsd != null && hodlValueUsd != null ? currentValueUsd - hodlValueUsd : null;
  const impermanentLossPct = impermanentLossUsd != null && hodlValueUsd ? (impermanentLossUsd / hodlValueUsd) * 100 : null;

  const totalFeesUsd =
    history.feesCollectedUsd != null && uncollectedFeesUsd != null ? history.feesCollectedUsd + uncollectedFeesUsd : null;

  const parts = [currentValueUsd, uncollectedFeesUsd, history.withdrawnUsd, history.feesCollectedUsd, history.costBasisUsd, history.gasUsd];
  const netPnlUsd = parts.every((v) => v != null)
    ? currentValueUsd! + uncollectedFeesUsd! + history.withdrawnUsd! + history.feesCollectedUsd! - history.costBasisUsd! - history.gasUsd!
    : null;
  const netPnlPct = netPnlUsd != null && history.costBasisUsd ? (netPnlUsd / history.costBasisUsd) * 100 : null;

  const hodlPnlUsd =
    hodlValueUsd != null && history.withdrawnUsd != null && history.costBasisUsd != null
      ? hodlValueUsd + history.withdrawnUsd - history.costBasisUsd
      : null;
  const vsHodlUsd = netPnlUsd != null && hodlPnlUsd != null ? netPnlUsd - hodlPnlUsd : null;

  const ageDays = history.openedAt ? Math.max((now - history.openedAt) / 86_400, 1 / 24) : 0;
  const feeAprPct =
    totalFeesUsd != null && history.costBasisUsd && ageDays > 0
      ? (totalFeesUsd / history.costBasisUsd) * (365 / ageDays) * 100
      : null;

  return {
    history,
    currentValueUsd,
    uncollectedFeesUsd,
    hodlValueUsd,
    impermanentLossUsd,
    impermanentLossPct,
    totalFeesUsd,
    netPnlUsd,
    netPnlPct,
    hodlPnlUsd,
    vsHodlUsd,
    feeAprPct,
    ageDays,
  };
}
