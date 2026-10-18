import { legThreshold, type BookRow } from "@/lib/metrics";
import { positionAppName, type AssetKind, type Leg, type Position, type SpotHolding, type Thresholds } from "@/lib/types";
import { isLending, positionNetUsd } from "@/lib/view-filter";

/** One supply or borrow line, as the Overview tables list them. */
export interface LegRow {
  key: string;
  positionId: string;
  symbol: string;
  underlying: string;
  kind: AssetKind;
  protocol: string;
  chain: string;
  wallet: string;
  amount: number;
  usd: number;
  apy: number;
  apyUnknown: boolean;
  collateral: boolean;
}

export interface BookTotals {
  suppliedUsd: number;
  borrowedUsd: number;
  spotUsd: number;
  /** Net value of staking, liquidity, vault and other non-lending positions. */
  appsUsd: number;
  /** Supplied − borrowed + apps + spot. */
  netWorthUsd: number;
  /** USD-weighted APYs, decimals. Null when there is nothing on that side. */
  supplyApy: number | null;
  borrowApy: number | null;
  /** Yearly interest at today's rates and balances. */
  yearlyIncomeUsd: number;
  yearlyCostUsd: number;
}

export interface AssetSlice {
  underlying: string;
  kind: AssetKind;
  suppliedUsd: number;
  borrowedUsd: number;
  spotUsd: number;
  supplyApy: number | null;
  borrowApy: number | null;
  /** Supplied − borrowed + spot for this asset. */
  netUsd: number;
}

export type HealthTone = "healthy" | "monitor" | "risk" | "critical" | "none";


export function legRows(rows: BookRow[], side: Leg["side"]): LegRow[] {
  const out: LegRow[] = [];
  for (const { position } of rows) {
    const app = positionAppName(position);
    for (const leg of position.legs) {
      if (leg.side !== side) continue;
      out.push({
        key: `${position.id}:${leg.id}`,
        positionId: position.id,
        symbol: leg.symbol,
        underlying: leg.underlying,
        kind: leg.kind,
        protocol: app,
        chain: position.chain,
        wallet: position.wallet,
        amount: leg.amount,
        usd: leg.usd,
        apy: leg.apy,
        apyUnknown: leg.apyUnknown === true,
        collateral: leg.isCollateral !== false,
      });
    }
  }
  return out.sort((a, b) => b.usd - a.usd);
}

/** USD-weighted APY over the lines whose rate is known. */
export function weightedApy(all: { usd: number; apy: number; apyUnknown?: boolean }[]): number | null {
  const lines = all.filter((line) => !line.apyUnknown);
  const usd = lines.reduce((sum, line) => sum + line.usd, 0);
  if (!(usd > 0)) return null;
  return lines.reduce((sum, line) => sum + line.usd * line.apy, 0) / usd;
}

/** Supplied and borrowed count lending positions only; everything else is "in apps". */
export function bookTotals(rows: BookRow[], spot: SpotHolding[]): BookTotals {
  const lending = rows.filter((row) => isLending(row.position));
  const supplies = legRows(lending, "supply");
  const borrows = legRows(lending, "borrow");
  const appsUsd = rows.filter((row) => !isLending(row.position)).reduce((sum, row) => sum + positionNetUsd(row.position), 0);
  const suppliedUsd = supplies.reduce((sum, leg) => sum + leg.usd, 0);
  const borrowedUsd = borrows.reduce((sum, leg) => sum + leg.usd, 0);
  const spotUsd = spot.reduce((sum, holding) => sum + holding.usd, 0);
  return {
    suppliedUsd,
    borrowedUsd,
    spotUsd,
    appsUsd,
    netWorthUsd: suppliedUsd - borrowedUsd + appsUsd + spotUsd,
    supplyApy: weightedApy(supplies),
    borrowApy: weightedApy(borrows),
    yearlyIncomeUsd: supplies.reduce((sum, leg) => sum + leg.usd * leg.apy, 0),
    yearlyCostUsd: borrows.reduce((sum, leg) => sum + leg.usd * leg.apy, 0),
  };
}

/** Per-asset view across every position and wallet, largest gross exposure first. */
export function assetSlices(rows: BookRow[], spot: SpotHolding[]): AssetSlice[] {
  const map = new Map<string, { kind: AssetKind; supplies: LegRow[]; borrows: LegRow[]; spotUsd: number }>();
  const entry = (underlying: string, kind: AssetKind) => {
    let found = map.get(underlying);
    if (!found) {
      found = { kind, supplies: [], borrows: [], spotUsd: 0 };
      map.set(underlying, found);
    }
    return found;
  };
  for (const leg of legRows(rows, "supply")) entry(leg.underlying, leg.kind).supplies.push(leg);
  for (const leg of legRows(rows, "borrow")) entry(leg.underlying, leg.kind).borrows.push(leg);
  for (const holding of spot) entry(holding.underlying, holding.kind).spotUsd += holding.usd;
  return [...map.entries()]
    .map(([underlying, { kind, supplies, borrows, spotUsd }]) => {
      const suppliedUsd = supplies.reduce((sum, leg) => sum + leg.usd, 0);
      const borrowedUsd = borrows.reduce((sum, leg) => sum + leg.usd, 0);
      return {
        underlying,
        kind,
        suppliedUsd,
        borrowedUsd,
        spotUsd,
        supplyApy: weightedApy(supplies),
        borrowApy: weightedApy(borrows),
        netUsd: suppliedUsd - borrowedUsd + spotUsd,
      };
    })
    .filter((slice) => slice.suppliedUsd + slice.borrowedUsd + slice.spotUsd > 0)
    .sort((a, b) => b.suppliedUsd + b.borrowedUsd + b.spotUsd - (a.suppliedUsd + a.borrowedUsd + a.spotUsd));
}

/** The weakest position decides how close the book is to a liquidation. */
export function lowestHealth(rows: BookRow[]): { value: number; label: string } | null {
  let worst: { value: number; label: string } | null = null;
  for (const { position, metrics } of rows) {
    const value = metrics.healthFactor;
    if (value == null || !Number.isFinite(value)) continue;
    if (!worst || value < worst.value) worst = { value, label: position.label };
  }
  return worst;
}

/** Debt ÷ borrowing limit, where the limit is Σ collateral × liquidation threshold. */
/**
 * Debt against the debt that would liquidate: 100% is the liquidation line. Each book's limit
 * is on its protocol's scale (debt × reported health factor) when the protocol reports one,
 * so the meter agrees with the health factors and liquidation prices shown beside it.
 */
export function borrowPowerUsed(rows: BookRow[]): { used: number; borrowedUsd: number; limitUsd: number } | null {
  let limitUsd = 0;
  let borrowedUsd = 0;
  for (const { position, metrics } of rows) {
    if (!isLending(position)) continue;
    for (const leg of position.legs) {
      if (leg.side === "borrow") borrowedUsd += leg.usd;
      else if (leg.isCollateral !== false) limitUsd += leg.usd * legThreshold(leg) * metrics.thresholdScale;
    }
  }
  if (!(limitUsd > 0)) return null;
  return { used: borrowedUsd / limitUsd, borrowedUsd, limitUsd };
}

export function healthTone(value: number | null | undefined, thresholds: Pick<Thresholds, "healthWarning" | "healthCritical">): HealthTone {
  if (value == null || !Number.isFinite(value)) return "none";
  if (value < thresholds.healthCritical) return "critical";
  if (value < thresholds.healthWarning) return "risk";
  if (value < 2) return "monitor";
  return "healthy";
}

export const HEALTH_LABEL: Record<HealthTone, string> = {
  healthy: "Healthy",
  monitor: "Monitor",
  risk: "At risk",
  critical: "Critical",
  none: "No debt",
};

/** Supplied − borrowed + spot straight from positions, for history snapshots. */
export function netOf(positions: Position[], spot: SpotHolding[]): number {
  let net = 0;
  for (const position of positions) {
    for (const leg of position.legs) net += leg.side === "supply" ? leg.usd : -leg.usd;
  }
  return net + spot.reduce((sum, holding) => sum + holding.usd, 0);
}
