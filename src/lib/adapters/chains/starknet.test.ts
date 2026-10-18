import { hash } from "starknet";
import { describe, expect, it } from "vitest";
import { readStarknet } from "./starknet";

const OWNER = `0x04${"a".repeat(62)}`;
const ETH = "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7";
const USDC = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
const WBTC = "0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac";
const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const NOSTRA_IETH_C = "0x044debfe17e4d9a5a1e226dabaf286e72c9cc36abbe71c5b847e669da4503893";
const NOSTRA_D_USDC = "0x063d69ae657bd2f40337c39bf35a870ac27ddf91e6623c2f52529db4c1619a51";
const NOSTRA_D_ETH = "0x00ba3037d968790ac486f70acaa9a1cab10cf5843bb85c986624b4d0e5a82e74";
const NOSTRA_IRM = "0x059a943ca214c10234b9a3b61c558ac20c005127d183b86a99a8f3c60a08b4ff";
const POOL = "0x0451fe483d5921a2919ddd81d0de6696669bccdacd859f72a4fba7656b97c3b5";

const SEL = {
  balanceOf: hash.getSelectorFromName("balanceOf"),
  symbol: hash.getSelectorFromName("symbol"),
  getInterestState: hash.getSelectorFromName("getInterestState"),
};
const hex = (value: bigint) => `0x${value.toString(16)}`;
const text = (value: string) => `0x${Buffer.from(value, "latin1").toString("hex")}`;

const BALANCES: Record<string, bigint> = {
  [ETH]: 5n * 10n ** 17n,
  [USDC]: 100_000_000n,
  [NOSTRA_IETH_C]: 10n ** 18n,
  [NOSTRA_D_USDC]: 200_000_000n,
};

interface StarknetCall {
  request: { contract_address: string; entry_point_selector: string; calldata: string[] };
}

function answer(params: StarknetCall): string[] {
  const { contract_address: contract, entry_point_selector: selector, calldata } = params.request;
  if (selector === SEL.balanceOf) {
    expect(calldata).toEqual([OWNER]);
    return [hex(BALANCES[contract] ?? 0n), "0x0"];
  }
  if (selector === SEL.symbol && contract === NOSTRA_IETH_C) return [text("iETH-c")];
  if (selector === SEL.getInterestState && contract === NOSTRA_IRM) {
    const [lend, borrow] = calldata[0] === NOSTRA_D_ETH ? [2n * 10n ** 16n, 5n * 10n ** 16n] : [3n * 10n ** 16n, 6n * 10n ** 16n];
    return [hex(lend), "0x0", hex(borrow), "0x0", "0x6650f2c0", "0x0", "0x0", "0x0", "0x0"];
  }
  throw new Error("unexpected call");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const usd = (value: string) => ({ value, decimals: 18 });

function mockFetch(options: { vesu?: number; noBatch?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.zan.top/public/starknet-mainnet/rpc/v0_10") {
      const body = JSON.parse(String(init?.body));
      if (Array.isArray(body)) {
        if (options.noBatch) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch requests are not supported" } }, 400);
        return json(body.map((req: { id: number; params: StarknetCall }) => ({ jsonrpc: "2.0", id: req.id, result: answer(req.params) })));
      }
      return json({ jsonrpc: "2.0", id: body.id, result: answer(body.params) });
    }
    if (url.startsWith("https://coins.llama.fi/prices/current/")) {
      const keys = decodeURIComponent(url.split("/current/")[1]).split(",");
      const table: Record<string, number> = { [`starknet:${ETH}`]: 3000, "coingecko:usd-coin": 1 };
      return json({ coins: Object.fromEntries(keys.filter((k) => table[k]).map((k) => [k, { price: table[k] }])) });
    }
    if (url === `https://api.vesu.xyz/positions?walletAddress=${OWNER}`) {
      if (options.vesu) return json({ error: "down" }, options.vesu);
      return json({
        data: [
          {
            protocolVersion: "v2",
            type: "borrow",
            pool: { id: POOL, name: "Prime", extensionContractAddress: null },
            walletAddress: OWNER,
            collateralShares: { address: "0x1", name: "vWBTC", symbol: "vWBTC", decimals: 18, value: "1" },
            collateral: { address: WBTC, name: "Wrapped BTC", symbol: "WBTC", decimals: 8, value: "10000000", usdPrice: usd("60000000000000000000000") },
            nominalDebt: { address: USDC, name: "USDC", symbol: "USDC", decimals: 6, value: "1000000000" },
            debt: { address: USDC, name: "USDC", symbol: "USDC", decimals: 6, value: "1000000000", usdPrice: usd("1000000000000000000") },
            ltv: { max: usd("800000000000000000"), current: usd("166666666666666666") },
            healthFactor: "4.8",
            rebalancing: { isEnabled: false },
          },
          {
            protocolVersion: "v2",
            type: "earn",
            isDeprecated: false,
            pool: { id: POOL, name: "Prime", extensionContractAddress: null },
            walletAddress: OWNER,
            collateralShares: { address: "0x2", name: "vSTRK", symbol: "vSTRK", decimals: 18, value: "1" },
            collateral: { address: STRK, name: "Starknet", symbol: "STRK", decimals: 18, value: "1000000000000000000000", usdPrice: usd("150000000000000000") },
          },
        ],
      });
    }
    if (url === "https://api.vesu.xyz/markets") {
      return json({
        data: [
          { pool: { id: POOL }, address: WBTC, symbol: "WBTC", stats: { supplyApy: usd("10000000000000000"), borrowApr: usd("20000000000000000") } },
          { pool: { id: POOL }, address: USDC, symbol: "USDC", stats: { supplyApy: usd("40000000000000000"), borrowApr: usd("60000000000000000") } },
        ],
      });
    }
    return json({ message: `unexpected ${url}` }, 404);
  }) as typeof fetch;
}

describe("readStarknet", () => {
  it("reads token balances, Vesu and Nostra", async () => {
    const read = await readStarknet(OWNER, { fetch: mockFetch() });
    expect(read.notes).toEqual([]);
    expect(read.spot.map((s) => [s.symbol, s.amount, s.usd])).toEqual([
      ["ETH", 0.5, 1500],
      ["USDC", 100, 100],
    ]);

    const vesu = read.positions.filter((p) => p.app === "Vesu");
    expect(vesu).toHaveLength(2);
    const borrow = vesu.find((p) => p.legs.some((l) => l.side === "borrow"))!;
    expect(borrow.healthFactor).toBeCloseTo(4.8);
    expect(borrow.label).toBe("Vesu Prime · WBTC/USDC");
    expect(borrow.legs.map((l) => [l.side, l.symbol, l.amount, l.usd, l.isCollateral])).toEqual([
      ["supply", "WBTC", 0.1, 6000, true],
      ["borrow", "USDC", 1000, 1000, false],
    ]);
    expect(borrow.legs[0].apy).toBeCloseTo(0.01);
    expect(borrow.legs[1].apy).toBeCloseTo(0.06);
    const earn = vesu.find((p) => p !== borrow)!;
    expect(earn.legs.map((l) => [l.symbol, l.amount, l.usd, l.isCollateral])).toEqual([["STRK", 1000, 150, false]]);
    expect(earn.healthFactor).toBeNull();

    const nostra = read.positions.find((p) => p.app === "Nostra")!;
    expect(nostra.category).toBe("lending");
    expect(nostra.legs.map((l) => [l.side, l.symbol, l.amount, l.usd, l.isCollateral])).toEqual([
      ["supply", "ETH", 1, 3000, true],
      ["borrow", "USDC.e", 200, 200, false],
    ]);
    expect(nostra.legs[0].apy).toBeCloseTo(0.02);
    expect(nostra.legs[1].apy).toBeCloseTo(0.06);
  });

  it("turns a failing app into a note and keeps the rest", async () => {
    const read = await readStarknet(OWNER, { fetch: mockFetch({ vesu: 500 }) });
    expect(read.notes).toEqual(["Vesu: api.vesu.xyz returned 500"]);
    expect(read.positions.map((p) => p.app)).toEqual(["Nostra"]);
    expect(read.spot).toHaveLength(2);
  });

  it("falls back to single calls when the node rejects batches", async () => {
    const read = await readStarknet(OWNER, { fetch: mockFetch({ noBatch: true }) });
    expect(read.spot.map((s) => s.symbol)).toEqual(["ETH", "USDC"]);
    expect(read.positions.find((p) => p.app === "Nostra")?.legs).toHaveLength(2);
  });

  it("rejects input that is not a Starknet address", async () => {
    await expect(readStarknet("0xzz", { fetch: mockFetch() })).rejects.toThrow("Starknet address");
  });
});
