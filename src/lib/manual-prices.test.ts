import { describe, expect, it } from "vitest";
import type { Position, SpotHolding } from "@/lib/types";
import { applyBookPrices, applyPrices, autoSymbols } from "./manual-prices";

function holding(id: string, symbol: string, amount: number, priceUsd: number, extra: Partial<SpotHolding> = {}): SpotHolding {
  return { id, wallet: "manual", chain: "Canton", symbol, underlying: symbol, kind: "volatile", amount, usd: amount * priceUsd, priceUsd, source: "manual", ...extra };
}

describe("manual balance prices", () => {
  const balances = [holding("a", "cc", 100, 0.1), holding("b", "CC", 5, 0.1), holding("c", "XYZ", 2, 7, { fixedPrice: true }), holding("d", "ETH", 1, 2000)];

  it("lists each market-priced ticker once", () => {
    expect(autoSymbols(balances)).toEqual(["CC", "ETH"]);
  });

  it("revalues market-priced balances and leaves fixed and unpriced ones alone", () => {
    const next = applyPrices(balances, { CC: { usd: 0.2, id: "canton-network", name: "Canton" } }, 42);
    expect(next[0]).toMatchObject({ priceUsd: 0.2, usd: 20, pricedAt: 42, priceName: "Canton" });
    expect(next[1]).toMatchObject({ priceUsd: 0.2, usd: 1 });
    expect(next[2]).toBe(balances[2]);
    expect(next[3]).toBe(balances[3]);
  });

  const book: Position = {
    id: "manual:1",
    protocol: "alpend",
    chain: "Canton",
    wallet: "manual",
    label: "CBTC loop",
    source: "manual",
    legs: [
      { id: "s", side: "supply", symbol: "cbtc", underlying: "BTC", kind: "btc", amount: 2, usd: 180000, apy: 0.01, priceUsd: 90000 },
      { id: "b", side: "borrow", symbol: "USDCX", underlying: "USDCX", kind: "stable", amount: 50000, usd: 50000, apy: 0.06, priceUsd: 1, fixedPrice: true },
    ],
  };

  it("includes book legs that follow the market", () => {
    expect(autoSymbols([], [book])).toEqual(["CBTC"]);
    expect(autoSymbols([balances[0]], [book])).toEqual(["CBTC", "CC"]);
  });

  it("revalues market-priced legs and leaves fixed ones alone", () => {
    const [next] = applyBookPrices([book], { CBTC: { usd: 100000, id: "bitcoin" } }, Date.UTC(2026, 9, 11));
    expect(next.legs[0]).toMatchObject({ priceUsd: 100000, usd: 200000, pricedAt: Date.UTC(2026, 9, 11) });
    expect(next.legs[1]).toBe(book.legs[1]);
    expect(next.fetchedAt).toBe("2026-10-11T00:00:00.000Z");
    expect(applyBookPrices([book], {}, 1)[0]).toBe(book);
  });
});
