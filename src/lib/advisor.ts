import { betaOf, bookBeta, positionBeta, type BetaBook } from "@/lib/beta";
import { formatAmount, formatHealth, formatLeverage, formatPercent, formatRatio, formatUsd } from "@/lib/format";
import { legThreshold, positionMetrics, spotPriceOf, type BookRow } from "@/lib/metrics";
import { positionLabel } from "@/lib/alerts";
import type { Leg, Position, SpotHolding, Thresholds } from "@/lib/types";
import { isLending } from "@/lib/view-filter";

/**
 * The advisor reads every position and the book as a whole and proposes concrete changes:
 * how much to repay or add to reach a health target, how much to unwind or add to reach a
 * leverage target, how much to borrow or repay to reach a hedge ratio, and how much
 * BTC-equivalent exposure to cut or add to reach a portfolio beta. Each suggestion carries
 * the before and after values, recomputed on the changed legs. Nothing is executed.
 */

export interface Goals {
  /** Health factor every borrowing position should stay above. */
  healthTarget: number;
  /** Blended leverage (lending supply ÷ lending equity) for the whole book. Null: no target. */
  portfolioLeverage: number | null;
  /** BTC beta of total net worth. 1 moves like holding BTC; 0 is market neutral. Null: no target. */
  portfolioBeta: number | null;
}

export const DEFAULT_GOALS: Goals = { healthTarget: 2, portfolioLeverage: null, portfolioBeta: null };

export interface Effect {
  label: string;
  before: string;
  after: string;
}

export interface Suggestion {
  id: string;
  /** Null for book-wide suggestions. */
  positionId: string | null;
  scope: string;
  severity: "critical" | "warning" | "info";
  kind: "safety" | "leverage" | "hedge" | "beta" | "concentration";
  title: string;
  /** Alternatives; any one of them reaches the goal. */
  options: string[];
  why: string;
  effects: Effect[];
}

export interface AdvisorInput {
  rows: BookRow[];
  spot: SpotHolding[];
  betas: BetaBook;
  btcPrice: number;
  thresholds: Thresholds;
  goals: Goals;
  hedgeTargets: Record<string, number>;
  leverageTargets: Record<string, number>;
}

/** A change to one asset on one side of a position, in USD. Negative removes. */
interface LegChange {
  underlying: string;
  side: Leg["side"];
  usd: number;
}

function largest(legs: Leg[], side: Leg["side"], filter: (leg: Leg) => boolean = () => true): Leg | null {
  let best: Leg | null = null;
  for (const leg of legs) if (leg.side === side && filter(leg) && (!best || leg.usd > best.usd)) best = leg;
  return best;
}

function priceOf(position: Position, underlying: string): number | null {
  return spotPriceOf(position.legs, underlying);
}

/** "1.25 ETH ($3,750)" when the unit price is known, else just the dollars. */
function sized(position: Position, leg: Pick<Leg, "underlying" | "symbol">, usd: number): string {
  const price = priceOf(position, leg.underlying);
  return price ? `${formatAmount(usd / price)} ${leg.symbol} (${formatUsd(usd)})` : `${formatUsd(usd)} of ${leg.symbol}`;
}

function applyChanges(position: Position, changes: LegChange[]): Position {
  const legs = position.legs.map((leg) => ({ ...leg }));
  for (const change of changes) {
    const leg = legs.find((l) => l.underlying === change.underlying && l.side === change.side);
    if (leg) {
      const price = leg.amount > 0 ? leg.usd / leg.amount : 0;
      leg.usd = Math.max(0, leg.usd + change.usd);
      leg.amount = price > 0 ? leg.usd / price : leg.amount;
    } else if (change.usd > 0) {
      const template = position.legs.find((l) => l.underlying === change.underlying);
      const price = template && template.amount > 0 ? template.usd / template.amount : 1;
      legs.push({
        id: `sim:${change.side}:${change.underlying}`,
        side: change.side,
        symbol: template?.symbol ?? change.underlying,
        underlying: change.underlying,
        kind: template?.kind ?? "volatile",
        amount: change.usd / price,
        usd: change.usd,
        apy: 0,
        liquidationThreshold: template?.liquidationThreshold,
        isCollateral: change.side === "supply",
      });
    }
  }
  return { ...position, legs: legs.filter((leg) => leg.usd > 1e-9) };
}

interface Snapshot {
  health: number | null;
  leverage: number | null;
  hedge: number | null;
  /** Units ratio for the primary volatile asset. */
  primaryHedge: number | null;
}

/**
 * Metrics after a change. A protocol-reported health factor is kept on its own scale by
 * multiplying it by the change in the estimated one.
 */
function simulate(row: BookRow, changes: LegChange[], btcPrice: number): Snapshot {
  const before = positionMetrics(row.position, btcPrice, { forceEstimatedHealth: true });
  const changed = applyChanges(row.position, changes);
  const after = positionMetrics(changed, btcPrice, { forceEstimatedHealth: true });
  const scale =
    row.metrics.healthFactorSource === "protocol" && row.metrics.healthFactor != null && before.healthFactor
      ? row.metrics.healthFactor / before.healthFactor
      : 1;
  const primary = row.metrics.primaryUnderlying;
  const line = primary ? after.hedges.find((h) => h.underlying === primary) : null;
  return {
    health: after.borrowUsd > 0 && after.healthFactor != null ? after.healthFactor * scale : null,
    leverage: after.underwater ? null : after.leverage,
    hedge: after.notionalHedgeRatio,
    primaryHedge: line?.ratio ?? null,
  };
}

/** Collateral weighted by liquidation threshold, on the protocol's scale when it reports health. */
function weightedCollateral(row: BookRow): { weighted: number; debt: number } {
  const debt = row.metrics.borrowUsd;
  if (row.metrics.healthFactor != null) return { weighted: row.metrics.healthFactor * debt, debt };
  let weighted = 0;
  for (const leg of row.position.legs) {
    if (leg.side === "supply" && leg.isCollateral !== false) weighted += leg.usd * legThreshold(leg);
  }
  return { weighted, debt };
}

const healthText = (value: number | null) => (value == null ? "No debt" : formatHealth(value));
const leverageText = (value: number | null) => (value == null ? "—" : formatLeverage(value));

function safety(row: BookRow, input: AdvisorInput): Suggestion | null {
  const { position, metrics } = row;
  const target = input.goals.healthTarget;
  const hf = metrics.healthFactor;
  if (metrics.borrowUsd <= 0 || hf == null || hf >= target) return null;
  const { weighted, debt } = weightedCollateral(row);
  // Repaying a stable loan first leaves any same-asset hedge in place.
  const debtLeg = largest(position.legs, "borrow", (leg) => leg.kind === "stable") ?? largest(position.legs, "borrow");
  const collateral = largest(position.legs, "supply", (leg) => leg.isCollateral !== false);
  if (!debtLeg) return null;
  const options: string[] = [];
  const effects: Effect[] = [];

  // Repay from outside funds: weighted / (debt − x) = target.
  const repay = debt - weighted / target;
  if (repay > 0) {
    const after = simulate(row, repayChanges(position, repay), input.btcPrice);
    options.push(
      repay <= debtLeg.usd + 1e-6
        ? `Repay ${sized(position, debtLeg, repay)}.`
        : `Repay ${formatUsd(repay)} of debt, starting with ${debtLeg.symbol}.`,
    );
    effects.push({ label: "Health after repaying", before: healthText(hf), after: healthText(after.health) });
  }
  if (collateral) {
    const threshold = legThreshold(collateral);
    const scale = metrics.healthFactorSource === "protocol" ? weighted / Math.max(1e-9, rawWeighted(position)) : 1;
    // Add collateral: (weighted + y·lt·scale) / debt = target.
    const add = (target * debt - weighted) / (threshold * scale);
    if (add > 0) options.push(`Or add ${sized(position, collateral, add)} as collateral.`);
    // No new money: sell collateral to repay. (weighted − x·lt·scale) / (debt − x) = target.
    const denominator = target - threshold * scale;
    const unwind = denominator > 0 ? (target * debt - weighted) / denominator : Infinity;
    if (unwind > 0 && unwind < collateral.usd && unwind < debt) {
      options.push(
        collateral.underlying === debtLeg.underlying
          ? `Or, without new money: withdraw ${sized(position, collateral, unwind)} and use it to repay the ${debtLeg.symbol} loan.`
          : `Or, without new money: withdraw and sell ${sized(position, collateral, unwind)}, then repay ${formatUsd(unwind)} of ${debtLeg.symbol}.`,
      );
    }
  }
  if (!options.length) return null;
  const severity = hf < input.thresholds.healthCritical ? "critical" : hf < input.thresholds.healthWarning ? "warning" : "info";
  return {
    id: `${position.id}:safety`,
    positionId: position.id,
    scope: positionLabel(position),
    severity,
    kind: "safety",
    title: `Raise health from ${formatHealth(hf)} to ${formatHealth(target)}`,
    options,
    why:
      `${metrics.healthFactorSource === "estimated" ? "Estimated health" : "Health"} is ${formatHealth(hf)}` +
      (metrics.liquidationDistance != null && metrics.primaryUnderlying
        ? `; a ${formatPercent(metrics.liquidationDistance, 0)} ${metrics.liquidationSide === "above" ? "rise" : "drop"} across its crypto assets would liquidate it${
            metrics.liquidationPrices.length > 1 && metrics.soloLiquidationDistance != null && metrics.soloLiquidationDistance < metrics.liquidationDistance
              ? `, or ${metrics.primaryUnderlying} alone ${metrics.soloLiquidationSide === "above" ? "rising" : "falling"} ${formatPercent(metrics.soloLiquidationDistance, 0)}`
              : ""
          }.`
        : "."),
    effects,
  };
}

/** Repays `usd` across the loans, stablecoins first, then largest first. */
function repayChanges(position: Position, usd: number): LegChange[] {
  const loans = position.legs
    .filter((leg) => leg.side === "borrow")
    .sort((a, b) => Number(b.kind === "stable") - Number(a.kind === "stable") || b.usd - a.usd);
  const changes: LegChange[] = [];
  let left = usd;
  for (const loan of loans) {
    if (left <= 0) break;
    const take = Math.min(loan.usd, left);
    changes.push({ underlying: loan.underlying, side: "borrow", usd: -take });
    left -= take;
  }
  return changes;
}

function rawWeighted(position: Position): number {
  let weighted = 0;
  for (const leg of position.legs) {
    if (leg.side === "supply" && leg.isCollateral !== false) weighted += leg.usd * legThreshold(leg);
  }
  return weighted;
}

function leverage(row: BookRow, input: AdvisorInput): Suggestion | null {
  const { position, metrics } = row;
  if (metrics.borrowUsd <= 0 || metrics.underwater || metrics.leverage == null) return null;
  const explicit = input.leverageTargets[position.id];
  const target = explicit ?? (metrics.leverage > input.thresholds.maxLeverage ? input.thresholds.maxLeverage : null);
  if (target == null || !(target >= 1)) return null;
  if (Math.abs(metrics.leverage - target) <= Math.max(0.05, target * 0.03)) return null;
  const collateral = largest(position.legs, "supply", (leg) => leg.isCollateral !== false && leg.kind !== "stable") ?? largest(position.legs, "supply");
  const debtLeg = largest(position.legs, "borrow", (leg) => leg.kind === "stable") ?? largest(position.legs, "borrow");
  if (!collateral || !debtLeg) return null;
  // Selling collateral to repay debt keeps equity, so leverage = (supply − x) / equity.
  const x = metrics.supplyUsd - target * metrics.equity;
  const lower = x > 0;
  const size = Math.abs(x);
  const changes: LegChange[] = [
    { underlying: collateral.underlying, side: "supply", usd: lower ? -size : size },
    { underlying: debtLeg.underlying, side: "borrow", usd: lower ? -size : size },
  ];
  if (lower && size >= metrics.borrowUsd) return null;
  const after = simulate(row, changes, input.btcPrice);
  const unsafe = !lower && after.health != null && after.health < input.goals.healthTarget;
  return {
    id: `${position.id}:leverage`,
    positionId: position.id,
    scope: positionLabel(position),
    severity: lower && explicit == null ? "warning" : "info",
    kind: "leverage",
    title: `${lower ? "Lower" : "Raise"} leverage from ${formatLeverage(metrics.leverage)} to ${formatLeverage(target)}`,
    options: [
      lower
        ? `Withdraw and sell ${sized(position, collateral, size)}, then repay ${formatUsd(size)} of ${debtLeg.symbol}.`
        : `Borrow ${sized(position, debtLeg, size)}, swap it to ${collateral.symbol} and supply it.`,
    ],
    why:
      explicit != null
        ? `Your target for this position is ${formatLeverage(target)}.` + (unsafe ? ` This would take health under your ${formatHealth(input.goals.healthTarget)} target.` : "")
        : `Leverage is above your ${formatLeverage(input.thresholds.maxLeverage)} maximum.`,
    effects: [
      { label: "Leverage", before: leverageText(metrics.leverage), after: leverageText(after.leverage) },
      { label: "Health", before: healthText(metrics.healthFactor), after: healthText(after.health) },
    ],
  };
}

function hedge(row: BookRow, input: AdvisorInput): Suggestion | null {
  const { position, metrics } = row;
  const primary = metrics.primaryUnderlying;
  if (!primary || metrics.underwater) return null;
  const line = metrics.hedges.find((h) => h.underlying === primary);
  if (!line || line.ratio == null || !(line.supplyAmount > 0)) return null;
  const explicit = input.hedgeTargets[position.id] ?? position.targetHedgeRatio;
  // A deposit with no debt is only hedged when you ask for it.
  if (explicit == null && metrics.borrowUsd <= 0) return null;
  const target = explicit ?? input.thresholds.defaultTargetHedge;
  if (Math.abs(line.ratio - target) <= input.thresholds.hedgeTolerance) return null;
  const price = priceOf(position, primary);
  if (!price) return null;
  const supplyLeg = largest(position.legs, "supply", (leg) => leg.underlying === primary);
  if (!supplyLeg) return null;
  const units = target * line.supplyAmount - line.borrowAmount;
  const usd = Math.abs(units) * price;
  const stableDebt = largest(position.legs, "borrow", (leg) => leg.kind === "stable");
  const changes: LegChange[] = [{ underlying: primary, side: "borrow", usd: units > 0 ? usd : -usd }];
  let option: string;
  if (units > 0) {
    // Keep the sale proceeds in the position so health barely moves: repay stable debt, then supply the rest.
    const repay = Math.min(stableDebt?.usd ?? 0, usd);
    const deposit = usd - repay;
    const stable = largest(position.legs, "supply", (leg) => leg.kind === "stable");
    const depositSymbol = stable?.symbol ?? stableDebt?.symbol ?? "USDC";
    if (repay > 0 && stableDebt) changes.push({ underlying: stableDebt.underlying, side: "borrow", usd: -repay });
    if (deposit > 0) changes.push({ underlying: stable?.underlying ?? stableDebt?.underlying ?? "USDC", side: "supply", usd: deposit });
    const borrow = `Borrow ${formatAmount(units)} ${supplyLeg.symbol} (${formatUsd(usd)}) and sell it`;
    option =
      repay > 0 && deposit > 0
        ? `${borrow}, repay ${formatUsd(repay)} of ${stableDebt!.symbol} and supply the other ${formatUsd(deposit)} as ${depositSymbol}.`
        : repay > 0
          ? `${borrow}, then repay ${formatUsd(repay)} of ${stableDebt!.symbol}.`
          : `${borrow}, then supply the ${formatUsd(deposit)} as ${depositSymbol}.`;
  } else {
    option = `Buy ${formatAmount(-units)} ${supplyLeg.symbol} (${formatUsd(usd)}) and repay that much of your ${supplyLeg.symbol} debt.`;
  }
  const after = simulate(row, changes, input.btcPrice);
  const unsafe = after.health != null && after.health < input.goals.healthTarget && (metrics.healthFactor ?? Infinity) >= input.goals.healthTarget;
  return {
    id: `${position.id}:hedge`,
    positionId: position.id,
    scope: positionLabel(position),
    severity: "info",
    kind: "hedge",
    title: `${units > 0 ? "Raise" : "Lower"} the ${primary} hedge from ${formatRatio(line.ratio)} to ${formatRatio(target)}`,
    options: [option],
    why:
      `Borrowing the same asset you supply offsets its price moves. Your target is ${formatRatio(target)} of supplied ${primary}.` +
      (unsafe ? ` This takes health under your ${formatHealth(input.goals.healthTarget)} target, so do it in steps or lower the hedge target.` : ""),
    effects: [
      { label: `${primary} hedge`, before: formatRatio(line.ratio), after: after.primaryHedge == null ? "—" : formatRatio(after.primaryHedge) },
      { label: "Health", before: healthText(metrics.healthFactor), after: healthText(after.health) },
    ],
  };
}

function portfolioBeta(input: AdvisorInput): Suggestion | null {
  const target = input.goals.portfolioBeta;
  if (target == null) return null;
  const book = bookBeta(input.rows, input.spot, input.betas, input.btcPrice);
  const netWorth = input.rows.reduce((sum, row) => sum + row.metrics.equity, 0) + input.spot.filter((h) => !h.unpriced).reduce((sum, h) => sum + h.usd, 0);
  if (book.beta == null || !(netWorth > 0)) return null;
  const change = (target - book.beta) * netWorth;
  if (Math.abs(change) < Math.max(50, netWorth * 0.02)) return null;
  const options: string[] = [];
  const btcUnits = input.btcPrice > 0 ? Math.abs(change) / input.btcPrice : null;
  if (change < 0) {
    // The wallet balance that carries the most beta is the cheapest thing to trim.
    const trim = [...input.spot]
      .filter((h) => !h.unpriced && h.kind !== "stable")
      .map((h) => ({ holding: h, beta: betaOf(h.underlying, h.kind, input.betas).beta }))
      .filter((item) => item.beta > 0)
      .sort((a, b) => b.holding.usd * b.beta - a.holding.usd * a.beta)[0];
    if (trim) {
      const usd = Math.min(trim.holding.usd, Math.abs(change) / trim.beta);
      options.push(
        `Sell ${formatUsd(usd)} of ${trim.holding.symbol} (${trim.holding.chain}) for stables. Its beta is ${trim.beta.toFixed(2)}` +
          (usd < Math.abs(change) / trim.beta ? ", then cover the rest another way." : "."),
      );
    }
    if (btcUnits) options.push(`Or borrow ${formatAmount(btcUnits)} BTC (${formatUsd(Math.abs(change))}) against stables and sell it.`);
    if (btcUnits) options.push(`Or short ${formatAmount(btcUnits)} BTC on a perp exchange.`);
  } else {
    options.push(btcUnits ? `Buy ${formatAmount(btcUnits)} BTC (${formatUsd(change)}).` : `Buy ${formatUsd(change)} of BTC.`);
  }
  const after = (book.betaUsd + change) / netWorth;
  return {
    id: "book:beta",
    positionId: null,
    scope: "Whole portfolio",
    severity: "info",
    kind: "beta",
    title: `${change < 0 ? "Cut" : "Add"} ${formatUsd(Math.abs(change))} of BTC-equivalent exposure`,
    options,
    why: `Your book moves about ${book.beta.toFixed(2)}% for every 1% BTC moves. Your target is ${target.toFixed(2)}.`,
    effects: [
      { label: "Portfolio BTC beta", before: book.beta.toFixed(2), after: after.toFixed(2) },
      { label: "Beta-weighted BTC", before: formatAmount(book.betaBtc), after: input.btcPrice > 0 ? formatAmount((book.betaUsd + change) / input.btcPrice) : "—" },
    ],
  };
}

function portfolioLeverage(input: AdvisorInput): Suggestion | null {
  const target = input.goals.portfolioLeverage;
  if (target == null || !(target >= 1)) return null;
  const lending = input.rows.filter((row) => isLending(row.position) && !row.metrics.underwater && row.metrics.borrowUsd > 0);
  const supply = lending.reduce((sum, row) => sum + row.metrics.supplyUsd, 0);
  const equity = lending.reduce((sum, row) => sum + row.metrics.equity, 0);
  if (!(equity > 0)) return null;
  const current = supply / equity;
  if (Math.abs(current - target) <= Math.max(0.05, target * 0.03)) return null;
  const total = supply - target * equity;
  if (total < 0) {
    return {
      id: "book:leverage",
      positionId: null,
      scope: "Whole portfolio",
      severity: "info",
      kind: "leverage",
      title: `Room to raise leverage from ${formatLeverage(current)} to ${formatLeverage(target)}`,
      options: [`You could borrow about ${formatUsd(-total)} more and supply it. Check each position's health first.`],
      why: `Blended leverage across your borrowing positions is under your ${formatLeverage(target)} target.`,
      effects: [{ label: "Blended leverage", before: formatLeverage(current), after: formatLeverage(target) }],
    };
  }
  // Unwind the most levered positions first, each no lower than the target.
  const options: string[] = [];
  let left = total;
  for (const row of [...lending].sort((a, b) => (b.metrics.leverage ?? 0) - (a.metrics.leverage ?? 0))) {
    if (left <= 0) break;
    const room = row.metrics.supplyUsd - target * row.metrics.equity;
    if (room <= 0) continue;
    const take = Math.min(room, left, row.metrics.borrowUsd);
    const collateral = largest(row.position.legs, "supply", (leg) => leg.isCollateral !== false);
    const debtLeg = largest(row.position.legs, "borrow", (leg) => leg.kind === "stable") ?? largest(row.position.legs, "borrow");
    if (!collateral || !debtLeg) continue;
    options.push(`${positionLabel(row.position)}: sell ${sized(row.position, collateral, take)} and repay ${formatUsd(take)} of ${debtLeg.symbol}.`);
    left -= take;
  }
  if (!options.length) return null;
  return {
    id: "book:leverage",
    positionId: null,
    scope: "Whole portfolio",
    severity: "info",
    kind: "leverage",
    title: `Lower blended leverage from ${formatLeverage(current)} to ${formatLeverage(target)}`,
    options: options.length > 1 ? [`Do all of these: ${options.join(" ")}`] : options,
    why: `Unwinds ${formatUsd(total - Math.max(0, left))} of collateral and debt, most-levered positions first.`,
    effects: [{ label: "Blended leverage", before: formatLeverage(current), after: formatLeverage((supply - (total - Math.max(0, left))) / equity) }],
  };
}

function concentration(input: AdvisorInput): Suggestion | null {
  const byAsset = new Map<string, number>();
  const add = (underlying: string, kind: string, usd: number) => {
    if (kind === "stable") return;
    byAsset.set(underlying, (byAsset.get(underlying) ?? 0) + usd);
  };
  for (const row of input.rows) for (const leg of row.position.legs) add(leg.underlying, leg.kind, leg.side === "supply" ? leg.usd : -leg.usd);
  for (const holding of input.spot) if (!holding.unpriced) add(holding.underlying, holding.kind, holding.usd);
  const gross = [...byAsset.values()].reduce((sum, usd) => sum + Math.abs(usd), 0);
  const [top] = [...byAsset].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  if (!top || !(gross > 0) || byAsset.size < 2) return null;
  const share = Math.abs(top[1]) / gross;
  if (share < 0.6) return null;
  return {
    id: "book:concentration",
    positionId: null,
    scope: "Whole portfolio",
    severity: "info",
    kind: "concentration",
    title: `${top[0]} is ${formatPercent(share, 0)} of your market exposure`,
    options: [`One sharp ${top[0]} move drives most of your result. Spreading some of it into other assets or stables lowers that.`],
    why: "Measured on net exposure across every position and wallet, stables excluded.",
    effects: [],
  };
}

const ORDER = { critical: 0, warning: 1, info: 2 } as const;
const KIND_ORDER = { safety: 0, leverage: 1, hedge: 2, beta: 3, concentration: 4 } as const;

export function suggest(input: AdvisorInput): Suggestion[] {
  const out: Suggestion[] = [];
  for (const row of input.rows) {
    if (!isLending(row.position)) continue;
    for (const rule of [safety, leverage, hedge]) {
      const found = rule(row, input);
      if (found) out.push(found);
    }
  }
  for (const rule of [portfolioBeta, portfolioLeverage, concentration]) {
    const found = rule(input);
    if (found) out.push(found);
  }
  return out.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** Per-position beta rows for the advisor table, largest beta-weighted exposure first. */
export function betaRows(rows: BookRow[], betas: BetaBook, btcPrice: number) {
  return rows
    .map((row) => ({ row, exposure: positionBeta(row.position, betas, btcPrice) }))
    .sort((a, b) => Math.abs(b.exposure.betaUsd) - Math.abs(a.exposure.betaUsd));
}
