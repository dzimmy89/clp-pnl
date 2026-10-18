import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTokenPrices, knownId, normalizeSymbol, pickSearchResult } from "./token-prices";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const LLAMA: Record<string, number> = { "coingecko:bitcoin": 100000, "coingecko:ethereum": 3000, "coingecko:canton-network": 0.15, "coingecko:big-foo": 2 };
const SEARCH: Record<string, unknown[]> = {
  CC: [
    { id: "canton-network", name: "Canton", symbol: "CC", market_cap_rank: 40 },
    { id: "some-cc", name: "Some CC", symbol: "cc", market_cap_rank: 2000 },
  ],
  FOO: [
    { id: "small-foo", name: "Small Foo", symbol: "FOO", market_cap_rank: null },
    { id: "big-foo", name: "Big Foo", symbol: "FOO", market_cap_rank: 300 },
    { id: "foobar", name: "Foobar", symbol: "FOOBAR", market_cap_rank: 1 },
  ],
};

function stubFetch() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.host === "coins.llama.fi") {
      const keys = decodeURIComponent(url.pathname.split("/").pop() ?? "").split(",");
      return json({ coins: Object.fromEntries(keys.filter((k) => k in LLAMA).map((k) => [k, { price: LLAMA[k] }])) });
    }
    if (url.host === "api.coingecko.com") return json({ coins: SEARCH[url.searchParams.get("query") ?? ""] ?? [] });
    return json({}, 404);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token prices", () => {
  it("normalizes tickers and rejects junk", () => {
    expect(normalizeSymbol(" cc ")).toBe("CC");
    expect(normalizeSymbol("a b")).toBeNull();
    expect(normalizeSymbol("")).toBeNull();
  });

  it("uses the ids the app already knows", () => {
    expect(knownId("ETH")).toBe("ethereum");
    expect(knownId("KAS")).toBe("kaspa");
    expect(knownId("CBTC")).toBe("bitcoin");
    expect(knownId("WETH")).toBe("weth");
    expect(knownId("NOPE")).toBeNull();
  });

  it("picks the biggest coin with the exact ticker", () => {
    expect(pickSearchResult("FOO", { coins: SEARCH.FOO as never })).toEqual({ id: "big-foo", name: "Big Foo" });
    expect(pickSearchResult("BAR", { coins: SEARCH.FOO as never })).toBeNull();
  });

  it("prices known tickers, searches the rest, and lists what it can't find", async () => {
    const calls = stubFetch();
    const result = await fetchTokenPrices(["eth", "CC", "foo", "zzz", "USDC", "USDCx", "CBTC"], 1e12);
    expect(result.prices.ETH).toEqual({ usd: 3000, id: "ethereum" });
    expect(result.prices.CBTC).toEqual({ usd: 100000, id: "bitcoin" });
    expect(result.prices.USDCX).toEqual({ usd: 1, id: "usd" });
    expect(result.prices.CC).toEqual({ usd: 0.15, id: "canton-network", name: "Canton" });
    expect(result.prices.FOO).toEqual({ usd: 2, id: "big-foo", name: "Big Foo" });
    expect(result.prices.USDC).toEqual({ usd: 1, id: "usd" });
    expect(result.missing).toEqual(["ZZZ"]);
    expect(result.error).toBeUndefined();
    // Stables and known tickers are never searched.
    expect(calls.filter((c) => c.includes("api.coingecko.com"))).toHaveLength(3);
  });

  it("remembers ticker lookups between requests", async () => {
    const calls = stubFetch();
    await fetchTokenPrices(["FOO"], 2e12);
    await fetchTokenPrices(["FOO"], 2e12 + 120_000);
    expect(calls.filter((c) => c.includes("api.coingecko.com"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("coins.llama.fi"))).toHaveLength(2);
  });

  it("reports a failed search without dropping the prices it found", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.host === "api.coingecko.com") return json({}, 429);
      return json({ coins: { "coingecko:ethereum": { price: 3100 } } });
    });
    const result = await fetchTokenPrices(["ETH", "QQQ"], 3e12);
    expect(result.prices.ETH.usd).toBe(3100);
    expect(result.missing).toEqual(["QQQ"]);
    expect(result.error).toMatch(/429/);
  });
});
