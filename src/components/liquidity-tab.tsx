"use client";

import { useEffect, useState } from "react";
import { DropletsIcon, ExternalLinkIcon } from "lucide-react";
import { CHAIN_BY_KEY, CHAINS } from "@/lib/lp/chains";
import { usePositionPnl } from "@/lib/lp/client";
import { fmtAmount, fmtFee, fmtPct, fmtPrice, fmtUsd } from "@/lib/lp/format";
import type { PositionPnl } from "@/lib/lp/history/types";
import type { LpPosition } from "@/lib/lp/types";
import { shortAddress } from "@/lib/format";
import type { BookRow } from "@/lib/metrics";
import type { Position, ProtocolFetch } from "@/lib/types";
import { AssetBadge, Num, Panel, SectionLabel } from "@/components/ledger-ui";
import { BadgeStack } from "@/components/position-ui";
import { cn } from "cn";

/** Where the current price sits inside the range, 0..1, clamped. */
function rangePosition(p: LpPosition): number {
  const span = p.tickUpper - p.tickLower;
  if (span <= 0) return 0.5;
  return Math.min(1, Math.max(0, (p.currentTick - p.tickLower) / span));
}

const signed = (v: number | null | undefined) => (v == null ? "" : v >= 0 ? "text-azure" : "text-destructive");

function sum(values: (number | null | undefined)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function LiquidityTab({
  rows,
  example,
  loading,
  status,
  onOpenWallets,
}: {
  rows: BookRow[];
  example: boolean;
  loading: boolean;
  /** How the Uniswap reader answered on the last refresh. */
  status: ProtocolFetch | null;
  onOpenWallets: () => void;
}) {
  const positions = rows.map((row) => row.position).filter((position): position is Position & { lp: LpPosition } => position.lp != null);
  const [pnls, setPnls] = useState<Record<string, PositionPnl>>({});
  const lps = positions.map((position) => position.lp);
  const known = positions.map((position) => pnls[position.id]).filter((pnl): pnl is PositionPnl => pnl != null);
  const pending = positions.length - known.length;
  const value = sum(lps.map((lp) => lp.valueUsd));
  const fees = sum(lps.map((lp) => lp.feesUsd));
  const unpriced = lps.filter((lp) => lp.valueUsd == null).length;
  const inRange = lps.filter((lp) => lp.inRange).length;
  const totals = known.length
    ? {
        netPnlUsd: sum(known.map((pnl) => pnl.netPnlUsd)),
        vsHodlUsd: sum(known.map((pnl) => pnl.vsHodlUsd)),
        impermanentLossUsd: sum(known.map((pnl) => pnl.impermanentLossUsd)),
        totalFeesUsd: sum(known.map((pnl) => pnl.totalFeesUsd)),
        gasUsd: sum(known.map((pnl) => pnl.history.gasUsd)),
      }
    : null;

  return (
    <div className="grid grid-cols-1 gap-5">
      <Panel className="grid gap-0 p-0 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border">
        <Stat label="Open positions">
          <Num className="text-3xl font-semibold">{positions.length}</Num>
          <p className="mt-1 text-xs text-muted-foreground">
            {inRange} in range · {positions.length - inRange} out of range
          </p>
        </Stat>
        <Stat label="Position value">
          <Num className="text-2xl font-semibold text-gold">{fmtUsd(value)}</Num>
          <p className="mt-1 text-xs text-muted-foreground">principal, at today&apos;s prices</p>
        </Stat>
        <Stat label="Uncollected fees">
          <Num className="text-2xl font-semibold text-azure">{fmtUsd(fees)}</Num>
          <p className="mt-1 text-xs text-muted-foreground">claimable now</p>
        </Stat>
        <Stat label="Net PnL">
          <Num className={cn("text-2xl font-semibold", signed(totals?.netPnlUsd))}>{totals ? fmtUsd(totals.netPnlUsd, { sign: true }) : "—"}</Num>
          <p className="mt-1 text-xs text-muted-foreground">
            {pending > 0 ? `Reading history for ${pending} position${pending === 1 ? "" : "s"}…` : "value + fees + withdrawals − deposits − gas"}
          </p>
        </Stat>
      </Panel>

      {positions.length > 0 ? (
        <Panel className="grid gap-0 p-0 sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-border">
          <Stat label="vs. holding">
            <Num className={cn("text-xl font-semibold", signed(totals?.vsHodlUsd))}>{totals ? fmtUsd(totals.vsHodlUsd, { sign: true }) : "—"}</Num>
            <p className="mt-1 text-xs text-muted-foreground">LPing against simply holding the tokens</p>
          </Stat>
          <Stat label="Impermanent loss">
            <Num className={cn("text-xl font-semibold", signed(totals?.impermanentLossUsd))}>
              {totals ? fmtUsd(totals.impermanentLossUsd, { sign: true }) : "—"}
            </Num>
            <p className="mt-1 text-xs text-muted-foreground">principal value minus what the deposits are worth today</p>
          </Stat>
          <Stat label="Fees earned">
            <Num className="text-xl font-semibold text-azure">{totals ? fmtUsd(totals.totalFeesUsd) : "—"}</Num>
            <p className="mt-1 text-xs text-muted-foreground">collected and still uncollected</p>
          </Stat>
          <Stat label="Gas spent">
            <Num className="text-xl font-semibold text-gold">{totals ? fmtUsd(totals.gasUsd) : "—"}</Num>
            <p className="mt-1 text-xs text-muted-foreground">every mint, add, remove and collect</p>
          </Stat>
        </Panel>
      ) : null}

      {unpriced > 0 ? (
        <p className="text-xs text-muted-foreground">
          {unpriced} position{unpriced === 1 ? "" : "s"} without a USD price {unpriced === 1 ? "is" : "are"} left out of the totals.
        </p>
      ) : null}

      {status?.message && status.status !== "skipped" ? (
        <p className={cn("text-xs", status.status === "error" ? "text-destructive" : "text-muted-foreground")}>
          <span className="font-medium text-foreground/80">Uniswap reader:</span> {status.message}
        </p>
      ) : null}

      {example ? (
        <Empty>
          The example book has no concentrated-liquidity positions.{" "}
          <button type="button" className="text-azure hover:underline" onClick={onOpenWallets}>
            Sign in or paste an EVM address
          </button>{" "}
          to read its Uniswap V3 and V4 positions on {CHAINS.map((chain) => chain.name).join(", ")}.
        </Empty>
      ) : positions.length === 0 ? (
        <Empty>
          {loading
            ? "Reading Uniswap positions across your wallets…"
            : `No open Uniswap V3 or V4 positions in this view. Chains checked: ${CHAINS.map((chain) => chain.name).join(", ")}. V4 positions need an RPC that allows wide log queries (set ALCHEMY_API_KEY).`}
        </Empty>
      ) : (
        <section className="grid grid-cols-1 gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Positions</h2>
            <p className="text-xs text-muted-foreground">Largest first · PnL, impermanent loss, fees and gas per position</p>
          </div>
          {positions.map((position) => (
            <LpCard key={position.id} position={position} onPnl={(pnl) => setPnls((current) => (current[position.id] === pnl ? current : { ...current, [position.id]: pnl }))} />
          ))}
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Positions are read from the Uniswap position managers and pools on each chain; history comes from their events, priced at the time with
        DefiLlama. Impermanent loss is the position&apos;s principal value against holding the net deposited tokens; net PnL adds fees and withdrawals
        and subtracts deposits and gas.
      </p>
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

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">{children}</p>;
}

/** One concentrated-liquidity position: what it holds, where price sits in its range, and its PnL. */
function LpCard({ position, onPnl }: { position: Position & { lp: LpPosition }; onPnl: (pnl: PositionPnl) => void }) {
  const lp = position.lp;
  const chain = CHAIN_BY_KEY[lp.chain];
  const at = rangePosition(lp);
  const { pnl, error } = usePositionPnl(position);
  useEffect(() => {
    if (pnl) onPnl(pnl);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the parent only keeps the latest PnL per position
  }, [pnl]);

  return (
    <article id={`position-${position.id}`} className="relative min-w-0 scroll-mt-24 overflow-hidden rounded-2xl border border-border bg-card/90">
      <span className={cn("absolute inset-y-0 left-0 w-1", lp.inRange ? "bg-azure" : "bg-gold")} aria-hidden />
      <header className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 pl-6">
        <div className="flex min-w-0 items-center gap-3">
          <BadgeStack legs={position.legs} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold">
                {lp.token0.symbol} / {lp.token1.symbol}
              </h3>
              <span className="text-sm text-muted-foreground">{chain.name}</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {position.app} · {fmtFee(lp.fee)}
                {lp.hooks ? " · hooked" : ""}
              </span>
              <span className={cn("rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-medium", lp.inRange ? "text-azure" : "text-gold")}>
                {lp.inRange ? "In range" : "Out of range"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              <span className="font-mono">{shortAddress(position.wallet)}</span> ·{" "}
              <a href={lp.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                position #{lp.tokenId} <ExternalLinkIcon className="size-3" aria-hidden />
              </a>
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[11px] tracking-[0.12em] text-muted-foreground uppercase">Value</p>
          <Num className="block text-2xl font-semibold text-gold">{fmtUsd(lp.valueUsd)}</Num>
          <Num className="block text-xs text-azure">{fmtUsd(lp.feesUsd)} uncollected fees</Num>
        </div>
      </header>

      <div className="px-5 pt-4 pl-6">
        <div className="mb-2 flex justify-between gap-2 font-mono text-xs text-muted-foreground">
          <span>{fmtPrice(lp.price.lower)}</span>
          <span className={lp.inRange ? "text-azure" : "text-gold"}>
            {fmtPrice(lp.price.current)} {lp.token1.symbol} per {lp.token0.symbol}
          </span>
          <span>{fmtPrice(lp.price.upper)}</span>
        </div>
        <div className="relative h-2 rounded-full bg-muted" role="img" aria-label={`Current price sits ${Math.round(at * 100)}% of the way through the range`}>
          <div className={cn("absolute inset-y-0 left-0 rounded-full", lp.inRange ? "bg-azure/40" : "bg-gold/40")} style={{ width: `${at * 100}%` }} />
          <div
            className={cn("absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card", lp.inRange ? "bg-azure" : "bg-gold")}
            style={{ left: `${at * 100}%` }}
          />
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-4 px-5 pt-4 pl-6 text-sm sm:grid-cols-4">
        {[lp.token0, lp.token1].map((token, i) => (
          <div key={token.address} className="flex items-center gap-2.5">
            <AssetBadge symbol={token.symbol} kind={position.legs[i].kind} />
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">{token.symbol}</dt>
              <dd>
                <Num className="block">{fmtAmount(i === 0 ? lp.amount0 : lp.amount1)}</Num>
                <Num className="block text-xs text-muted-foreground">{token.priceUsd == null ? "unpriced" : `$${fmtPrice(token.priceUsd)}`}</Num>
              </dd>
            </div>
          </div>
        ))}
        <div>
          <dt className="text-xs text-muted-foreground">Uncollected fees</dt>
          <dd>
            <Num className="block">{fmtAmount(lp.fees0, lp.token0.symbol)}</Num>
            <Num className="block">{fmtAmount(lp.fees1, lp.token1.symbol)}</Num>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Liquidity</dt>
          <dd>
            <Num className="block truncate" title={lp.liquidity}>
              {lp.liquidity.length > 12 ? `${lp.liquidity.slice(0, 6)}…${lp.liquidity.slice(-4)}` : lp.liquidity}
            </Num>
            <span className="block text-xs text-muted-foreground">
              ticks {lp.tickLower} to {lp.tickUpper}
            </span>
          </dd>
        </div>
      </dl>

      <div className="mx-5 mt-4 ml-6 border-t border-border/60 pt-4 pb-5">
        {error ? (
          <p className="text-sm text-destructive">History unavailable: {error}</p>
        ) : !pnl ? (
          <p className="text-sm text-muted-foreground">Reading position history…</p>
        ) : (
          <PnlDetail pnl={pnl} lp={lp} />
        )}
      </div>
    </article>
  );
}

function PnlStat({ label, value, tone, sub }: { label: string; value: string; tone?: number | null; sub?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>
        <Num className={cn("block text-lg font-semibold", tone === undefined ? "" : signed(tone))}>{value}</Num>
        {sub ? <span className="block text-xs text-muted-foreground">{sub}</span> : null}
      </dd>
    </div>
  );
}

function PnlDetail({ pnl, lp }: { pnl: PositionPnl; lp: LpPosition }) {
  const h = pnl.history;
  const chain = CHAIN_BY_KEY[lp.chain];
  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <PnlStat label="Net PnL" value={fmtUsd(pnl.netPnlUsd, { sign: true })} tone={pnl.netPnlUsd} sub={fmtPct(pnl.netPnlPct, { sign: true })} />
        <PnlStat label="vs. holding" value={fmtUsd(pnl.vsHodlUsd, { sign: true })} tone={pnl.vsHodlUsd} sub={`HODL would be ${fmtUsd(pnl.hodlValueUsd)}`} />
        <PnlStat label="Impermanent loss" value={fmtUsd(pnl.impermanentLossUsd, { sign: true })} tone={pnl.impermanentLossUsd} sub={fmtPct(pnl.impermanentLossPct, { sign: true })} />
        <PnlStat label="Fees earned" value={fmtUsd(pnl.totalFeesUsd)} sub={`${fmtUsd(h.feesCollectedUsd)} collected`} />
        <PnlStat label="Gas spent" value={fmtUsd(h.gasUsd)} sub={fmtAmount(h.gasNative, chain.nativeSymbol)} />
        <PnlStat label="Fee APR" value={fmtPct(pnl.feeAprPct)} sub={`${pnl.ageDays.toFixed(0)} days open`} />
      </dl>

      <div className="grid grid-cols-1 gap-1 text-xs text-muted-foreground sm:grid-cols-3">
        <span>
          Deposited <Num className="text-foreground/80">{fmtUsd(h.costBasisUsd)}</Num> · {fmtAmount(h.deposited0, lp.token0.symbol)} + {fmtAmount(h.deposited1, lp.token1.symbol)}
        </span>
        <span>
          Withdrawn <Num className="text-foreground/80">{fmtUsd(h.withdrawnUsd)}</Num> · {fmtAmount(h.withdrawn0, lp.token0.symbol)} + {fmtAmount(h.withdrawn1, lp.token1.symbol)}
        </span>
        <span>
          Collected {fmtAmount(h.feesCollected0, lp.token0.symbol)} + {fmtAmount(h.feesCollected1, lp.token1.symbol)}
        </span>
      </div>

      {h.warnings.length > 0 ? (
        <ul className="grid gap-0.5 text-xs text-muted-foreground">
          {h.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <details className="group text-sm">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <DropletsIcon className="size-3.5" aria-hidden /> Transactions ({h.flows.length})
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[520px] font-mono text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                <th className="py-1.5 pr-3 font-medium">Date</th>
                <th className="py-1.5 pr-3 font-medium">Action</th>
                <th className="py-1.5 pr-3 text-right font-medium">{lp.token0.symbol}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{lp.token1.symbol}</th>
                <th className="py-1.5 pr-3 text-right font-medium">USD then</th>
                <th className="py-1.5 text-right font-medium">Gas</th>
              </tr>
            </thead>
            <tbody>
              {h.flows.map((flow, i) => (
                <tr key={`${flow.txHash}-${i}`} className="border-b border-border/60 last:border-b-0">
                  <td className="py-1.5 pr-3">
                    <a href={`${chain.explorer}/tx/${flow.txHash}`} target="_blank" rel="noreferrer" className="underline decoration-border underline-offset-4 hover:text-foreground">
                      {new Date(flow.timestamp * 1000).toISOString().slice(0, 10)}
                    </a>
                  </td>
                  <td className="py-1.5 pr-3">{flow.kind === "collect" ? `fees${flow.estimated ? " (est.)" : ""}` : flow.kind}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtAmount(flow.amount0)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtAmount(flow.amount1)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{fmtUsd(flow.valueUsd)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtUsd(flow.gasUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
