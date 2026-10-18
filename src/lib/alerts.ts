import {
  formatHealth,
  formatLeverage,
  formatPercent,
  formatPrice,
  formatRatio,
  shortAddress,
} from "@/lib/format";
import type { BookRow } from "@/lib/metrics";
import { positionAppName, type Position, type Thresholds } from "@/lib/types";

export const DEFAULT_THRESHOLDS: Thresholds = {
  healthWarning: 1.5,
  healthCritical: 1.2,
  minNetApy: 0,
  maxLeverage: 3.5,
  hedgeTolerance: 0.05,
  liquidationProximity: 0.15,
  defaultTargetHedge: 0.3,
};

export interface DeskAlert {
  id: string;
  positionId: string;
  severity: "critical" | "warning";
  sentence: string;
}

export function positionLabel(position: Position): string {
  return `${positionAppName(position)} on ${position.chain} (${shortAddress(position.wallet)})`;
}

function targetFor(
  position: Position,
  targets: Record<string, number>,
  thresholds: Thresholds,
): number {
  return (
    targets[position.id] ??
    position.targetHedgeRatio ??
    thresholds.defaultTargetHedge
  );
}

export function evaluateAlerts(
  rows: BookRow[],
  thresholds: Thresholds,
  targets: Record<string, number> = {},
): DeskAlert[] {
  const alerts: DeskAlert[] = [];
  for (const row of rows) {
    const { position, metrics } = row;
    const label = positionLabel(position);
    const push = (key: string, severity: DeskAlert["severity"], sentence: string) => {
      alerts.push({
        id: `${position.id}:${key}`,
        positionId: position.id,
        severity,
        sentence,
      });
    };

    if (metrics.underwater) {
      push(
        "underwater",
        "critical",
        `${label} is underwater — equity is at or below zero, so leverage and net APY are undefined; repay debt or add collateral.`,
      );
    }

    if (metrics.healthFactor != null && metrics.borrowUsd > 0) {
      const hf = formatHealth(metrics.healthFactor);
      const estimated =
        metrics.healthFactorSource === "estimated" ? "estimated " : "";
      if (metrics.healthFactor < thresholds.healthCritical) {
        push(
          "hf-critical",
          "critical",
          `${label} ${estimated}health factor is ${hf}, under the ${formatHealth(thresholds.healthCritical)} critical line — add collateral or repay debt.`,
        );
      } else if (metrics.healthFactor < thresholds.healthWarning) {
        push(
          "hf-warning",
          "warning",
          `${label} ${estimated}health factor is ${hf}, under the ${formatHealth(thresholds.healthWarning)} warning line — add collateral or repay debt.`,
        );
      }
    }

    if (!metrics.underwater && metrics.netApy != null && metrics.netApy < thresholds.minNetApy) {
      push(
        "apy",
        "warning",
        `${label} net APY is ${formatPercent(metrics.netApy)}, below your ${formatPercent(thresholds.minNetApy)} minimum — carry has flipped; consider reducing borrow or exiting.`,
      );
    }

    if (metrics.leverage != null && metrics.leverage > thresholds.maxLeverage) {
      push(
        "leverage",
        "warning",
        `${label} leverage is ${formatLeverage(metrics.leverage)}, above your ${formatLeverage(thresholds.maxLeverage)} maximum — repay debt or add collateral.`,
      );
    }

    // Hedge and liquidation checks are for lending books; staking, LP and vault rows have no debt to hedge.
    if (position.category && position.category !== "lending") continue;

    const target = targetFor(position, targets, thresholds);
    const volatileLines = metrics.hedges.filter(
      (line) => line.supplyAmount > 0 || line.borrowAmount > 0,
    );
    if (volatileLines.length > 1) {
      for (const line of volatileLines) {
        if (line.ratio == null) {
          push(
            `hedge-open-${line.underlying}`,
            "warning",
            `${label} has ${line.underlying} borrow with no ${line.underlying} supply — repay that borrow or add the same asset as collateral.`,
          );
          continue;
        }
        const drift = Math.abs(line.ratio - target);
        if (drift > thresholds.hedgeTolerance) {
          push(
            `hedge-${line.underlying}`,
            "warning",
            `${label} ${line.underlying} hedge ratio is ${formatRatio(line.ratio)} versus the ${formatRatio(target)} target (drift ${formatRatio(drift)}, tolerance ${formatRatio(thresholds.hedgeTolerance)}) — adjust the same-asset borrow toward the target.`,
          );
        }
      }
    }
    if (metrics.notionalHedgeRatio == null && metrics.volatileBorrowUsd > 0) {
      push(
        "hedge-notional-open",
        "warning",
        `${label} has volatile borrow without volatile supply — repay the unmatched borrow or add collateral.`,
      );
    } else if (metrics.notionalHedgeRatio != null) {
      const drift = Math.abs(metrics.notionalHedgeRatio - target);
      if (drift > thresholds.hedgeTolerance) {
        push(
          "hedge-notional",
          "warning",
          `${label} notional hedge ratio is ${formatRatio(metrics.notionalHedgeRatio)} versus the ${formatRatio(target)} target (drift ${formatRatio(drift)}, tolerance ${formatRatio(thresholds.hedgeTolerance)}) — adjust the same-asset borrow toward the target.`,
        );
      }
    }

    // The nearer of the two lines: every crypto asset moving together, or the main asset alone
    // (the depeg case for a staked token against its base asset).
    const joint =
      metrics.liquidationDistance != null && metrics.liquidationPriceUsd != null
        ? { distance: metrics.liquidationDistance, price: metrics.liquidationPriceUsd, side: metrics.liquidationSide, how: "crypto moves together" }
        : null;
    const solo =
      metrics.soloLiquidationDistance != null && metrics.soloLiquidationPriceUsd != null
        ? { distance: metrics.soloLiquidationDistance, price: metrics.soloLiquidationPriceUsd, side: metrics.soloLiquidationSide, how: `${metrics.primaryUnderlying} moves alone` }
        : null;
    const nearest = joint && solo ? (solo.distance < joint.distance ? solo : joint) : (joint ?? solo);
    if (
      nearest &&
      metrics.primaryPriceUsd != null &&
      metrics.primaryUnderlying != null &&
      nearest.distance <= thresholds.liquidationProximity
    ) {
      push(
        "liq",
        nearest.distance <= thresholds.liquidationProximity / 2 ? "critical" : "warning",
        `${label} is within ${formatPercent(nearest.distance, 0)} of liquidation if ${nearest.how} (${metrics.primaryUnderlying} ${formatPrice(metrics.primaryPriceUsd)} now, ${formatPrice(nearest.price)} ${nearest.side === "above" ? "above" : "below"} liquidates) — add collateral or repay before a small move liquidates the book.`,
      );
    }
  }
  return alerts;
}
