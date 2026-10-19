"use client";

import { useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, GaugeIcon, LayersIcon, TriangleAlertIcon, WalletIcon } from "lucide-react";
import type { DeskAlert } from "@/lib/alerts";
import {
  formatAmount,
  formatHealth,
  formatPercent,
  formatPrice,
  formatUsd,
  shortAddress,
  signedUsd,
} from "@/lib/format";
import { changeSince, type HistoryPoint } from "@/lib/history";
import type { BookRow } from "@/lib/metrics";
import {
  bookTotals,
  healthTone,
  legRows,
  lowestHealth,
  weightedApy,
  type LegRow,
} from "@/lib/overview";
import { netWorthMix, riskRows, spotGroups, type RiskRow, type SpotGroup } from "@/lib/position-view";
import type { SpotHolding, Thresholds } from "@/lib/types";
import { appGroups, isLending, positionNetUsd, TYPE_LABEL, categoryOf, type AppGroup } from "@/lib/view-filter";
import { AssetBadge, Num, Panel, SectionLabel, Skeleton } from "@/components/ledger-ui";
import { BadgeStack, CushionBar, HealthBar, TONE_TEXT, ToneChip } from "@/components/position-ui";
import { cn } from "cn";

export function OverviewTab({
  rows,
  spot,
  loading = false,
  alerts,
  blendedApy,
  thresholds,
  example,
  history,
  hideDust,
  onHideDust,
  onOpenAlerts,
  onPickApp,
  onOpenPosition,
}: {
  rows: BookRow[];
  spot: SpotHolding[];
  /** The first live read is still in flight: headline numbers show placeholders instead of zeros. */
  loading?: boolean;
  alerts: DeskAlert[];
  blendedApy: number | null;
  thresholds: Thresholds;
  example: boolean;
  /** Net worth readings for the wallets in view; empty when a filter makes them incomparable. */
  history: HistoryPoint[];
  hideDust: boolean;
  onHideDust: (hide: boolean) => void;
  onOpenAlerts: () => void;
  onPickApp: (app: string) => void;
  onOpenPosition: (positionId: string) => void;
}) {
  const totals = bookTotals(rows, spot);
  const lending = rows.filter((row) => isLending(row.position));
  const health = lowestHealth(rows);
  const tone = healthTone(health?.value, thresholds);
  const supplies = legRows(lending, "supply");
  const borrows = legRows(lending, "borrow");
  const apps = appGroups(rows.map((row) => row.position));
  const mix = netWorthMix({ lendingUsd: totals.suppliedUsd - totals.borrowedUsd, appsUsd: totals.appsUsd, spotUsd: totals.spotUsd });
  const risks = riskRows(rows, thresholds);
  const day = changeSince(history, totals.netWorthUsd, DAY_MS);

  return (
    <div className="grid grid-cols-1 gap-5">
      <Panel className="grid gap-0 p-0 sm:grid-cols-2 lg:grid-cols-5 lg:divide-x lg:divide-border">
        <Stat label="Net worth">
          <Num className="text-3xl font-semibold">
            {loading ? <Skeleton className="w-40" label="Loading net worth" /> : formatUsd(totals.netWorthUsd)}
          </Num>
          {day ? (
            <p className="mt-1 text-xs" title={`Compared with ${new Date(day.since).toLocaleString("en-US")}`}>
              <Num className={day.usd >= 0 ? "text-azure" : "text-destructive"}>
                {signedUsd(day.usd)}
                {day.pct == null ? "" : ` (${day.usd >= 0 ? "+" : "−"}${formatPercent(Math.abs(day.pct))})`}
              </Num>{" "}
              <span className="text-muted-foreground">{sinceLabel(day.since)}</span>
            </p>
          ) : null}
          <div className="mt-3 flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            {mix.map((part) =>
              part.share > 0 ? <div key={part.key} className={MIX_COLOR[part.key]} style={{ width: `${part.share * 100}%` }} /> : null,
            )}
          </div>
          <ul className="mt-2 grid gap-0.5 text-xs text-muted-foreground">
            {mix.map((part) => (
              <li key={part.key} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-sm", MIX_COLOR[part.key])} aria-hidden />
                  {part.label}
                </span>
                <Num className="text-foreground/80">{formatUsd(part.usd)}</Num>
              </li>
            ))}
          </ul>
        </Stat>
        <Stat label="Supplied">
          <Num className="text-2xl font-semibold text-azure">
            {loading ? <Skeleton className="w-28" label="Loading supplied" /> : formatUsd(totals.suppliedUsd)}
          </Num>
          <p className="mt-1 text-xs text-muted-foreground">
            APY{" "}
            {totals.supplyApy == null ? "—" : formatPercent(totals.supplyApy)}
          </p>
        </Stat>
        <Stat label="Borrowed">
          <Num className="text-2xl font-semibold text-gold">
            {loading ? <Skeleton className="w-28" label="Loading borrowed" /> : formatUsd(totals.borrowedUsd)}
          </Num>
          <p className="mt-1 text-xs text-muted-foreground">
            APY{" "}
            {totals.borrowApy == null ? "—" : formatPercent(totals.borrowApy)}
          </p>
        </Stat>
        <Stat label="Health factor">
          <div className="flex items-baseline gap-2">
            <Num className={cn("text-2xl font-semibold", TONE_TEXT[tone])}>
              {loading ? <Skeleton className="w-16" label="Loading health factor" /> : health ? formatHealth(health.value) : "—"}
            </Num>
            {loading ? null : <ToneChip tone={tone} />}
          </div>
          {health ? (
            <>
              <HealthBar className="mt-3" value={health.value} thresholds={thresholds} />
              <p className="mt-2 truncate text-xs text-muted-foreground" title={health.label}>
                Lowest: {health.label}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">No open debt</p>
          )}
        </Stat>
        <Stat label="Net APY">
          <Num className="text-2xl font-semibold">
            {loading ? <Skeleton className="w-20" label="Loading net APY" /> : blendedApy == null ? "—" : formatPercent(blendedApy)}
          </Num>
          <p className="mt-1 text-xs text-muted-foreground">
            Carry {formatUsd(totals.yearlyIncomeUsd - totals.yearlyCostUsd)} /
            year
          </p>
        </Stat>
      </Panel>

      {example ? (
        <Banner>
          <span className="font-semibold text-gold">Example book</span> —
          illustrative positions with fixed marks. Sign in with a wallet or
          paste an address in Wallets to see your own.
        </Banner>
      ) : alerts.length > 0 ? (
        <Banner>
          <TriangleAlertIcon
            className="size-4 shrink-0 text-gold"
            aria-hidden
          />
          <span>
            <span className="font-semibold text-gold">
              {alerts.length} alert{alerts.length === 1 ? "" : "s"}
            </span>{" "}
            — {alerts[0].sentence}{" "}
            <button
              type="button"
              className="text-azure underline-offset-2 hover:underline"
              onClick={onOpenAlerts}
            >
              Review in Portfolio
            </button>
          </span>
        </Banner>
      ) : null}

      {risks.length > 0 ? <RiskPanel risks={risks} thresholds={thresholds} onOpen={onOpenPosition} /> : null}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <LegTable
          title="Your supplies"
          tone="azure"
          lines={supplies}
          empty="Nothing supplied in this view."
        />
        <LegTable
          title="Your borrows"
          tone="gold"
          lines={borrows}
          empty="No open borrows."
        />
      </div>

      <AppsTable groups={apps} onPickApp={onPickApp} />

      <SpotTable spot={spot} hideDust={hideDust} onHideDust={onHideDust} />
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

const MIX_COLOR = { lending: "bg-azure", apps: "bg-chart-3", spot: "bg-gold" } as const;

/** Every book with debt on one list, worst first: how healthy it is and how much room it has. */
function RiskPanel({ risks, thresholds, onOpen }: { risks: RiskRow[]; thresholds: Thresholds; onOpen: (positionId: string) => void }) {
  return (
    <Panel className="p-0">
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-3">
        <SectionLabel className="flex items-center gap-2">
          <GaugeIcon className="size-3.5" aria-hidden /> Borrowing positions
        </SectionLabel>
        <p className="text-xs text-muted-foreground">Riskiest first · room is how far crypto can move together before liquidation</p>
      </header>
      <ul>
        {risks.map(({ row, app, tone, line }) => {
          const { position, metrics } = row;
          return (
            <li key={position.id} className="border-t border-border/60">
              <button
                type="button"
                onClick={() => onOpen(position.id)}
                className="grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-3 px-5 py-3 text-left hover:bg-muted/40 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <BadgeStack legs={position.legs} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">{app}</span>
                      <ToneChip tone={tone} className="hidden sm:inline-flex" />
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {position.chain} · {shortAddress(position.wallet)}
                    </span>
                  </span>
                </span>
                <span className="text-right md:text-left">
                  <Num className="block">{formatUsd(metrics.equity)}</Num>
                  <span className="text-xs text-muted-foreground">
                    equity · debt <Num>{formatUsd(metrics.borrowUsd)}</Num>
                  </span>
                </span>
                <span className="grid gap-1.5">
                  <span className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                    Health
                    <Num className={cn("text-sm font-semibold", TONE_TEXT[tone])}>
                      {metrics.healthFactor == null ? "—" : formatHealth(metrics.healthFactor)}
                    </Num>
                  </span>
                  <HealthBar value={metrics.healthFactor} thresholds={thresholds} compact />
                </span>
                <span className="grid gap-1.5">
                  <span className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                    Room
                    <Num className="text-sm font-semibold text-foreground">
                      {line ? `${line.side === "below" ? "−" : "+"}${formatPercent(line.distance, 0)}` : metrics.liquidationSide === "never" ? "Any move" : "—"}
                    </Num>
                  </span>
                  {line ? <CushionBar distance={line.distance} proximity={thresholds.liquidationProximity} compact /> : <span className="h-1.5 rounded-full bg-azure/25" aria-hidden />}
                </span>
                <ChevronRightIcon className="hidden size-4 text-muted-foreground md:block" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** "24h" when the reading compared against is about a day old, else how old it is. */
function sinceLabel(since: number, now = Date.now()): string {
  const hours = (now - since) / (60 * 60 * 1000);
  if (Math.abs(hours - 24) <= 3) return "24h";
  return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

/** Spot balances worth less than this hide with "Hide small balances". */
const DUST_USD = 1;

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-border p-5 last:border-b-0 lg:border-b-0">
      <SectionLabel className="mb-2">{label}</SectionLabel>
      {children}
    </div>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 rounded-xl border border-gold/30 bg-gold/5 px-4 py-2.5 text-sm">
      {children}
    </p>
  );
}

function LegTable({
  title,
  tone,
  lines,
  empty,
}: {
  title: string;
  tone: "azure" | "gold";
  lines: LegRow[];
  empty: string;
}) {
  const [all, setAll] = useState(false);
  const total = lines.reduce((sum, line) => sum + line.usd, 0);
  const weighted = weightedApy(lines);
  const shown = all ? lines : lines.slice(0, ROW_LIMIT);
  const color = tone === "azure" ? "text-azure" : "text-gold";
  return (
    <Panel className="p-0">
      <header className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
        <SectionLabel className={cn("flex items-center gap-2", color)}>
          {tone === "azure" ? <ArrowUpIcon className="size-3.5" aria-hidden /> : <ArrowDownIcon className="size-3.5" aria-hidden />} {title}
        </SectionLabel>
        <p className={cn("text-sm", color)}>
          <Num>{formatUsd(total)}</Num>
          {weighted != null ? (
            <span> · {formatPercent(weighted)} APY</span>
          ) : null}
        </p>
      </header>
      {lines.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[340px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                <th className="px-5 py-2 font-medium">Asset</th>
                <th className="px-3 py-2 font-medium">Balance</th>
                <th className="px-5 py-2 text-right font-medium">APY</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((line) => (
                <tr
                  key={line.key}
                  className="border-b border-border/60 last:border-b-0 hover:bg-muted/40"
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <AssetBadge symbol={line.symbol} kind={line.kind} />
                      <div className="min-w-0">
                        <p className="font-medium">{line.symbol}</p>
                        <p className="text-xs text-muted-foreground">
                          {line.protocol} · {line.chain}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Num className="block">{formatAmount(line.amount)}</Num>
                    <Num className="block text-xs text-muted-foreground">
                      {formatUsd(line.usd)}
                    </Num>
                    <div className="mt-1.5 h-1 w-24 overflow-hidden rounded-full bg-muted" title={`${formatPercent(total > 0 ? line.usd / total : 0)} of ${title.toLowerCase()}`}>
                      <div className={cn("h-full rounded-full", tone === "azure" ? "bg-azure/70" : "bg-gold/70")} style={{ width: `${total > 0 ? (line.usd / total) * 100 : 0}%` }} />
                    </div>
                  </td>
                  <td className={cn("px-5 py-3 text-right", color)}>
                    <Num>{line.apyUnknown ? "—" : formatPercent(line.apy)}</Num>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ShowAll total={lines.length} expanded={all} onToggle={() => setAll(!all)} />
        </div>
      )}
    </Panel>
  );
}

function SpotTable({ spot, hideDust, onHideDust }: { spot: SpotHolding[]; hideDust: boolean; onHideDust: (hide: boolean) => void }) {
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  // Balances entered by hand always show: someone typed them in on purpose.
  const isDust = (holding: SpotHolding) => holding.source !== "manual" && (holding.unpriced || holding.usd < DUST_USD);
  const dust = spot.filter(isDust).length;
  const needle = query.trim().toLowerCase();
  const visible = spot.filter(
    (holding) =>
      !(hideDust && isDust(holding)) &&
      (!needle || [holding.symbol, holding.underlying, holding.chain].some((text) => text.toLowerCase().includes(needle))),
  );
  // One row per asset across wallets and chains; unpriced tokens (often airdropped spam) sink to the end.
  const groups = spotGroups(visible);
  const shown = all ? groups : groups.slice(0, ROW_LIMIT);
  const visibleUsd = visible.reduce((sum, holding) => sum + Math.max(0, holding.usd), 0);
  const total = spot.reduce((sum, holding) => sum + holding.usd, 0);
  return (
    <Panel className="p-0">
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-3">
        <SectionLabel className="flex items-center gap-2">
          <WalletIcon className="size-3.5" aria-hidden /> Spot holdings
        </SectionLabel>
        <p className="text-sm text-muted-foreground">
          <Num>{formatUsd(total)}</Num> in wallets
        </p>
        {spot.length > 0 ? (
          <div className="flex w-full flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search token or chain"
              aria-label="Search spot holdings"
              className="h-7 w-48 rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus:border-azure focus:outline-none"
            />
            {dust > 0 ? (
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-[var(--gold)]"
                  checked={hideDust}
                  onChange={(event) => onHideDust(event.target.checked)}
                />
                Hide {dust} small or unpriced balance{dust === 1 ? "" : "s"} (under $1)
              </label>
            ) : null}
          </div>
        ) : null}
      </header>
      {groups.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">
          {spot.length === 0 ? "No spot balances in this view." : "No balances match."}
        </p>
      ) : (
        <div>
          <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 border-y border-border px-5 py-2 text-[11px] tracking-[0.12em] text-muted-foreground uppercase sm:grid">
            <span className="pl-7">Asset</span>
            <span>Price</span>
            <span className="text-right">Balance</span>
            <span>Share of wallets</span>
          </div>
          {shown.map((group) => (
            <SpotGroupRow key={`${group.underlying}:${group.lines[0].id}`} group={group} total={visibleUsd} />
          ))}
          <ShowAll total={groups.length} expanded={all} onToggle={() => setAll(!all)} />
        </div>
      )}
    </Panel>
  );
}

/** One asset across every wallet and chain; opening it lists where each balance sits. */
function SpotGroupRow({ group, total }: { group: SpotGroup; total: number }) {
  const share = total > 0 ? Math.max(0, group.usd) / total : 0;
  const many = group.lines.length > 1;
  const body = (
    <>
      <span className="flex min-w-0 items-center gap-3">
        <ChevronRightIcon
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90", !many && "invisible")}
          aria-hidden
        />
        <AssetBadge symbol={group.symbols[0] ?? group.underlying} kind={group.kind} />
        <span className="min-w-0">
          <span className="block truncate font-medium">
            {group.underlying}
            {group.manual ? <span className="ml-2 text-[11px] font-normal text-gold">by hand</span> : null}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {many ? `${group.lines.length} balances · ` : ""}
            {group.chains.join(", ")}
            {group.symbols.length > 1 || group.symbols[0] !== group.underlying ? ` · ${group.symbols.join(", ")}` : ""}
          </span>
        </span>
      </span>
      <Num className="hidden text-sm sm:block">{group.unpriced ? "—" : formatPrice(group.priceUsd)}</Num>
      <span className="text-right">
        <Num className="block">{formatAmount(group.amount)}</Num>
        <Num className="block text-xs text-muted-foreground">{group.unpriced ? "unpriced" : formatUsd(group.usd)}</Num>
      </span>
      <span className="hidden items-center gap-2 sm:flex">
        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-gold/80" style={{ width: `${share * 100}%` }} />
        </span>
        <Num className="w-14 text-right text-xs text-muted-foreground">{formatPercent(share, 1)}</Num>
      </span>
    </>
  );
  const grid =
    "grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1fr)]";
  if (!many) {
    return (
      <div className="group border-b border-border/60 last:border-b-0" title={`${group.lines[0].chain} · ${group.lines[0].wallet}`}>
        <div className={grid}>{body}</div>
      </div>
    );
  }
  return (
    <details className="group border-b border-border/60 last:border-b-0">
      <summary className={cn(grid, "cursor-pointer list-none hover:bg-muted/40")}>{body}</summary>
      <ul className="grid gap-1.5 pr-5 pb-3 pl-[4.25rem]">
        {group.lines.map((line) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-muted-foreground">
              {line.symbol} · {line.chain} · <span className="font-mono text-xs">{shortAddress(line.wallet)}</span>
            </span>
            <span className="shrink-0 text-right">
              <Num>{formatAmount(line.amount)}</Num>
              <Num className="ml-3 text-xs text-muted-foreground">{line.unpriced ? "unpriced" : formatUsd(line.usd)}</Num>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const ROW_LIMIT = 12;

function ShowAll({ total, expanded, onToggle }: { total: number; expanded: boolean; onToggle: () => void }) {
  if (total <= ROW_LIMIT) return null;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className="w-full border-t border-border/60 px-5 py-2.5 text-left text-xs text-azure transition-colors hover:bg-muted/40"
      onClick={onToggle}
    >
      {expanded ? "Show fewer" : `Show all ${total}`}
    </button>
  );
}

/** Every position grouped by app. Opening an app lists its positions; the name filters the book to it. */
function AppsTable({ groups, onPickApp }: { groups: AppGroup[]; onPickApp: (app: string) => void }) {
  const [all, setAll] = useState(false);
  const total = groups.reduce((sum, group) => sum + group.netUsd, 0);
  const shown = all ? groups : groups.slice(0, ROW_LIMIT);
  return (
    <Panel className="p-0">
      <header className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
        <SectionLabel className="flex items-center gap-2">
          <LayersIcon className="size-3.5" aria-hidden /> Apps
        </SectionLabel>
        <p className="text-sm text-muted-foreground">
          <Num>{formatUsd(total)}</Num> in {groups.length} app{groups.length === 1 ? "" : "s"}
        </p>
      </header>
      {groups.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">No app positions in this view.</p>
      ) : (
        <div>
          {shown.map((group) => (
            <details key={group.app} className="group border-t border-border/60">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3 hover:bg-muted/40">
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{group.app}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {group.types.map((type) => TYPE_LABEL[type]).join(", ")} · {group.chains.join(", ")}
                  </p>
                </div>
                <div className="text-right">
                  <Num className="block">{formatUsd(group.netUsd)}</Num>
                  <span className="text-xs text-muted-foreground">
                    {group.positions.length} position{group.positions.length === 1 ? "" : "s"}
                  </span>
                </div>
              </summary>
              <ul className="grid gap-1 px-5 pb-3 pl-12">
                {group.positions.map((position) => (
                  <li key={position.id} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate">
                        {position.legs.map((leg) => `${leg.side === "borrow" ? "−" : ""}${formatAmount(leg.amount)} ${leg.symbol}`).join(" · ")}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {TYPE_LABEL[categoryOf(position)]} · {position.chain} · {shortAddress(position.wallet)}
                      </span>
                    </span>
                    <Num className="shrink-0">{formatUsd(positionNetUsd(position))}</Num>
                  </li>
                ))}
                <li>
                  <button type="button" className="min-h-6 text-xs text-azure hover:underline" onClick={() => onPickApp(group.app)}>
                    Show only {group.app}
                  </button>
                </li>
              </ul>
            </details>
          ))}
          <ShowAll total={groups.length} expanded={all} onToggle={() => setAll(!all)} />
        </div>
      )}
    </Panel>
  );
}
