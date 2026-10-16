"use client";

import { useEffect, useState } from "react";
import { CHAIN_BY_KEY } from "@/lib/chains";
import { fmtAmount, fmtPct, fmtUsd } from "@/lib/format";
import type { PositionPnl } from "@/lib/history/types";
import type { Position } from "@/lib/types";

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: "pos" | "neg"; sub?: string }) {
  const color = tone === "pos" ? "text-positive" : tone === "neg" ? "text-negative" : "";
  return (
    <div>
      <dt className="eyebrow mb-1">{label}</dt>
      <dd className={`display text-2xl tabular ${color}`}>{value}</dd>
      {sub && <dd className="text-xs text-muted mt-0.5">{sub}</dd>}
    </div>
  );
}

const toneOf = (v: number | null) => (v == null ? undefined : v >= 0 ? "pos" : "neg");

export function PnlPanel({ address, position, onResult }: { address: string; position: Position; onResult?: (p: PositionPnl) => void }) {
  const [pnl, setPnl] = useState<PositionPnl | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, position }),
      signal: ctrl.signal,
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? r.statusText);
        setPnl(body as PositionPnl);
        onResult?.(body as PositionPnl);
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, position.id]);

  if (error) return <p className="text-negative text-sm">History unavailable: {error}</p>;
  if (!pnl) return <p className="text-faint text-sm">Reading position history…</p>;

  const h = pnl.history;
  const explorer = CHAIN_BY_KEY[position.chain].explorer;

  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <Stat label="Net PnL" value={fmtUsd(pnl.netPnlUsd, { sign: true })} tone={toneOf(pnl.netPnlUsd)} sub={fmtPct(pnl.netPnlPct, { sign: true })} />
        <Stat label="vs. holding" value={fmtUsd(pnl.vsHodlUsd, { sign: true })} tone={toneOf(pnl.vsHodlUsd)} sub={`HODL would be ${fmtUsd(pnl.hodlValueUsd)}`} />
        <Stat label="Impermanent loss" value={fmtUsd(pnl.impermanentLossUsd, { sign: true })} tone={toneOf(pnl.impermanentLossUsd)} sub={fmtPct(pnl.impermanentLossPct, { sign: true })} />
        <Stat label="Fees earned" value={fmtUsd(pnl.totalFeesUsd)} sub={`${fmtUsd(h.feesCollectedUsd)} collected`} />
        <Stat label="Gas spent" value={fmtUsd(h.gasUsd)} sub={fmtAmount(h.gasNative, CHAIN_BY_KEY[position.chain].nativeSymbol)} />
        <Stat label="Fee APR" value={fmtPct(pnl.feeAprPct)} sub={`${pnl.ageDays.toFixed(0)} days open`} />
      </dl>

      <div className="text-xs text-muted grid grid-cols-1 sm:grid-cols-3 gap-2">
        <span>Deposited {fmtUsd(h.costBasisUsd)} · {fmtAmount(h.deposited0, position.token0.symbol)} + {fmtAmount(h.deposited1, position.token1.symbol)}</span>
        <span>Withdrawn {fmtUsd(h.withdrawnUsd)} · {fmtAmount(h.withdrawn0, position.token0.symbol)} + {fmtAmount(h.withdrawn1, position.token1.symbol)}</span>
        <span>Collected {fmtAmount(h.feesCollected0, position.token0.symbol)} + {fmtAmount(h.feesCollected1, position.token1.symbol)}</span>
      </div>

      {h.warnings.length > 0 && (
        <ul className="text-xs text-faint space-y-1">
          {h.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <details className="text-sm">
        <summary className="eyebrow cursor-pointer">Transactions ({h.flows.length})</summary>
        <table className="w-full mt-3 text-xs font-mono">
          <thead className="text-faint">
            <tr className="text-left">
              <th className="py-1 pr-3 font-normal">Date</th>
              <th className="py-1 pr-3 font-normal">Action</th>
              <th className="py-1 pr-3 font-normal text-right">{position.token0.symbol}</th>
              <th className="py-1 pr-3 font-normal text-right">{position.token1.symbol}</th>
              <th className="py-1 pr-3 font-normal text-right">USD then</th>
              <th className="py-1 font-normal text-right">Gas</th>
            </tr>
          </thead>
          <tbody>
            {h.flows.map((f, i) => (
              <tr key={`${f.txHash}-${i}`} className="border-t border-line-soft">
                <td className="py-1.5 pr-3">
                  <a href={`${explorer}/tx/${f.txHash}`} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-4">
                    {new Date(f.timestamp * 1000).toISOString().slice(0, 10)}
                  </a>
                </td>
                <td className="py-1.5 pr-3">{f.kind === "collect" ? `fees${f.estimated ? " (est.)" : ""}` : f.kind}</td>
                <td className="py-1.5 pr-3 text-right tabular">{fmtAmount(f.amount0)}</td>
                <td className="py-1.5 pr-3 text-right tabular">{fmtAmount(f.amount1)}</td>
                <td className="py-1.5 pr-3 text-right tabular">{fmtUsd(f.valueUsd)}</td>
                <td className="py-1.5 text-right tabular">{fmtUsd(f.gasUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
