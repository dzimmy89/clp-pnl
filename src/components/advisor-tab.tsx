"use client";

import { CircleAlertIcon, LightbulbIcon, ShieldAlertIcon } from "lucide-react";
import { betaRows, suggest, type Goals, type Suggestion } from "@/lib/advisor";
import { betaOf, bookBeta, betaBase, spotBeta, BETA_WINDOW_DAYS, type BetaBook } from "@/lib/beta";
import { formatAmount, formatHealth, formatLeverage, formatPercent, formatRatio, formatUsd } from "@/lib/format";
import type { BookRow } from "@/lib/metrics";
import { lowestHealth } from "@/lib/overview";
import { positionAppName, type SpotHolding, type Thresholds } from "@/lib/types";
import { isLending } from "@/lib/view-filter";
import { Num, Panel, SectionLabel } from "@/components/ledger-ui";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "cn";

const SEVERITY: Record<Suggestion["severity"], { label: string; tone: string; icon: typeof CircleAlertIcon }> = {
  critical: { label: "Urgent", tone: "text-destructive border-destructive/40 bg-destructive/10", icon: ShieldAlertIcon },
  warning: { label: "Soon", tone: "text-gold border-gold/40 bg-gold/10", icon: CircleAlertIcon },
  info: { label: "Idea", tone: "text-azure border-azure/40 bg-azure/10", icon: LightbulbIcon },
};

export function AdvisorTab({
  rows,
  spot,
  betas,
  betaError,
  btcPrice,
  thresholds,
  goals,
  hedgeTargets,
  leverageTargets,
  example,
  onGoals,
  onThresholds,
  onHedgeTarget,
  onLeverageTarget,
}: {
  rows: BookRow[];
  spot: SpotHolding[];
  betas: BetaBook;
  betaError: string | null;
  btcPrice: number;
  thresholds: Thresholds;
  goals: Goals;
  hedgeTargets: Record<string, number>;
  leverageTargets: Record<string, number>;
  example: boolean;
  onGoals: (goals: Goals) => void;
  onThresholds: (thresholds: Thresholds) => void;
  onHedgeTarget: (id: string, value: number | null) => void;
  onLeverageTarget: (id: string, value: number | null) => void;
}) {
  const suggestions = suggest({ rows, spot, betas, btcPrice, thresholds, goals, hedgeTargets, leverageTargets });
  const book = bookBeta(rows, spot, betas, btcPrice);
  const wallets = spotBeta(spot, betas, btcPrice);
  const health = lowestHealth(rows);
  const urgent = suggestions.filter((s) => s.severity !== "info").length;
  const positions = betaRows(rows, betas, btcPrice);

  return (
    <div className="grid grid-cols-1 gap-5">
      <Panel className="grid gap-0 p-0 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border">
        <Stat label={`Portfolio BTC beta${example ? " · example" : ""}`}>
          <Num className="text-3xl font-semibold text-gold">{book.beta == null ? "—" : book.beta.toFixed(2)}</Num>
          <p className="mt-1 text-xs text-muted-foreground">
            {book.beta == null ? "Needs positive net worth" : `Net worth moves about ${book.beta.toFixed(2)}% per 1% BTC move`}
          </p>
        </Stat>
        <Stat label="Beta-weighted exposure">
          <Num className="text-2xl font-semibold">{formatAmount(book.betaBtc)} BTC</Num>
          <p className="mt-1 text-xs text-muted-foreground">{formatUsd(book.betaUsd)} of BTC-equivalent exposure</p>
        </Stat>
        <Stat label="Suggestions">
          <Num className={cn("text-2xl font-semibold", urgent ? "text-gold" : "text-azure")}>{suggestions.length}</Num>
          <p className="mt-1 text-xs text-muted-foreground">{urgent ? `${urgent} need attention soon` : "Nothing urgent"}</p>
        </Stat>
        <Stat label="Lowest health">
          <Num className="text-2xl font-semibold">{health ? formatHealth(health.value) : "—"}</Num>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={health?.label}>
            Target {formatHealth(goals.healthTarget)}
            {health ? ` · ${health.label}` : ""}
          </p>
        </Stat>
      </Panel>

      <section className="grid gap-3" aria-label="Suggestions">
        <SectionLabel>Suggested changes</SectionLabel>
        {suggestions.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
            Nothing to change. Every position meets your health, leverage and hedge targets. Set a portfolio beta or leverage target below to get sizing for those too.
          </p>
        ) : (
          suggestions.map((suggestion) => <SuggestionCard key={suggestion.id} suggestion={suggestion} />)
        )}
        <p className="text-xs text-muted-foreground">
          Suggestions only. Omnifolio never moves funds. Sizes use today&apos;s prices and each position&apos;s liquidation thresholds (assumed where the app reports none).
        </p>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Panel className="grid content-start gap-4">
          <SectionLabel>Your goals</SectionLabel>
          <GoalField
            id="goal-health"
            label="Health target"
            hint="Every borrowing position should stay above this."
            value={goals.healthTarget}
            onCommit={(value) => value != null && value > 1 && onGoals({ ...goals, healthTarget: value })}
          />
          <GoalField
            id="goal-max-leverage"
            label="Max leverage per position"
            hint="Positions above this get an unwind suggestion."
            value={thresholds.maxLeverage}
            onCommit={(value) => value != null && value >= 1 && onThresholds({ ...thresholds, maxLeverage: value })}
          />
          <GoalField
            id="goal-portfolio-leverage"
            label="Portfolio leverage target"
            hint="Blended across borrowing positions. Leave empty for none."
            value={goals.portfolioLeverage}
            optional
            onCommit={(value) => onGoals({ ...goals, portfolioLeverage: value != null && value >= 1 ? value : null })}
          />
          <GoalField
            id="goal-beta"
            label="Portfolio BTC beta target"
            hint="1 moves like holding BTC, 0 is market neutral. Leave empty for none."
            value={goals.portfolioBeta}
            optional
            onCommit={(value) => onGoals({ ...goals, portfolioBeta: value })}
          />
          <GoalField
            id="goal-hedge"
            label="Default hedge ratio"
            hint="Same-asset borrow ÷ supply for positions without their own target."
            value={thresholds.defaultTargetHedge}
            onCommit={(value) => value != null && value >= 0 && onThresholds({ ...thresholds, defaultTargetHedge: value })}
          />
        </Panel>

        <Panel className="min-w-0 p-0 lg:col-span-2">
          <header className="px-5 pt-5 pb-3">
            <SectionLabel>BTC beta by position</SectionLabel>
            <p className="mt-1 text-xs text-muted-foreground">
              Beta-weighted BTC is net exposure × each asset&apos;s BTC beta, in BTC. Set a target on a lending position to get sizing for it.
            </p>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-y border-border text-left text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                  <th className="px-5 py-2 font-medium">Position</th>
                  <th className="px-3 py-2 text-right font-medium">Equity</th>
                  <th className="px-3 py-2 text-right font-medium">Beta</th>
                  <th className="px-3 py-2 text-right font-medium">β-weighted BTC</th>
                  <th className="px-3 py-2 font-medium">Leverage · target</th>
                  <th className="px-5 py-2 font-medium">Hedge · target</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(({ row, exposure }) => {
                  const lending = isLending(row.position) && !row.metrics.underwater;
                  return (
                    <tr key={row.position.id} className="border-b border-border/60 hover:bg-muted/40">
                      <td className="max-w-[240px] px-5 py-2.5">
                        <p className="truncate font-medium" title={row.position.label}>{positionAppName(row.position)}</p>
                        <p className="truncate text-xs text-muted-foreground">{row.position.chain} · {row.position.label}</p>
                      </td>
                      <td className="px-3 py-2.5 text-right"><Num>{formatUsd(row.metrics.equity)}</Num></td>
                      <td className="px-3 py-2.5 text-right"><Num>{exposure.beta == null ? "—" : exposure.beta.toFixed(2)}</Num></td>
                      <td className="px-3 py-2.5 text-right"><Num>{formatAmount(exposure.betaBtc)}</Num></td>
                      <td className="px-3 py-2.5">
                        {lending ? (
                          <TargetCell
                            id={`lev-${row.position.id}`}
                            label={`Target leverage for ${row.position.label}`}
                            current={row.metrics.leverage == null ? "—" : formatLeverage(row.metrics.leverage)}
                            value={leverageTargets[row.position.id] ?? null}
                            placeholder="none"
                            onCommit={(value) => onLeverageTarget(row.position.id, value != null && value >= 1 ? value : null)}
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-5 py-2.5">
                        {lending && row.metrics.primaryUnderlying ? (
                          <TargetCell
                            id={`hedge-${row.position.id}`}
                            label={`Target hedge for ${row.position.label}`}
                            current={row.metrics.notionalHedgeRatio == null ? "—" : formatRatio(row.metrics.notionalHedgeRatio)}
                            value={hedgeTargets[row.position.id] ?? null}
                            placeholder={formatRatio(thresholds.defaultTargetHedge)}
                            onCommit={(value) => onHedgeTarget(row.position.id, value != null && value >= 0 ? value : null)}
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-b border-border/60">
                  <td className="px-5 py-2.5 font-medium">Wallet balances</td>
                  <td className="px-3 py-2.5 text-right"><Num>{formatUsd(spot.reduce((sum, h) => sum + (h.unpriced ? 0 : h.usd), 0))}</Num></td>
                  <td className="px-3 py-2.5 text-right"><Num>{wallets.beta == null ? "—" : wallets.beta.toFixed(2)}</Num></td>
                  <td className="px-3 py-2.5 text-right"><Num>{formatAmount(wallets.betaBtc)}</Num></td>
                  <td className="px-3 py-2.5 text-muted-foreground">—</td>
                  <td className="px-5 py-2.5 text-muted-foreground">—</td>
                </tr>
                <tr className="bg-muted/30 font-semibold">
                  <td className="px-5 py-2.5">Portfolio</td>
                  <td className="px-3 py-2.5 text-right"><Num>{formatUsd(book.equity)}</Num></td>
                  <td className="px-3 py-2.5 text-right text-gold"><Num>{book.beta == null ? "—" : book.beta.toFixed(2)}</Num></td>
                  <td className="px-3 py-2.5 text-right"><Num>{formatAmount(book.betaBtc)}</Num></td>
                  <td className="px-3 py-2.5" />
                  <td className="px-5 py-2.5" />
                </tr>
              </tbody>
            </table>
          </div>
          <AssetBetas rows={rows} spot={spot} betas={betas} error={betaError} assumedShare={book.assumedShare} />
        </Panel>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border p-5 last:border-b-0 lg:border-b-0">
      <SectionLabel className="mb-2">{label}</SectionLabel>
      {children}
    </div>
  );
}

function SuggestionCard({ suggestion }: { suggestion: Suggestion }) {
  const severity = SEVERITY[suggestion.severity];
  const Icon = severity.icon;
  return (
    <Panel className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium", severity.tone)}>
          <Icon className="size-3" aria-hidden /> {severity.label}
        </span>
        <span className="text-xs text-muted-foreground">{suggestion.scope}</span>
      </div>
      <div>
        <h3 className="text-base font-semibold">{suggestion.title}</h3>
        <p className="mt-0.5 text-sm text-muted-foreground">{suggestion.why}</p>
      </div>
      <ul className="grid gap-1.5 text-sm">
        {suggestion.options.map((option) => (
          <li key={option} className="rounded-lg bg-muted/50 px-3 py-2">{option}</li>
        ))}
      </ul>
      {suggestion.effects.length > 0 ? (
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {suggestion.effects.map((effect) => (
            <div key={effect.label} className="flex gap-1.5">
              <dt className="text-muted-foreground">{effect.label}</dt>
              <dd className="font-mono">
                {effect.before} <span className="text-muted-foreground">→</span> <span className="text-azure">{effect.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Panel>
  );
}

function parse(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function GoalField({
  id,
  label,
  hint,
  value,
  optional,
  onCommit,
}: {
  id: string;
  label: string;
  hint: string;
  value: number | null;
  optional?: boolean;
  onCommit: (value: number | null) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        key={`${id}-${value}`}
        defaultValue={value == null ? "" : String(value)}
        placeholder={optional ? "No target" : undefined}
        onBlur={(event) => onCommit(parse(event.target.value))}
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function TargetCell({
  id,
  label,
  current,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  label: string;
  current: string;
  value: number | null;
  placeholder: string;
  onCommit: (value: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Num className="w-14 text-xs">{current}</Num>
      <Input
        id={id}
        aria-label={label}
        inputMode="decimal"
        className="h-7 w-20"
        key={`${id}-${value}`}
        defaultValue={value == null ? "" : String(value)}
        placeholder={placeholder}
        onBlur={(event) => onCommit(parse(event.target.value))}
      />
    </div>
  );
}

function AssetBetas({
  rows,
  spot,
  betas,
  error,
  assumedShare,
}: {
  rows: BookRow[];
  spot: SpotHolding[];
  betas: BetaBook;
  error: string | null;
  assumedShare: number;
}) {
  const assets = new Map<string, ReturnType<typeof betaOf>>();
  for (const row of rows) for (const leg of row.position.legs) if (leg.kind === "volatile") assets.set(betaBase(leg.underlying), betaOf(leg.underlying, leg.kind, betas));
  for (const holding of spot) if (holding.kind === "volatile" && !holding.unpriced) assets.set(betaBase(holding.underlying), betaOf(holding.underlying, holding.kind, betas));
  const list = [...assets].sort((a, b) => a[0].localeCompare(b[0]));
  if (!list.length) return null;
  return (
    <div className="grid gap-2 border-t border-border px-5 py-4">
      <SectionLabel>Asset betas · {BETA_WINDOW_DAYS} days of daily returns</SectionLabel>
      <ul className="flex flex-wrap gap-1.5">
        {list.map(([asset, beta]) => (
          <li
            key={asset}
            className={cn("rounded-md border px-2 py-1 font-mono text-xs", beta.source === "assumed" ? "border-dashed border-border text-muted-foreground" : "border-border")}
            title={beta.source === "assumed" ? "No price history found; assumed to move one-for-one with BTC." : beta.correlation != null ? `Correlation with BTC ${beta.correlation.toFixed(2)}` : undefined}
          >
            {asset} {beta.beta.toFixed(2)}
            {beta.source === "assumed" ? "*" : ""}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        BTC is 1 and stablecoins 0 by definition. Staked tokens use their base asset.
        {assumedShare > 0 ? ` * No history found, so beta 1 is assumed (${formatPercent(assumedShare, 0)} of exposure).` : ""}
        {error ? ` Price history failed: ${error}` : ""}
      </p>
    </div>
  );
}
