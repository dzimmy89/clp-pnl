"use client";

import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ShieldCheckIcon } from "lucide-react";
import { formatAmount, formatHealth, formatLeverage, formatPercent, formatPrice, formatRatio, formatUsd, shortAddress } from "@/lib/format";
import type { BookRow } from "@/lib/metrics";
import { HEALTH_LABEL, weightedApy, type HealthTone } from "@/lib/overview";
import { healthOnScale, HEALTH_SCALE_MAX, liquidationLine, positionStory, positionTone } from "@/lib/position-view";
import { positionAppName, type Leg, type Thresholds } from "@/lib/types";
import { AssetBadge, Num } from "@/components/ledger-ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "cn";

export const TONE_TEXT: Record<HealthTone, string> = {
  healthy: "text-azure",
  monitor: "text-gold",
  risk: "text-destructive",
  critical: "text-destructive",
  none: "text-muted-foreground",
};

const TONE_BG: Record<HealthTone, string> = {
  healthy: "bg-azure",
  monitor: "bg-gold",
  risk: "bg-destructive/80",
  critical: "bg-destructive",
  none: "bg-muted-foreground/40",
};

/** Small rounded label naming how safe a position is. */
export function ToneChip({ tone, className }: { tone: HealthTone; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-medium", TONE_TEXT[tone], className)}>
      <span className={cn("size-1.5 rounded-full", TONE_BG[tone])} aria-hidden />
      {tone === "none" ? "No debt" : HEALTH_LABEL[tone]}
    </span>
  );
}

/** Overlapping token marks, like a pair icon. */
export function BadgeStack({ legs, max = 3 }: { legs: Pick<Leg, "symbol" | "kind">[]; max?: number }) {
  const seen = new Set<string>();
  const unique = legs.filter((leg) => !seen.has(leg.symbol) && seen.add(leg.symbol));
  return (
    <span className="flex shrink-0 -space-x-2.5" aria-hidden>
      {unique.slice(0, max).map((leg) => (
        <span key={leg.symbol} className="rounded-full ring-2 ring-card">
          <AssetBadge symbol={leg.symbol} kind={leg.kind} />
        </span>
      ))}
    </span>
  );
}

/**
 * Health factor on a track from liquidation (1.0) to 3.0+, shaded by the alert zones, with a
 * marker where the position sits today.
 */
export function HealthBar({
  value,
  thresholds,
  compact = false,
  className,
}: {
  value: number | null;
  thresholds: Thresholds;
  compact?: boolean;
  className?: string;
}) {
  const zones = [
    { tone: "critical" as const, from: 1, to: thresholds.healthCritical },
    { tone: "risk" as const, from: thresholds.healthCritical, to: thresholds.healthWarning },
    { tone: "monitor" as const, from: thresholds.healthWarning, to: 2 },
    { tone: "healthy" as const, from: 2, to: HEALTH_SCALE_MAX },
  ].filter((zone) => zone.to > zone.from);
  const at = value == null ? null : healthOnScale(value);
  return (
    <div className={cn("relative", compact ? "h-1.5" : "h-2", className)} role="img" aria-label={value == null ? "No health factor" : `Health factor ${formatHealth(value)}`}>
      <div className="absolute inset-0 flex gap-px overflow-hidden rounded-full">
        {zones.map((zone) => (
          <div
            key={zone.tone}
            className={cn(TONE_BG[zone.tone], "opacity-25")}
            style={{ width: `${((Math.min(zone.to, HEALTH_SCALE_MAX) - zone.from) / (HEALTH_SCALE_MAX - 1)) * 100}%` }}
          />
        ))}
      </div>
      {at != null ? (
        <>
          <div className={cn("absolute inset-y-0 left-0 rounded-full", TONE_BG[zoneOf(value!, thresholds)])} style={{ width: `${at * 100}%` }} />
          <div
            className={cn("absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card bg-foreground", compact ? "size-2.5" : "size-3.5")}
            style={{ left: `${at * 100}%` }}
          />
        </>
      ) : null}
    </div>
  );
}

function zoneOf(value: number, thresholds: Thresholds): HealthTone {
  if (value < thresholds.healthCritical) return "critical";
  if (value < thresholds.healthWarning) return "risk";
  if (value < 2) return "monitor";
  return "healthy";
}

/** Cushion colour: red inside the alert distance, gold inside twice it, blue beyond. */
export function cushionTone(distance: number, proximity: number): HealthTone {
  if (distance < proximity) return "critical";
  if (distance < proximity * 2) return "monitor";
  return "healthy";
}

/**
 * How far crypto can move before liquidation, drawn as a cushion: the filled part is the room
 * left, out of a 100% move.
 */
export function CushionBar({ distance, proximity, compact = false }: { distance: number; proximity: number; compact?: boolean }) {
  const tone = cushionTone(distance, proximity);
  return (
    <div className={cn("w-full overflow-hidden rounded-full bg-muted", compact ? "h-1.5" : "h-2")} aria-hidden>
      <div className={cn("h-full rounded-full", TONE_BG[tone])} style={{ width: `${Math.max(2, Math.min(1, distance) * 100)}%` }} />
    </div>
  );
}

/** Debt against collateral as one bar: gold for what is borrowed, blue for the equity left. */
export function BalanceSplit({ supplyUsd, borrowUsd }: { supplyUsd: number; borrowUsd: number }) {
  if (!(supplyUsd > 0)) return null;
  const debt = Math.min(1, borrowUsd / supplyUsd);
  return (
    <div className="grid gap-1.5">
      <div className="flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        {debt > 0 ? <div className="bg-gold" style={{ width: `${debt * 100}%` }} /> : null}
        {debt < 1 ? <div className="flex-1 bg-azure" /> : null}
      </div>
      <p className="flex justify-between text-[11px] text-muted-foreground">
        <span>
          <span className="text-gold">Borrowed</span> {formatPercent(debt, 0)} of collateral
        </span>
        <span>
          <span className="text-azure">Yours</span> {formatPercent(1 - debt, 0)}
        </span>
      </p>
    </div>
  );
}

function LegColumn({ title, legs, side }: { title: string; legs: Leg[]; side: Leg["side"] }) {
  const total = legs.reduce((sum, leg) => sum + leg.usd, 0);
  const apy = weightedApy(legs);
  const color = side === "supply" ? "text-azure" : "text-gold";
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-background/40">
      <header className="flex items-baseline justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className={cn("flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] uppercase", color)}>
          {side === "supply" ? <ArrowUpIcon className="size-3" aria-hidden /> : <ArrowDownIcon className="size-3" aria-hidden />}
          {title}
        </span>
        <span className="text-xs text-muted-foreground">
          <Num className="text-foreground">{formatUsd(total)}</Num>
          {apy != null ? ` · ${formatPercent(apy)}` : ""}
        </span>
      </header>
      {legs.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">Nothing {side === "supply" ? "supplied" : "borrowed"}.</p>
      ) : (
        <ul className="divide-y divide-border/50">
          {legs.map((leg) => (
            <li key={leg.id} className="flex items-center gap-2.5 px-3 py-2">
              <AssetBadge symbol={leg.symbol} kind={leg.kind} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{leg.symbol}</p>
                <Num className="block truncate text-xs text-muted-foreground">
                  {formatAmount(leg.amount)}
                  {leg.side === "supply" && leg.isCollateral === false ? " · not collateral" : ""}
                </Num>
              </div>
              <div className="text-right">
                <Num className="block text-sm">{formatUsd(leg.usd)}</Num>
                <Num className={cn("block text-xs", color)}>{leg.apyUnknown ? "APY —" : formatPercent(leg.apy)}</Num>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sourceLabel(source: string): string {
  return source === "example" ? "Example" : source === "manual" ? "Manual" : "Live";
}

/** One lending book: what it holds, what it earns, how safe it is, and the detail behind each. */
export function PositionCard({
  row,
  thresholds,
  target,
  onTarget,
  onEdit,
  onDelete,
}: {
  row: BookRow;
  thresholds: Thresholds;
  target: number;
  onTarget: (value: number) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const { position, metrics } = row;
  const app = positionAppName(position);
  const tone = positionTone(metrics, thresholds);
  const story = positionStory(metrics);
  const line = liquidationLine(metrics);
  const supplies = position.legs.filter((leg) => leg.side === "supply");
  const borrows = position.legs.filter((leg) => leg.side === "borrow");
  const solo =
    metrics.liquidationPrices.length > 1 && metrics.primaryUnderlying && metrics.soloLiquidationDistance != null
      ? { price: metrics.soloLiquidationPriceUsd, distance: metrics.soloLiquidationDistance, side: metrics.soloLiquidationSide }
      : null;
  const hasDebt = metrics.borrowUsd > 0;

  return (
    <article
      id={`position-${position.id}`}
      className={cn(
        "relative min-w-0 scroll-mt-24 overflow-hidden rounded-2xl border bg-card/90",
        position.source === "example" ? "border-dashed border-gold/40" : "border-border",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", TONE_BG[tone])} aria-hidden />
      <header className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 pl-6">
        <div className="flex min-w-0 items-center gap-3">
          <BadgeStack legs={supplies.length ? supplies : position.legs} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">{app}</h3>
              <span className="text-sm text-muted-foreground">{position.chain}</span>
              <ToneChip tone={tone} />
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={position.label}>
              {sourceLabel(position.source)} · <span className="font-mono">{shortAddress(position.wallet)}</span> · {position.label}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">Your equity</p>
          <Num className={cn("block text-2xl font-semibold", metrics.underwater && "text-destructive")}>{formatUsd(metrics.equity)}</Num>
          <Num className={cn("block text-xs", metrics.netApy == null ? "text-muted-foreground" : metrics.netApy >= 0 ? "text-azure" : "text-destructive")}>
            {metrics.underwater ? "Underwater" : metrics.netApy == null ? "Net APY —" : `${formatPercent(metrics.netApy)} net APY`}
          </Num>
        </div>
      </header>

      <p className="px-5 pt-3 pl-6 text-sm leading-relaxed text-muted-foreground">
        {story.holds} {story.earns}{" "}
        <span className={cn(tone === "risk" || tone === "critical" ? "text-destructive" : "text-foreground/90")}>{story.risk}</span>
      </p>

      <div className="grid gap-3 px-5 pt-4 pl-6 md:grid-cols-2">
        <LegColumn title="Supplied" legs={supplies} side="supply" />
        <LegColumn title="Borrowed" legs={borrows} side="borrow" />
      </div>

      {hasDebt ? (
        <div className="grid gap-4 px-5 pt-4 pl-6 md:grid-cols-3">
          <div className="grid content-start gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-muted-foreground">{metrics.healthFactorSource === "estimated" ? "Health factor (est.)" : "Health factor"}</span>
              <Num className={cn("text-lg font-semibold", TONE_TEXT[tone])}>{metrics.healthFactor == null ? "—" : formatHealth(metrics.healthFactor)}</Num>
            </div>
            <HealthBar value={metrics.healthFactor} thresholds={thresholds} />
            <p className="flex justify-between text-[11px] text-muted-foreground">
              <span>1.0 liquidates</span>
              <span>{HEALTH_SCALE_MAX.toFixed(1)}+</span>
            </p>
          </div>
          <div className="grid content-start gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-muted-foreground">Room before liquidation</span>
              {line ? (
                <Num className={cn("text-lg font-semibold", TONE_TEXT[cushionTone(line.distance, thresholds.liquidationProximity)])}>
                  {line.side === "below" ? "−" : "+"}
                  {formatPercent(line.distance, 0)}
                </Num>
              ) : (
                <span className="flex items-center gap-1 text-sm text-azure">
                  <ShieldCheckIcon className="size-4" aria-hidden /> {metrics.liquidationSide === "never" ? "Any price" : "—"}
                </span>
              )}
            </div>
            {line ? <CushionBar distance={line.distance} proximity={thresholds.liquidationProximity} /> : <div className="h-2 rounded-full bg-azure/25" aria-hidden />}
            <p className="text-[11px] text-muted-foreground">
              {line && line.asset && line.liquidationUsd != null && line.priceUsd != null ? (
                <>
                  {line.asset} <Num>{formatPrice(line.priceUsd)}</Num> now → <Num className="text-foreground">{formatPrice(line.liquidationUsd)}</Num>
                </>
              ) : line ? (
                "Every crypto asset moving together"
              ) : (
                "Same-asset debt is covered by what is supplied"
              )}
            </p>
          </div>
          <div className="grid content-start gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-muted-foreground">Leverage</span>
              <Num className="text-lg font-semibold">{metrics.leverage == null ? "Underwater" : formatLeverage(metrics.leverage)}</Num>
            </div>
            <BalanceSplit supplyUsd={metrics.supplyUsd} borrowUsd={metrics.borrowUsd} />
          </div>
        </div>
      ) : null}

      {onEdit || onDelete ? (
        <div className="flex gap-2 px-5 pt-4 pl-6">
          {onEdit ? (
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              Edit book
            </Button>
          ) : null}
          {onDelete ? (
            <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}

      <details className="group mx-5 mt-4 ml-6 border-t border-border/60">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 py-3 text-xs text-muted-foreground hover:text-foreground">
          <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
          Hedge and detail
        </summary>
        <div className="grid gap-4 pb-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Detail label="Notional hedge" value={metrics.notionalHedgeRatio == null ? "—" : formatRatio(metrics.notionalHedgeRatio)} />
            <Detail label="BTC delta" value={formatAmount(metrics.btcDelta)} />
            <Detail
              label="Unit hedge"
              value={metrics.hedges.length ? metrics.hedges.map((hedge) => `${hedge.underlying} ${hedge.ratio == null ? "n/a" : formatRatio(hedge.ratio)}`).join(" · ") : "—"}
            />
            <div className="grid gap-1">
              <label htmlFor={`target-${position.id}`} className="text-xs text-muted-foreground">
                Target hedge
              </label>
              <Input
                id={`target-${position.id}`}
                inputMode="decimal"
                className="h-8"
                defaultValue={String(target)}
                key={`${position.id}-${target}`}
                onBlur={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isFinite(next)) onTarget(next);
                }}
              />
            </div>
          </dl>
          {line && metrics.liquidationPrices.length > 1 ? (
            <div className="grid gap-1 text-xs text-muted-foreground">
              <p>Liquidation prices when every crypto asset moves {formatPercent(line.distance, 0)} together:</p>
              <p className="flex flex-wrap gap-x-4 gap-y-1">
                {metrics.liquidationPrices.map((asset) => (
                  <Num key={asset.underlying} className="text-foreground">
                    {asset.underlying} {formatPrice(asset.liquidationUsd)}
                  </Num>
                ))}
              </p>
            </div>
          ) : null}
          {solo ? (
            <p className="text-xs text-muted-foreground">
              {metrics.primaryUnderlying} alone, rest unchanged:{" "}
              {solo.side === "never" || solo.price == null ? (
                "no price liquidates it"
              ) : (
                <Num className="text-foreground">
                  {formatPrice(solo.price)} ({solo.side === "above" ? "+" : "−"}
                  {formatPercent(solo.distance, 0)})
                </Num>
              )}
              . For a staked token against its base asset this is the depeg case.
            </p>
          ) : null}
          {metrics.assumedThreshold && hasDebt ? (
            <p className="text-xs text-muted-foreground">
              Some liquidation thresholds are assumed (75% volatile, 78% BTC, 80% stables)
              {metrics.healthFactorSource === "protocol" ? ", scaled to the health factor the protocol reports" : ""}.
            </p>
          ) : null}
          {position.note ? <p className="text-xs text-muted-foreground">{position.note}</p> : null}
        </div>
      </details>
    </article>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}
