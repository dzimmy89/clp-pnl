import { describe, expect, it } from "vitest";
import { kaspaAddress, readKaspa } from "./kaspa";

const ADDRESS = "kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(kasplex: (url: URL) => Response) {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.host === "coins.llama.fi") {
      const prices: Record<string, number> = { "coingecko:kaspa": 0.1, "coingecko:nacho-the-kat": 0.0001 };
      const keys = decodeURIComponent(url.pathname.split("/").pop() ?? "").split(",");
      return json({ coins: Object.fromEntries(keys.filter((k) => k in prices).map((k) => [k, { price: prices[k], symbol: "X", timestamp: 1, confidence: 0.99 }])) });
    }
    if (url.host === "api.kaspa.org") return json({ address: ADDRESS, balance: 123456789012 });
    return kasplex(url);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("readKaspa", () => {
  it("reads KAS and every KRC-20 page, pricing what it can", async () => {
    const { fetch, calls } = mockFetch((url) =>
      url.searchParams.get("next")
        ? json({ message: "successful", prev: "a", next: null, result: [{ tick: "KASPER", balance: "500000000000", locked: "0", dec: "8", opScoreMod: "2" }] })
        : json({
            message: "successful",
            prev: null,
            next: "cursor-1",
            result: [{ tick: "NACHO", balance: "1000000000000000", locked: "200000000000000", dec: "8", opScoreMod: "1" }],
          }),
    );
    const read = await readKaspa(ADDRESS, { fetch });

    expect(calls).toContain(`https://api.kaspa.org/addresses/${ADDRESS}/balance`);
    expect(calls).toContain(`https://api.kasplex.org/v1/krc20/address/${ADDRESS}/tokenlist?next=cursor-1`);
    expect(read.spot.map((s) => [s.symbol, s.amount, s.usd, s.unpriced])).toEqual([
      ["NACHO", 12_000_000, 1200, false],
      ["KAS", 1234.56789012, 123.456789012, false],
      ["KASPER", 5000, 0, true],
    ]);
    expect(read.notes).toEqual([]);
  });

  it("keeps KAS when Kasplex fails", async () => {
    const { fetch } = mockFetch(() => json({ message: "error" }, 502));
    const read = await readKaspa(ADDRESS, { fetch });
    expect(read.spot.map((s) => s.symbol)).toEqual(["KAS"]);
    expect(read.notes).toEqual(["KRC-20: api.kasplex.org returned 502"]);
  });

  it("rejects bad addresses", () => {
    expect(() => kaspaAddress("kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfk")).toThrow(/checksum/);
    expect(() => kaspaAddress("bitcoin:abc")).toThrow();
    expect(kaspaAddress(ADDRESS.toUpperCase())).toBe(ADDRESS);
  });
});
