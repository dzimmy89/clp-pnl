"use client";

import { useEffect, useState } from "react";
import type { Position, SpotHolding } from "@/lib/types";
import { commitDesk, currentDesk } from "@/lib/storage";

/** How often live prices for balances and books entered by hand are refreshed while the app is open. */
const PRICE_REFRESH_MS = 5 * 60_000;

export interface LivePrice {
  usd: number;
  id: string;
  name?: string;
}

interface PriceResponse {
  prices?: Record<string, LivePrice>;
  missing?: string[];
  error?: string;
}

/** Tickers of the balances and book legs whose price follows the market. */
export function autoSymbols(balances: SpotHolding[], books: Position[] = []): string[] {
  const symbols = [
    ...balances.filter((b) => !b.fixedPrice).map((b) => b.symbol),
    ...books.flatMap((book) => book.legs.filter((leg) => !leg.fixedPrice).map((leg) => leg.symbol)),
  ];
  return [...new Set(symbols.map((s) => s.toUpperCase()))].sort();
}

/** `balances` with each market-priced balance revalued at its ticker's live price. */
export function applyPrices(balances: SpotHolding[], prices: Record<string, LivePrice>, now: number): SpotHolding[] {
  return balances.map((holding) => {
    const price = holding.fixedPrice ? undefined : prices[holding.symbol.toUpperCase()];
    if (!price) return holding;
    return { ...holding, priceUsd: price.usd, usd: holding.amount * price.usd, pricedAt: now, priceName: price.name, unpriced: false };
  });
}

/** `books` with each market-priced leg revalued at its ticker's live price. */
export function applyBookPrices(books: Position[], prices: Record<string, LivePrice>, now: number): Position[] {
  return books.map((book) => {
    let changed = false;
    const legs = book.legs.map((leg) => {
      const price = leg.fixedPrice ? undefined : prices[leg.symbol.toUpperCase()];
      if (!price) return leg;
      changed = true;
      return { ...leg, priceUsd: price.usd, usd: leg.amount * price.usd, pricedAt: now, priceName: price.name };
    });
    return changed ? { ...book, legs, fetchedAt: new Date(now).toISOString() } : book;
  });
}

export async function fetchLivePrices(symbols: string[]): Promise<Required<Pick<PriceResponse, "prices" | "missing">> & { error?: string }> {
  const query = symbols.map((s) => `symbol=${encodeURIComponent(s)}`).join("&");
  const response = await fetch(`/api/prices?${query}`);
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(failure?.error ?? `Price request failed (${response.status})`);
  }
  const body = (await response.json()) as PriceResponse;
  return { prices: body.prices ?? {}, missing: body.missing ?? [], error: body.error };
}

/**
 * Keeps balances and books entered by hand at their tickers' live prices: on load, whenever
 * a ticker is added, each time `refreshKey` changes (a book refresh) and every few minutes.
 * The new prices are saved with the desk, so the last price found stays if a later lookup fails.
 */
export function useManualPrices(balances: SpotHolding[], books: Position[], refreshKey: unknown) {
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const symbols = autoSymbols(balances, books).join(",");

  useEffect(() => {
    if (!symbols) return;
    let cancelled = false;
    const run = () =>
      fetchLivePrices(symbols.split(","))
        .then((body) => {
          if (cancelled) return;
          // Read the desk fresh: it may have changed while the request was out.
          const desk = currentDesk();
          const now = Date.now();
          if (Object.keys(body.prices).length) {
            commitDesk({ ...desk, manualSpot: applyPrices(desk.manualSpot, body.prices, now), manual: applyBookPrices(desk.manual, body.prices, now) });
          }
          setMissing(body.missing);
          setError(body.error && body.missing.length ? body.error : null);
        })
        .catch((failure: unknown) => {
          if (!cancelled) setError(failure instanceof Error ? failure.message : "Price request failed");
        });
    void run();
    const timer = window.setInterval(run, PRICE_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [symbols, refreshKey]);

  return { missing: symbols ? missing : [], error: symbols ? error : null };
}
