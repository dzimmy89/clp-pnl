"use client";

import { useEffect, useMemo, useState } from "react";
import { computePnl } from "@/lib/lp/history/pnl";
import type { PositionHistory, PositionPnl } from "@/lib/lp/history/types";
import type { LpPosition } from "@/lib/lp/types";
import type { Position } from "@/lib/types";

/** How long a position's history is reused before it is read again, when nothing changed on it. */
const HISTORY_TTL_MS = 10 * 60 * 1000;
/** History reads fan out into log, receipt and price lookups, so only a few run at once. */
const MAX_PARALLEL = 3;

type Entry = { at: number; promise: Promise<PositionHistory> };
const cache = new Map<string, Entry>();

let active = 0;
const queue: (() => void)[] = [];
function limit<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      active++;
      task()
        .then(resolve, reject)
        .finally(() => {
          active--;
          queue.shift()?.();
        });
    };
    if (active < MAX_PARALLEL) run();
    else queue.push(run);
  });
}

async function readHistory(wallet: string, lp: LpPosition, signal: AbortSignal): Promise<PositionHistory> {
  const response = await fetch("/api/lp/history", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: wallet, position: lp }),
    signal,
  });
  const body = (await response.json().catch(() => null)) as (PositionPnl & { error?: string }) | null;
  if (!response.ok || !body?.history) throw new Error(body?.error ?? `History request failed (${response.status})`);
  return body.history;
}

/**
 * The position's flow history, read once per position and reused across refreshes and tab
 * changes. The key carries the liquidity, so adding or removing liquidity reads it again.
 */
export function positionHistory(wallet: string, lp: LpPosition, signal: AbortSignal): Promise<PositionHistory> {
  const key = `${wallet.toLowerCase()}:${lp.id}:${lp.liquidity}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.promise;
  const promise = limit(() => readHistory(wallet, lp, signal));
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

export interface PnlState {
  pnl: PositionPnl | null;
  error: string | null;
}

/** PnL for one book row, recomputed against the latest live read once its history is in. */
export function usePositionPnl(position: Position): PnlState {
  const lp = position.lp;
  const [history, setHistory] = useState<{ key: string; value: PositionHistory } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const key = lp ? `${position.wallet.toLowerCase()}:${lp.id}:${lp.liquidity}` : "";

  useEffect(() => {
    if (!lp) return;
    const controller = new AbortController();
    positionHistory(position.wallet, lp, controller.signal)
      .then((value) => setHistory({ key, value }))
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setFailure({ key, message: error instanceof Error ? error.message : "History unavailable" });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key names the wallet, position and liquidity
  }, [key]);

  // One PnL object per (history, live read), so a parent that stores it does not re-render forever.
  const pnl = useMemo(() => (lp && history?.key === key ? computePnl(history.value, lp) : null), [lp, history, key]);
  if (!lp) return { pnl: null, error: "Not a liquidity position" };
  if (!pnl) return { pnl: null, error: failure?.key === key ? failure.message : null };
  return { pnl, error: null };
}
