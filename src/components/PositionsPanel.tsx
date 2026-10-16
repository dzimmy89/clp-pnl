"use client";

import { useEffect, useMemo, useState } from "react";
import { CHAINS, type ChainKey } from "@/lib/chains";
import { fmtUsd } from "@/lib/format";
import type { PositionPnl } from "@/lib/history/types";
import type { ChainPositionsResult } from "@/lib/types";
import { PositionCard } from "./PositionCard";

type State = Record<ChainKey, { loading: boolean; result?: ChainPositionsResult; error?: string }>;

const initialState = () =>
  Object.fromEntries(CHAINS.map((c) => [c.key, { loading: true }])) as State;

export function PositionsPanel({ address }: { address: string }) {
  const [state, setState] = useState<State>(initialState);
  const [filter, setFilter] = useState<ChainKey | "all">("all");
  const [pnls, setPnls] = useState<Record<string, PositionPnl>>({});

  useEffect(() => {
    const ctrl = new AbortController();
    for (const c of CHAINS) {
      fetch(`/api/positions?address=${address}&chain=${c.key}`, { signal: ctrl.signal })
        .then(async (r) => {
          const body = (await r.json()) as ChainPositionsResult & { error?: string };
          if (!r.ok) throw new Error(body.error ?? r.statusText);
          setState((s) => ({ ...s, [c.key]: { loading: false, result: body } }));
        })
        .catch((e: Error) => {
          if (e.name === "AbortError") return;
          setState((s) => ({ ...s, [c.key]: { loading: false, error: e.message } }));
        });
    }
    return () => ctrl.abort();
  }, [address]);

  const all = useMemo(
    () => CHAINS.flatMap((c) => state[c.key].result?.positions ?? []),
    [state],
  );
  const shown = filter === "all" ? all : all.filter((p) => p.chain === filter);
  const loadingCount = CHAINS.filter((c) => state[c.key].loading).length;
  const totalValue = all.reduce((s, p) => s + (p.valueUsd ?? 0), 0);
  const totalFees = all.reduce((s, p) => s + (p.feesUsd ?? 0), 0);
  const unpriced = all.filter((p) => p.valueUsd == null).length;
  const closed = CHAINS.reduce((s, c) => s + (state[c.key].result?.closedCount ?? 0), 0);

  const pnlRows = all.map((p) => pnls[p.id]).filter(Boolean);
  const sumPnl = (k: "netPnlUsd" | "vsHodlUsd" | "impermanentLossUsd" | "totalFeesUsd") =>
    pnlRows.length ? pnlRows.reduce((s, r) => s + (r[k] ?? 0), 0) : null;
  const gasTotal = pnlRows.length ? pnlRows.reduce((s, r) => s + (r.history.gasUsd ?? 0), 0) : null;
  const pnlPending = all.length - pnlRows.length;
  const signed = (v: number | null) => (v == null ? "" : v >= 0 ? "text-positive" : "text-negative");

  return (
    <div>
      <dl className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-line-soft border border-line-soft">
        {[
          ["Open positions", String(all.length)],
          ["Position value", fmtUsd(totalValue)],
          ["Uncollected fees", fmtUsd(totalFees)],
          ["In range", `${all.filter((p) => p.inRange).length} of ${all.length}`],
        ].map(([k, v]) => (
          <div key={k} className="bg-background p-5">
            <dt className="eyebrow mb-2">{k}</dt>
            <dd className="display text-3xl sm:text-4xl tabular">{v}</dd>
          </div>
        ))}
      </dl>
      <dl className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-line-soft border border-line-soft border-t-0">
        {(
          [
            ["Net PnL", sumPnl("netPnlUsd"), true],
            ["vs. holding", sumPnl("vsHodlUsd"), true],
            ["Impermanent loss", sumPnl("impermanentLossUsd"), true],
            ["Fees earned", sumPnl("totalFeesUsd"), false],
            ["Gas spent", gasTotal, false],
          ] as const
        ).map(([k, v, tone]) => (
          <div key={k} className="bg-background p-5">
            <dt className="eyebrow mb-2">{k}</dt>
            <dd className={`display text-2xl sm:text-3xl tabular ${tone ? signed(v) : ""}`}>
              {fmtUsd(v, { sign: !!tone })}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-faint mt-3">
        {pnlPending > 0 && all.length > 0 && `Reading history for ${pnlPending} position${pnlPending === 1 ? "" : "s"}… `}
        {loadingCount > 0
          ? `Reading ${loadingCount} chain${loadingCount === 1 ? "" : "s"}…`
          : `${closed} closed position${closed === 1 ? "" : "s"} not shown.`}
        {unpriced > 0 && ` ${unpriced} position${unpriced === 1 ? "" : "s"} without a USD price are excluded from totals.`}
      </p>

      <div className="flex flex-wrap gap-2 mt-10">
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`eyebrow border px-3 py-1.5 ${filter === "all" ? "border-gold text-gold" : "border-line-soft text-muted"}`}
        >
          All chains
        </button>
        {CHAINS.map((c) => {
          const s = state[c.key];
          const n = s.result?.positions.length ?? 0;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={`eyebrow border px-3 py-1.5 ${filter === c.key ? "border-gold text-gold" : "border-line-soft text-muted"}`}
              title={s.error ?? s.result?.error ?? s.result?.warnings.join("; ")}
            >
              {c.name}
              <span className={`ml-2 normal-case tracking-normal ${s.error ? "text-negative" : "text-faint"}`}>
                {s.loading ? "…" : s.error || s.result?.error ? "!" : n}
              </span>
            </button>
          );
        })}
      </div>

      {CHAINS.some((c) => state[c.key].error || state[c.key].result?.warnings.length) && (
        <ul className="mt-4 text-xs text-muted space-y-1">
          {CHAINS.flatMap((c) => {
            const s = state[c.key];
            const items = s.error ? [s.error] : s.result?.error ? [s.result.error] : (s.result?.warnings ?? []);
            return items.map((w, i) => (
              <li key={`${c.key}-${i}`}>
                <span className="eyebrow mr-2">{c.name}</span>
                {w}
              </li>
            ));
          })}
        </ul>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4">
        {shown.map((p) => (
          <PositionCard
            key={p.id}
            p={p}
            address={address}
            onPnl={(id, pnl) => setPnls((prev) => (prev[id] ? prev : { ...prev, [id]: pnl }))}
          />
        ))}
        {shown.length === 0 && loadingCount === 0 && (
          <div className="border border-line-soft p-10 text-center">
            <p className="display text-2xl">No open positions found.</p>
            <p className="text-muted text-sm mt-2">
              This address holds no Uniswap V3 or V4 liquidity on the chains checked.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
