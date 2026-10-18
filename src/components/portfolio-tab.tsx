"use client";

import { useState } from "react";
import { HistoryIcon, ShieldCheckIcon } from "lucide-react";
import { formatAmount, formatHealth, formatPercent, formatPrice, formatUsd } from "@/lib/format";
import { changeOver, pointsInRange, RANGES, type HistoryPoint, type RangeId } from "@/lib/history";
import type { BookRow } from "@/lib/metrics";
import { assetSlices, bookTotals, borrowPowerUsed, type AssetSlice } from "@/lib/overview";
import { liquidationLine } from "@/lib/position-view";
import { positionAppName, type SpotHolding, type Thresholds } from "@/lib/types";
import { NetWorthChart } from "@/components/net-worth-chart";
import { AssetBadge, Meter, Num, Panel, SectionLabel } from "@/components/ledger-ui";
import { CushionBar, cushionTone, TONE_TEXT } from "@/components/position-ui";
import { cn } from "cn";

/** Categorical slots in fixed order; a sixth asset onward folds into "Other". */
const SLOT_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
const OTHER_COLOR = "var(--chart-other)";

export function PortfolioTab({
  rows,
  spot,
  btcDelta,
  history,
  example,
  positions,
  risk,
  thresholds,
  onOpenPosition,
}: {
  rows: BookRow[];
  spot: SpotHolding[];
  btcDelta: number;
  history: HistoryPoint[];
  example: boolean;
  /** Position cards, rendered by the dashboard that owns their edit state. */
  positions: React.ReactNode;
  /** Stress test and alert panels. */
  risk: React.ReactNode;
  thresholds: Thresholds;
  onOpenPosition: (positionId: string) => void;
}) {
  const [range, setRange] = useState<RangeId>("30d");
  const totals = bookTotals(rows, spot);
  const inView = pointsInRange(history, range);
  const change = changeOver(inView);
  const power = borrowPowerUsed(rows);
  const liquidations = rows
    .filter((row) => row.metrics.liquidationPriceUsd != null)
    .sort((a, b) => (a.metrics.liquidationDistance ?? Infinity) - (b.metrics.liquidationDistance ?? Infinity));
  // Books with debt that no price of their main asset can liquidate: the same asset on both sides.
  const hedged = rows.filter((row) => row.metrics.liquidationSide === "never");

  return (
    <div className="grid grid-cols-1 gap-5">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel className="grid grid-cols-1 gap-4 lg:col-span-2">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <SectionLabel>Net worth{example ? " · example" : ""}</SectionLabel>
              <Num className="mt-1 block text-3xl font-semibold">{formatUsd(totals.netWorthUsd)}</Num>
              <p className="mt-1 text-xs text-muted-foreground">
                {change == null ? (
                  "Change shows once two readings are in range"
                ) : (
                  <>
                    <span className={change >= 0 ? "text-azure" : "text-destructive"}>
                      {change >= 0 ? "+" : "−"}
                      {formatPercent(Math.abs(change))}
                    </span>{" "}
                    over {RANGES.find((r) => r.id === range)?.label}
                  </>
                )}
              </p>
            </div>
            <div className="flex rounded-lg bg-muted p-0.5" role="group" aria-label="Chart range">
              {RANGES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={range === option.id}
                  onClick={() => setRange(option.id)}
                  className={cn(
                    "rounded-md px-2.5 py-1 font-mono text-xs",
                    range === option.id ? "bg-card text-foreground shadow" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </header>
          <NetWorthChart points={inView} />
          <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-3">
            <MiniStat label="Interest earned" value={formatUsd(totals.yearlyIncomeUsd)} hint="per year on open supplies" className="text-azure" />
            <MiniStat label="Interest owed" value={formatUsd(totals.yearlyCostUsd)} hint="per year on open borrows" className="text-gold" />
            <MiniStat label="BTC delta" value={formatAmount(btcDelta)} hint="net BTC exposure, spot included" />
          </div>
        </Panel>

        <Panel className="grid grid-cols-1 content-start gap-5">
          <SectionLabel>Position risk</SectionLabel>
          {power ? (
            <div className="grid grid-cols-1 gap-2">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span>Borrowing power used</span>
                <Num className={power.used >= 0.8 ? "text-destructive" : power.used >= 0.6 ? "text-gold" : "text-azure"}>
                  {formatPercent(power.used)}
                </Num>
              </div>
              <Meter value={power.used} tone={power.used >= 0.8 ? "destructive" : power.used >= 0.6 ? "gold" : "azure"} />
              <p className="flex justify-between font-mono text-xs text-muted-foreground">
                <span>
                  {formatUsd(power.borrowedUsd)} of {formatUsd(power.limitUsd)}
                </span>
                <span>{formatUsd(Math.max(0, power.limitUsd - power.borrowedUsd))} left</span>
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No collateral in this view.</p>
          )}
          <div className="grid grid-cols-1 gap-3">
            <SectionLabel>Room before liquidation</SectionLabel>
            {liquidations.length === 0 && hedged.length === 0 ? (
              <p className="text-sm text-muted-foreground">No borrowing position to show.</p>
            ) : null}
            {liquidations.map(({ position, metrics }) => {
              const line = liquidationLine(metrics);
              if (!line) return null;
              const tone = cushionTone(line.distance, thresholds.liquidationProximity);
              return (
                <button
                  key={position.id}
                  type="button"
                  onClick={() => onOpenPosition(position.id)}
                  className="-mx-2 grid grid-cols-1 gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted/40"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-sm font-medium" title={position.label}>
                      {positionAppName(position)} <span className="font-normal text-muted-foreground">· {position.chain}</span>
                    </span>
                    <Num className={cn("text-sm font-semibold", TONE_TEXT[tone])}>
                      {line.side === "below" ? "−" : "+"}
                      {formatPercent(line.distance, 0)}
                    </Num>
                  </span>
                  <CushionBar distance={line.distance} proximity={thresholds.liquidationProximity} compact />
                  <span className="flex justify-between gap-3 font-mono text-xs text-muted-foreground">
                    <span>HF {metrics.healthFactor == null ? "—" : formatHealth(metrics.healthFactor)}</span>
                    <span className="truncate">
                      {metrics.liquidationPrices.map((asset) => `${asset.underlying} ${formatPrice(asset.liquidationUsd)}`).join(" · ")}
                    </span>
                  </span>
                </button>
              );
            })}
            {hedged.map(({ position, metrics }) => (
              <button
                key={position.id}
                type="button"
                onClick={() => onOpenPosition(position.id)}
                className="-mx-2 grid grid-cols-1 gap-1.5 rounded-lg px-2 py-1.5 text-left hover:bg-muted/40"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm font-medium" title={position.label}>
                    {positionAppName(position)} <span className="font-normal text-muted-foreground">· {position.chain}</span>
                  </span>
                  <span className="flex items-center gap-1 text-sm text-azure">
                    <ShieldCheckIcon className="size-3.5" aria-hidden /> Any price
                  </span>
                </span>
                <span className="h-1.5 rounded-full bg-azure/25" aria-hidden />
                <span className="font-mono text-xs text-muted-foreground">
                  HF {metrics.healthFactor == null ? "—" : formatHealth(metrics.healthFactor)} · crypto debt covered by the same asset supplied
                </span>
              </button>
            ))}
            <p className="text-xs text-muted-foreground">
              Room is how far every crypto asset in the book can move together, stables held still, before the book is liquidated;
              the prices are each asset at that point. Open a position for the one-asset and depeg case.
            </p>
          </div>
        </Panel>
      </div>

      <AssetsPanel slices={assetSlices(rows, spot)} />

      {positions}

      {risk}

      <Panel className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <HistoryIcon className="size-5 text-muted-foreground" aria-hidden />
          <div>
            <SectionLabel>Transaction history</SectionLabel>
            <p className="mt-1 text-sm text-muted-foreground">Supplies, borrows, repays and transfers across every wallet, in one list.</p>
          </div>
        </div>
        <span className="rounded-full border border-gold/40 bg-gold/10 px-3 py-1 text-xs font-medium text-gold">Coming soon</span>
      </Panel>
    </div>
  );
}

function MiniStat({ label, value, hint, className }: { label: string; value: string; hint: string; className?: string }) {
  return (
    <div>
      <SectionLabel>{label}</SectionLabel>
      <Num className={cn("mt-1 block text-lg font-semibold", className)}>{value}</Num>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function colorFor(index: number) {
  return SLOT_COLORS[index] ?? OTHER_COLOR;
}

/** One bar per side, segmented by asset, then the per-asset table. */
function AssetsPanel({ slices }: { slices: AssetSlice[] }) {
  const [all, setAll] = useState(false);
  const supplied = slices.reduce((sum, s) => sum + s.suppliedUsd, 0);
  const borrowed = slices.reduce((sum, s) => sum + s.borrowedUsd, 0);
  const scale = Math.max(supplied, borrowed, 1);
  const gross = slices.reduce((sum, s) => sum + s.suppliedUsd + s.borrowedUsd + s.spotUsd, 0) || 1;
  const named = slices.slice(0, SLOT_COLORS.length);
  const rest = slices.slice(SLOT_COLORS.length);
  const legend = [
    ...named.map((s, i) => ({ key: s.underlying, color: colorFor(i) })),
    ...(rest.length ? [{ key: "Other", color: OTHER_COLOR }] : []),
  ];

  function bar(label: string, total: number, side: "suppliedUsd" | "borrowedUsd") {
    const parts = [
      ...named.map((s, i) => ({ key: s.underlying, usd: s[side], color: colorFor(i) })),
      { key: "Other", usd: rest.reduce((sum, s) => sum + s[side], 0), color: OTHER_COLOR },
    ].filter((part) => part.usd > 0);
    return (
      <div className="grid grid-cols-[72px_1fr_auto] items-center gap-3">
        <span className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">{label}</span>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" style={{ width: `${(total / scale) * 100}%`, minWidth: total > 0 ? 8 : 0 }}>
          {parts.map((part, i) => (
            <div
              key={part.key}
              title={`${part.key} ${formatUsd(part.usd)}`}
              style={{ width: `${(part.usd / total) * 100}%`, background: part.color, marginLeft: i ? 2 : 0 }}
            />
          ))}
        </div>
        <Num className="text-xs">{formatUsd(total)}</Num>
      </div>
    );
  }

  return (
    <Panel className="grid grid-cols-1 gap-4 p-0 pt-5">
      <header className="flex flex-wrap items-center justify-between gap-3 px-5">
        <SectionLabel>Assets</SectionLabel>
        <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {legend.map((item) => (
            <li key={item.key} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: item.color }} aria-hidden />
              {item.key}
            </li>
          ))}
        </ul>
      </header>
      <div className="grid gap-2 px-5">
        {bar("Supplied", supplied, "suppliedUsd")}
        {bar("Borrowed", borrowed, "borrowedUsd")}
      </div>
      {slices.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">No assets in this view.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-y border-border text-left text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                <th className="px-5 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 font-medium">Supplied</th>
                <th className="px-3 py-2 font-medium">Supply APY</th>
                <th className="px-3 py-2 font-medium">Borrowed</th>
                <th className="px-3 py-2 font-medium">Borrow APY</th>
                <th className="px-3 py-2 font-medium">Spot</th>
                <th className="px-3 py-2 font-medium">Net value</th>
                <th className="px-5 py-2 font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {(all ? slices : slices.slice(0, ASSET_ROWS)).map((slice, i) => {
                const share = (slice.suppliedUsd + slice.borrowedUsd + slice.spotUsd) / gross;
                return (
                  <tr key={slice.underlying} className="border-b border-border/60 last:border-b-0 hover:bg-muted/40">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <AssetBadge symbol={slice.underlying} kind={slice.kind} />
                        <span className="font-medium">{slice.underlying}</span>
                      </div>
                    </td>
                    <td className="px-3 py-3"><Num>{slice.suppliedUsd ? formatUsd(slice.suppliedUsd) : "—"}</Num></td>
                    <td className="px-3 py-3 text-azure"><Num>{slice.supplyApy == null ? "—" : formatPercent(slice.supplyApy)}</Num></td>
                    <td className="px-3 py-3 text-gold"><Num>{slice.borrowedUsd ? formatUsd(slice.borrowedUsd) : "—"}</Num></td>
                    <td className="px-3 py-3 text-gold"><Num>{slice.borrowApy == null ? "—" : formatPercent(slice.borrowApy)}</Num></td>
                    <td className="px-3 py-3"><Num>{slice.spotUsd ? formatUsd(slice.spotUsd) : "—"}</Num></td>
                    <td className="px-3 py-3"><Num className="font-semibold">{formatUsd(slice.netUsd)}</Num></td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: colorFor(i) }} />
                        </div>
                        <Num className="text-xs text-muted-foreground">{formatPercent(share)}</Num>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {slices.length > ASSET_ROWS ? (
            <button type="button" className="w-full border-t border-border/60 px-5 py-2.5 text-left text-xs text-azure hover:bg-muted/40" onClick={() => setAll(!all)}>
              {all ? "Show fewer" : `Show all ${slices.length}`}
            </button>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

const ASSET_ROWS = 12;
