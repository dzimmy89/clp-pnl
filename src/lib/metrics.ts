import { assumedLiquidationThreshold } from "@/lib/assets";
import type { AssetKind, Leg, Position, SpotHolding } from "@/lib/types";

export interface AssetNet {
  underlying: string;
  kind: AssetKind;
  supplyAmount: number;
  borrowAmount: number;
  supplyUsd: number;
  borrowUsd: number;
  netAmount: number;
  netUsd: number;
}

export interface HedgeLine {
  underlying: string;
  supplyAmount: number;
  borrowAmount: number;
  /** Borrowed units / supplied units. Null when supply is zero. */
  ratio: number | null;
}

export type LiquidationSide = "below" | "above" | "never" | null;

export interface AssetLiquidation {
  underlying: string;
  priceUsd: number;
  liquidationUsd: number;
}

export interface PositionMetrics {
  supplyUsd: number;
  borrowUsd: number;
  equity: number;
  underwater: boolean;
  leverage: number | null;
  netIncomeUsd: number;
  netApy: number | null;
  hedges: HedgeLine[];
  notionalHedgeRatio: number | null;
  volatileSupplyUsd: number;
  volatileBorrowUsd: number;
  nets: AssetNet[];
  btcDelta: number;
  healthFactor: number | null;
  healthFactorSource: "protocol" | "estimated" | "none";
  /**
   * The primary asset's price when the book is liquidated by every crypto asset, supplied
   * and borrowed alike, moving together by the same fraction while stables stay put. Null
   * when the book has no debt or no such move liquidates it.
   */
  liquidationPriceUsd: number | null;
  /**
   * Which way crypto has to move to liquidate the book: below today's prices for a net long,
   * above them for a net short. "never" means the book has debt but no joint move liquidates
   * it, as when the same asset is supplied and borrowed with nothing else owed.
   */
  liquidationSide: LiquidationSide;
  primaryUnderlying: string | null;
  primaryPriceUsd: number | null;
  /** Size of that joint move as a fraction of today's prices. 0.12 is 12%. */
  liquidationDistance: number | null;
  /** Every crypto asset in the book at the joint move: today's price and the price at liquidation. */
  liquidationPrices: AssetLiquidation[];
  /**
   * The primary asset moving alone with everything else at today's marks. For a staked or
   * wrapped token against its base asset this is the depeg case; for unrelated assets it is
   * the single-asset shock. Null on the same terms as the joint figure.
   */
  soloLiquidationPriceUsd: number | null;
  soloLiquidationSide: LiquidationSide;
  soloLiquidationDistance: number | null;
  assumedThreshold: boolean;
  /**
   * Factor that puts the estimated thresholds on the protocol's scale, so the liquidation
   * price agrees with the health factor the protocol reports. 1 when nothing is reported.
   */
  thresholdScale: number;
}

export interface BookRow {
  position: Position;
  metrics: PositionMetrics;
}

export interface PortfolioMetrics {
  rows: BookRow[];
  active: BookRow[];
  underwater: BookRow[];
  equity: number;
  supplyUsd: number;
  borrowUsd: number;
  netIncomeUsd: number;
  blendedApy: number | null;
  blendedLeverage: number | null;
  lendingBtcDelta: number;
  spotBtcDelta: number;
  totalBtcDelta: number;
}

export function netsFromLegs(legs: Leg[]): AssetNet[] {
  const map = new Map<string, AssetNet>();
  for (const leg of legs) {
    const current = map.get(leg.underlying) ?? {
      underlying: leg.underlying,
      kind: leg.kind,
      supplyAmount: 0,
      borrowAmount: 0,
      supplyUsd: 0,
      borrowUsd: 0,
      netAmount: 0,
      netUsd: 0,
    };
    if (leg.kind === "btc") current.kind = "btc";
    else if (leg.kind === "volatile" && current.kind !== "btc") {
      current.kind = "volatile";
    }
    if (leg.side === "supply") {
      current.supplyAmount += leg.amount;
      current.supplyUsd += leg.usd;
    } else {
      current.borrowAmount += leg.amount;
      current.borrowUsd += leg.usd;
    }
    map.set(leg.underlying, current);
  }
  for (const row of map.values()) {
    row.netAmount = row.supplyAmount - row.borrowAmount;
    row.netUsd = row.supplyUsd - row.borrowUsd;
  }
  return [...map.values()];
}

export function unitPrice(net: AssetNet): number {
  if (net.supplyAmount > 0 && net.supplyUsd > 0) {
    return net.supplyUsd / net.supplyAmount;
  }
  if (net.borrowAmount > 0 && net.borrowUsd > 0) {
    return net.borrowUsd / net.borrowAmount;
  }
  return 0;
}

export function hedgeFromNets(nets: AssetNet[]): {
  lines: HedgeLine[];
  notional: number | null;
  volatileSupplyUsd: number;
  volatileBorrowUsd: number;
} {
  let volatileSupplyUsd = 0;
  let volatileBorrowUsd = 0;
  const lines: HedgeLine[] = [];
  for (const net of nets) {
    if (net.kind === "stable") continue;
    volatileSupplyUsd += net.supplyUsd;
    volatileBorrowUsd += net.borrowUsd;
    if (net.supplyAmount === 0 && net.borrowAmount === 0) continue;
    lines.push({
      underlying: net.underlying,
      supplyAmount: net.supplyAmount,
      borrowAmount: net.borrowAmount,
      ratio: net.supplyAmount > 0 ? net.borrowAmount / net.supplyAmount : null,
    });
  }
  return {
    lines,
    notional: volatileSupplyUsd > 0 ? volatileBorrowUsd / volatileSupplyUsd : null,
    volatileSupplyUsd,
    volatileBorrowUsd,
  };
}

export function btcDeltaFromNets(nets: AssetNet[], btcPrice: number): number {
  let delta = 0;
  for (const net of nets) {
    if (net.kind === "stable") continue;
    if (net.kind === "btc") {
      delta += net.netAmount;
      continue;
    }
    if (!(btcPrice > 0)) continue;
    delta += (net.netAmount * unitPrice(net)) / btcPrice;
  }
  return delta;
}

export function btcDeltaFromSpot(spot: SpotHolding[], btcPrice: number): number {
  let delta = 0;
  for (const holding of spot) {
    if (holding.kind === "stable" || holding.unpriced) continue;
    if (holding.kind === "btc") {
      delta += holding.amount;
      continue;
    }
    if (!(btcPrice > 0)) continue;
    const price = holding.priceUsd > 0 ? holding.priceUsd : 0;
    delta += (holding.amount * price) / btcPrice;
  }
  return delta;
}

export function netIncomeUsd(legs: Leg[]): number {
  let income = 0;
  for (const leg of legs) {
    if (leg.side === "supply") income += leg.usd * leg.apy;
    else income -= leg.usd * leg.apy;
  }
  return income;
}

export function equityOf(legs: Leg[]): number {
  let supply = 0;
  let borrow = 0;
  for (const leg of legs) {
    if (leg.side === "supply") supply += leg.usd;
    else borrow += leg.usd;
  }
  return supply - borrow;
}

/** The leg's liquidation threshold, or the assumed one for its class when none is published. */
export function legThreshold(leg: Leg): number {
  return leg.liquidationThreshold ?? assumedLiquidationThreshold(leg.kind);
}

export function estimateHealthFactor(legs: Leg[]): {
  value: number | null;
  assumed: boolean;
} {
  let collateral = 0;
  let debt = 0;
  let assumed = false;
  for (const leg of legs) {
    if (leg.side === "borrow") {
      debt += leg.usd;
      continue;
    }
    if (leg.isCollateral === false) continue;
    if (leg.liquidationThreshold == null || leg.liquidationThresholdSource === "assumed") {
      assumed = true;
    }
    collateral += leg.usd * legThreshold(leg);
  }
  if (debt <= 0) return { value: null, assumed };
  return { value: collateral / debt, assumed };
}

/**
 * How far the protocol's health factor sits from the estimate, so a liquidation price or a
 * shocked health factor can be put on the protocol's scale. E-mode, isolation and thresholds
 * the reader never saw all end up in this one number. 1 when the protocol reports nothing.
 */
export function thresholdScale(position: Position): number {
  const protocol = position.healthFactor;
  if (position.healthFactorSource !== "protocol" || protocol == null || !Number.isFinite(protocol) || protocol <= 0 || protocol >= 100) return 1;
  const estimated = estimateHealthFactor(position.legs).value;
  if (estimated == null || !(estimated > 0)) return 1;
  return protocol / estimated;
}

/**
 * The volatile asset the book is most exposed to, counting collateral and borrows: the one
 * whose price decides liquidation. Stables never qualify; a short through stable collateral
 * is attributed to the asset borrowed.
 */
export function primaryCollateralUnderlying(legs: Leg[]): string | null {
  const gross = new Map<string, number>();
  for (const leg of legs) {
    if (leg.kind === "stable") continue;
    if (leg.side === "supply" && leg.isCollateral === false) continue;
    gross.set(leg.underlying, (gross.get(leg.underlying) ?? 0) + Math.abs(leg.usd));
  }
  let best: string | null = null;
  let bestUsd = 0;
  for (const [underlying, usd] of gross) {
    if (usd > bestUsd) {
      best = underlying;
      bestUsd = usd;
    }
  }
  return best;
}

export function spotPriceOf(legs: Leg[], underlying: string): number | null {
  let price = 0;
  let weight = 0;
  for (const leg of legs) {
    if (leg.underlying !== underlying || leg.amount <= 0 || leg.usd <= 0) continue;
    price += leg.usd;
    weight += leg.amount;
  }
  if (weight <= 0) return null;
  return price / weight;
}

export interface LiquidationEstimate {
  priceUsd: number | null;
  side: LiquidationSide;
}

/**
 * Price of `underlying` where weighted collateral equals debt, with every other asset held
 * at today's marks. Units of `underlying` borrowed move with the price just as units supplied
 * do, so a same-asset borrow lowers the price's pull on the book instead of counting as fixed
 * debt. `scale` multiplies the thresholds (see `thresholdScale`).
 *
 * Writing S for units supplied, B for units borrowed, lt for the threshold, Wo for other
 * weighted collateral and Do for other debt: P·S·lt + Wo = P·B + Do, so P = (Do − Wo) / (S·lt − B).
 * A long (S·lt > B) is liquidated below that price, a short above it. When no positive price
 * solves it, the side says whether the book can never be liquidated by this price or is
 * already past the line.
 */
export function estimateLiquidationPrice(legs: Leg[], underlying: string, scale = 1): LiquidationEstimate {
  let coefficient = 0;
  let otherCollateralWeighted = 0;
  let otherDebt = 0;
  let debt = 0;
  for (const leg of legs) {
    const primary = leg.underlying === underlying;
    if (leg.side === "supply") {
      if (leg.isCollateral === false) continue;
      const threshold = legThreshold(leg) * scale;
      if (primary) coefficient += leg.amount * threshold;
      else otherCollateralWeighted += leg.usd * threshold;
    } else {
      debt += leg.usd;
      if (primary) coefficient -= leg.amount;
      else otherDebt += leg.usd;
    }
  }
  if (debt <= 0) return { priceUsd: null, side: null };
  const slack = otherCollateralWeighted - otherDebt;
  if (Math.abs(coefficient) < 1e-12) return { priceUsd: null, side: slack >= 0 ? "never" : null };
  const price = -slack / coefficient;
  if (!Number.isFinite(price) || price <= 0) {
    // Weighted collateral minus debt is coefficient·P + slack: with no positive root it keeps
    // one sign for every price, safe when that sign is positive.
    return { priceUsd: null, side: coefficient > 0 ? "never" : null };
  }
  return { priceUsd: price, side: coefficient > 0 ? "below" : "above" };
}

export interface JointLiquidationEstimate {
  /** Signed fraction every crypto asset moves: −0.4 is a 40% fall, 0.6 a 60% rise. */
  move: number | null;
  side: LiquidationSide;
}

/**
 * The move that liquidates the book when every crypto asset, supplied and borrowed alike,
 * changes by the same fraction and stables stay at their marks. A book that supplies ETH and
 * BTC against ETH, BTC and stable debt is liquidated by crypto falling together long before
 * any one asset reaches the price `estimateLiquidationPrice` gives with the others held
 * still, so this is the headline figure; that one is the single-asset view.
 *
 * With k the multiplier on every crypto price, Wv and Dv the crypto collateral (weighted by
 * its scaled thresholds) and crypto debt at today's marks, Ws and Ds the same for stables,
 * the line is k·Wv + Ws = k·Dv + Ds, so k = (Ds − Ws) / (Wv − Dv). A net long (Wv > Dv) is
 * liquidated by a fall, a net short by a rise; with no positive k the book is never liquidated
 * this way (when the sign stays safe) or is already past the line.
 */
export function estimateJointLiquidation(legs: Leg[], scale = 1): JointLiquidationEstimate {
  let cryptoWeighted = 0;
  let stableWeighted = 0;
  let cryptoDebt = 0;
  let stableDebt = 0;
  for (const leg of legs) {
    const stable = leg.kind === "stable";
    if (leg.side === "supply") {
      if (leg.isCollateral === false) continue;
      const weighted = leg.usd * legThreshold(leg) * scale;
      if (stable) stableWeighted += weighted;
      else cryptoWeighted += weighted;
    } else if (stable) stableDebt += leg.usd;
    else cryptoDebt += leg.usd;
  }
  if (cryptoDebt + stableDebt <= 0) return { move: null, side: null };
  const coefficient = cryptoWeighted - cryptoDebt;
  const slack = stableWeighted - stableDebt;
  if (Math.abs(coefficient) < 1e-9) return { move: null, side: slack >= 0 ? "never" : null };
  const k = -slack / coefficient;
  if (!Number.isFinite(k) || k <= 0) return { move: null, side: coefficient > 0 ? "never" : null };
  return { move: k - 1, side: coefficient > 0 ? "below" : "above" };
}

/** Today's price of every crypto asset in the book and its price after the joint move. */
export function liquidationPricesAt(legs: Leg[], move: number | null): AssetLiquidation[] {
  if (move == null) return [];
  const seen = new Set<string>();
  const out: AssetLiquidation[] = [];
  for (const leg of legs) {
    if (leg.kind === "stable" || seen.has(leg.underlying)) continue;
    if (leg.side === "supply" && leg.isCollateral === false) continue;
    seen.add(leg.underlying);
    const price = spotPriceOf(legs, leg.underlying);
    if (price == null) continue;
    out.push({ underlying: leg.underlying, priceUsd: price, liquidationUsd: price * (1 + move) });
  }
  return out.sort((a, b) => a.underlying.localeCompare(b.underlying));
}

export function liquidationDistance(
  spot: number | null,
  liquidation: number | null,
): number | null {
  if (spot == null || liquidation == null || !(spot > 0)) return null;
  return Math.abs(spot - liquidation) / spot;
}

export interface MetricsOptions {
  /** Scenario path ignores the protocol health factor and recomputes it. */
  forceEstimatedHealth?: boolean;
  /** Scenario path: threshold scale taken from the position before the shock. */
  thresholdScale?: number;
  /** Scenario path, whole book: one scale per position, in the positions' order. */
  thresholdScales?: number[];
}

export function positionMetrics(
  position: Position,
  btcPrice: number,
  options: MetricsOptions = {},
): PositionMetrics {
  const supplyUsd = position.legs
    .filter((leg) => leg.side === "supply")
    .reduce((sum, leg) => sum + leg.usd, 0);
  const borrowUsd = position.legs
    .filter((leg) => leg.side === "borrow")
    .reduce((sum, leg) => sum + leg.usd, 0);
  const equity = supplyUsd - borrowUsd;
  const underwater = equity <= 0;
  const income = netIncomeUsd(position.legs);
  const nets = netsFromLegs(position.legs);
  const hedge = hedgeFromNets(nets);
  const estimated = estimateHealthFactor(position.legs);
  const protocolHealth =
    !options.forceEstimatedHealth &&
    position.healthFactor != null &&
    Number.isFinite(position.healthFactor) &&
    position.healthFactor > 0 &&
    position.healthFactor < 100
      ? position.healthFactor
      : null;
  const scale = options.thresholdScale ?? (options.forceEstimatedHealth ? 1 : thresholdScale(position));
  const primaryUnderlying = primaryCollateralUnderlying(position.legs);
  const primaryPriceUsd = primaryUnderlying
    ? spotPriceOf(position.legs, primaryUnderlying)
    : null;
  const solo: LiquidationEstimate = primaryUnderlying
    ? estimateLiquidationPrice(position.legs, primaryUnderlying, scale)
    : { priceUsd: null, side: null };
  // A book with no crypto leg has nothing for a joint move to act on.
  const joint: JointLiquidationEstimate = primaryUnderlying
    ? estimateJointLiquidation(position.legs, scale)
    : { move: null, side: null };
  const liquidationPriceUsd = joint.move != null && primaryPriceUsd != null ? primaryPriceUsd * (1 + joint.move) : null;

  let healthFactor: number | null = null;
  let healthFactorSource: PositionMetrics["healthFactorSource"] = "none";
  if (borrowUsd <= 0) {
    healthFactor = null;
    healthFactorSource = "none";
  } else if (protocolHealth != null) {
    healthFactor = protocolHealth;
    healthFactorSource = "protocol";
  } else if (estimated.value != null) {
    // On the protocol's scale when the scale came from one, so a shocked book compares with the live figure.
    healthFactor = estimated.value * scale;
    healthFactorSource = "estimated";
  }

  return {
    supplyUsd,
    borrowUsd,
    equity,
    underwater,
    leverage: underwater ? null : supplyUsd / equity,
    netIncomeUsd: income,
    // A position with any unrated leg has no meaningful carry, so it shows "—" and raises no carry alert.
    netApy: underwater || position.legs.some((leg) => leg.apyUnknown) ? null : income / equity,
    hedges: hedge.lines,
    notionalHedgeRatio: hedge.notional,
    volatileSupplyUsd: hedge.volatileSupplyUsd,
    volatileBorrowUsd: hedge.volatileBorrowUsd,
    nets,
    btcDelta: btcDeltaFromNets(nets, btcPrice),
    healthFactor,
    healthFactorSource,
    liquidationPriceUsd,
    liquidationSide: joint.side,
    primaryUnderlying,
    primaryPriceUsd,
    liquidationDistance: joint.move == null ? null : Math.abs(joint.move),
    liquidationPrices: liquidationPricesAt(position.legs, joint.move),
    soloLiquidationPriceUsd: solo.priceUsd,
    soloLiquidationSide: solo.side,
    soloLiquidationDistance: liquidationDistance(primaryPriceUsd, solo.priceUsd),
    assumedThreshold: estimated.assumed,
    thresholdScale: scale,
  };
}

export function portfolioMetrics(
  positions: Position[],
  spot: SpotHolding[],
  btcPrice: number,
  options: MetricsOptions = {},
): PortfolioMetrics {
  const rows = positions.map((position, index) => ({
    position,
    metrics: positionMetrics(position, btcPrice, { ...options, thresholdScale: options.thresholdScales?.[index] ?? options.thresholdScale }),
  }));
  const active = rows.filter((row) => !row.metrics.underwater);
  const underwater = rows.filter((row) => row.metrics.underwater);
  const equity = active.reduce((sum, row) => sum + row.metrics.equity, 0);
  const supplyUsd = active.reduce((sum, row) => sum + row.metrics.supplyUsd, 0);
  const netIncomeUsd = active.reduce((sum, row) => sum + row.metrics.netIncomeUsd, 0);
  // Blended APY only weighs positions whose rates are all known.
  const rated = active.filter((row) => row.metrics.netApy != null);
  const ratedEquity = rated.reduce((sum, row) => sum + row.metrics.equity, 0);
  const ratedIncome = rated.reduce((sum, row) => sum + row.metrics.netIncomeUsd, 0);
  const lendingBtcDelta = rows.reduce((sum, row) => sum + row.metrics.btcDelta, 0);
  const spotBtcDelta = btcDeltaFromSpot(spot, btcPrice);
  return {
    rows,
    active,
    underwater,
    equity,
    supplyUsd,
    borrowUsd: active.reduce((sum, row) => sum + row.metrics.borrowUsd, 0),
    netIncomeUsd,
    blendedApy: ratedEquity > 0 ? ratedIncome / ratedEquity : null,
    blendedLeverage: equity > 0 ? supplyUsd / equity : null,
    lendingBtcDelta,
    spotBtcDelta,
    totalBtcDelta: lendingBtcDelta + spotBtcDelta,
  };
}
