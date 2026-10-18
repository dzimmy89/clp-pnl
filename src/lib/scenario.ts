import {
  portfolioMetrics,
  positionMetrics,
  thresholdScale,
  type PortfolioMetrics,
  type PositionMetrics,
} from "@/lib/metrics";
import type { Leg, Position, SpotHolding } from "@/lib/types";

export interface ScenarioShock {
  /** Decimal move. −0.2 is a 20% drop. Keyed by underlying. */
  byUnderlying: Record<string, number>;
}

export interface PositionScenario {
  position: Position;
  before: PositionMetrics;
  after: PositionMetrics;
  pnl: number;
  shocked: Position;
}

export interface PortfolioScenario {
  before: PortfolioMetrics;
  after: PortfolioMetrics;
  pnl: number;
  positions: PositionScenario[];
  /** Unit hedge ratios use token amounts, which a price move does not change. */
  hedgeUnitsUnchanged: true;
}

export function shockFactor(shocks: Record<string, number>, underlying: string): number {
  const move = shocks[underlying] ?? 0;
  if (!Number.isFinite(move)) return 1;
  return 1 + move;
}

export function shockLegs(legs: Leg[], shocks: Record<string, number>): Leg[] {
  return legs.map((leg) => {
    const factor = shockFactor(shocks, leg.underlying);
    if (factor === 1) return leg;
    return {
      ...leg,
      usd: leg.usd * factor,
      priceUsd: leg.priceUsd != null ? leg.priceUsd * factor : leg.priceUsd,
    };
  });
}

export function shockSpot(
  spot: SpotHolding[],
  shocks: Record<string, number>,
): SpotHolding[] {
  return spot.map((holding) => {
    const factor = shockFactor(shocks, holding.underlying);
    if (factor === 1) return holding;
    return {
      ...holding,
      usd: holding.usd * factor,
      priceUsd: holding.priceUsd * factor,
    };
  });
}

export function shockedBtcPrice(btcPrice: number, shocks: Record<string, number>): number {
  return btcPrice * shockFactor(shocks, "BTC");
}

export function runScenario(
  positions: Position[],
  spot: SpotHolding[],
  btcPrice: number,
  shocks: Record<string, number>,
): PortfolioScenario {
  const before = portfolioMetrics(positions, spot, btcPrice);
  const nextBtc = shockedBtcPrice(btcPrice, shocks);
  // The protocol's health factor can't be recomputed after a shock, so the shocked book is
  // estimated on the protocol's scale, taken from the position before the move.
  const scales = positions.map((position) => thresholdScale(position));
  const nextPositions = positions.map((position) => ({
    ...position,
    legs: shockLegs(position.legs, shocks),
    healthFactor: null,
    healthFactorSource: "estimated" as const,
  }));
  const nextSpot = shockSpot(spot, shocks);
  const after = portfolioMetrics(nextPositions, nextSpot, nextBtc, {
    forceEstimatedHealth: true,
    thresholdScales: scales,
  });
  const positionsOut: PositionScenario[] = positions.map((position, index) => {
    const shocked = nextPositions[index];
    const beforeMetrics = positionMetrics(position, btcPrice);
    const afterMetrics = positionMetrics(shocked, nextBtc, {
      forceEstimatedHealth: true,
      thresholdScale: scales[index],
    });
    return {
      position,
      before: beforeMetrics,
      after: afterMetrics,
      pnl: afterMetrics.equity - beforeMetrics.equity,
      shocked,
    };
  });
  const pnl = after.rows.reduce((sum, row) => sum + row.metrics.equity, 0)
    - before.rows.reduce((sum, row) => sum + row.metrics.equity, 0);
  return {
    before,
    after,
    pnl,
    positions: positionsOut,
    hedgeUnitsUnchanged: true,
  };
}
