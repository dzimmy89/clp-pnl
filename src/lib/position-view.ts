import { formatLeverage, formatPercent, formatPrice, formatUsd } from "@/lib/format";
import type { BookRow, PositionMetrics } from "@/lib/metrics";
import { healthTone, type HealthTone } from "@/lib/overview";
import { positionAppName, type AssetKind, type SpotHolding, type Thresholds } from "@/lib/types";
import { isLending } from "@/lib/view-filter";

/** Health factors at or above this sit at the right end of a health bar. */
export const HEALTH_SCALE_MAX = 3;

/**
 * Where a health factor sits on a bar that runs from liquidation (1.0) on the left to
 * HEALTH_SCALE_MAX on the right, as a fraction 0–1.
 */
export function healthOnScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, (value - 1) / (HEALTH_SCALE_MAX - 1)));
}

/** The liquidation line a position card leads with: the joint crypto move, with the primary asset's price. */
export interface LiquidationLine {
  side: "below" | "above";
  /** Fraction crypto has to move together. 0.12 is 12%. */
  distance: number;
  asset: string | null;
  priceUsd: number | null;
  liquidationUsd: number | null;
}

export function liquidationLine(metrics: PositionMetrics): LiquidationLine | null {
  if (metrics.liquidationDistance == null || (metrics.liquidationSide !== "below" && metrics.liquidationSide !== "above")) return null;
  const primary = metrics.liquidationPrices.find((asset) => asset.underlying === metrics.primaryUnderlying) ?? metrics.liquidationPrices[0];
  return {
    side: metrics.liquidationSide,
    distance: metrics.liquidationDistance,
    asset: primary?.underlying ?? metrics.primaryUnderlying,
    priceUsd: primary?.priceUsd ?? metrics.primaryPriceUsd,
    liquidationUsd: primary?.liquidationUsd ?? metrics.liquidationPriceUsd,
  };
}

/**
 * How worried to be about a position, on one scale for every surface: the health tone, made
 * one step worse when crypto sits within the alert distance of the liquidation line.
 */
export function positionTone(metrics: PositionMetrics, thresholds: Thresholds): HealthTone {
  if (metrics.underwater) return "critical";
  if (metrics.borrowUsd <= 0) return "none";
  const tone = healthTone(metrics.healthFactor, thresholds);
  const line = liquidationLine(metrics);
  if (line && line.distance < thresholds.liquidationProximity && (tone === "healthy" || tone === "monitor" || tone === "none")) return "risk";
  return tone;
}

/** Plain-language read of one position: what it holds, what it earns, and what would liquidate it. */
export function positionStory(metrics: PositionMetrics): { holds: string; earns: string | null; risk: string } {
  const holds =
    metrics.borrowUsd > 0
      ? metrics.underwater
        ? `Supplies ${formatUsd(metrics.supplyUsd)} against ${formatUsd(metrics.borrowUsd)} of debt, so the debt is larger than the collateral.`
        : `Supplies ${formatUsd(metrics.supplyUsd)} and borrows ${formatUsd(metrics.borrowUsd)}, leaving ${formatUsd(metrics.equity)} of your own money in it${
            metrics.leverage != null && metrics.leverage >= 1.05 ? ` at ${formatLeverage(metrics.leverage)} leverage` : ""
          }.`
      : `Supplies ${formatUsd(metrics.supplyUsd)} with nothing borrowed.`;

  const earns =
    metrics.netApy == null || metrics.underwater
      ? null
      : `${metrics.netIncomeUsd >= 0 ? "Earns" : "Costs"} ${formatUsd(Math.abs(metrics.netIncomeUsd))} a year at today's rates, ${formatPercent(metrics.netApy)} on that equity.`;

  let risk: string;
  const line = liquidationLine(metrics);
  if (metrics.borrowUsd <= 0) risk = "No debt, so it cannot be liquidated.";
  else if (metrics.underwater) risk = "Already past the liquidation line.";
  else if (line) {
    const move = line.side === "below" ? "fall" : "rise";
    const at = line.asset && line.liquidationUsd != null ? ` (${line.asset} at ${formatPrice(line.liquidationUsd)})` : "";
    risk = `Liquidated if crypto prices ${move} ${formatPercent(line.distance, 0)} together${at}.`;
  } else if (metrics.liquidationSide === "never") risk = "No crypto price move liquidates it: the crypto it borrows is covered by the same asset supplied.";
  else risk = "No liquidation price could be worked out for it.";

  return { holds, earns, risk };
}

/** One debt position on the at-a-glance risk list, worst first. */
export interface RiskRow {
  row: BookRow;
  app: string;
  tone: HealthTone;
  line: LiquidationLine | null;
}

const TONE_ORDER: Record<HealthTone, number> = { critical: 0, risk: 1, monitor: 2, healthy: 3, none: 4 };

export function riskRows(rows: BookRow[], thresholds: Thresholds): RiskRow[] {
  return rows
    .filter((row) => isLending(row.position) && row.metrics.borrowUsd > 0)
    .map((row) => ({ row, app: positionAppName(row.position), tone: positionTone(row.metrics, thresholds), line: liquidationLine(row.metrics) }))
    .sort(
      (a, b) =>
        TONE_ORDER[a.tone] - TONE_ORDER[b.tone] ||
        (a.line?.distance ?? Infinity) - (b.line?.distance ?? Infinity) ||
        (a.row.metrics.healthFactor ?? Infinity) - (b.row.metrics.healthFactor ?? Infinity),
    );
}

/** Spot balances of one asset across every wallet and chain. */
export interface SpotGroup {
  underlying: string;
  kind: AssetKind;
  /** Symbols held, e.g. WETH and ETH both count as ETH. */
  symbols: string[];
  amount: number;
  usd: number;
  /** Average USD price over the priced lines; 0 when none is priced. */
  priceUsd: number;
  unpriced: boolean;
  manual: boolean;
  chains: string[];
  lines: SpotHolding[];
}

export function spotGroups(spot: SpotHolding[]): SpotGroup[] {
  const groups = new Map<string, SpotGroup>();
  for (const holding of spot) {
    // Unpriced tokens share no price, so a ticker alone is not enough to merge them.
    const key = holding.unpriced ? `?${holding.symbol}:${holding.chain}` : holding.underlying;
    const group = groups.get(key) ?? {
      underlying: holding.unpriced ? holding.symbol : holding.underlying,
      kind: holding.kind,
      symbols: [],
      amount: 0,
      usd: 0,
      priceUsd: 0,
      unpriced: true,
      manual: false,
      chains: [],
      lines: [],
    };
    if (!group.symbols.includes(holding.symbol)) group.symbols.push(holding.symbol);
    if (!group.chains.includes(holding.chain)) group.chains.push(holding.chain);
    group.amount += holding.amount;
    group.usd += holding.usd;
    group.unpriced &&= holding.unpriced === true;
    group.manual ||= holding.source === "manual";
    group.lines.push(holding);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const priced = group.lines.filter((line) => !line.unpriced && line.amount > 0);
    const amount = priced.reduce((sum, line) => sum + line.amount, 0);
    group.priceUsd = amount > 0 ? priced.reduce((sum, line) => sum + line.usd, 0) / amount : 0;
    group.lines.sort((a, b) => b.usd - a.usd);
  }
  return [...groups.values()].sort((a, b) => Number(a.unpriced) - Number(b.unpriced) || b.usd - a.usd);
}

/** Net worth split into what the bar on Overview shows. Negative parts (net debt in apps) count as zero width. */
export function netWorthMix(parts: { lendingUsd: number; appsUsd: number; spotUsd: number }) {
  const segments = [
    { key: "lending", label: "Lending equity", usd: parts.lendingUsd },
    { key: "apps", label: "Other apps", usd: parts.appsUsd },
    { key: "spot", label: "Wallet balances", usd: parts.spotUsd },
  ] as const;
  const width = segments.reduce((sum, segment) => sum + Math.max(0, segment.usd), 0);
  return segments.map((segment) => ({ ...segment, share: width > 0 ? Math.max(0, segment.usd) / width : 0 }));
}
