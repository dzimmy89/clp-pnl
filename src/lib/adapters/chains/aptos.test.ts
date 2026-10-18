import { describe, expect, it } from "vitest";
import { readAptos } from "./aptos";

const OWNER = `0x${"ab".repeat(32)}`;
const POOL = `0x${"11".repeat(32)}`;
const ECHELON = "0xc6bc659f1649553c1a3fa05d9727433dc03843baac29473c817d06d39e7621ba";
const M_APT = `0x${"a1".repeat(32)}`;
const M_USDC = `0x${"a2".repeat(32)}`;
const APT = "0x1::aptos_coin::AptosCoin";
const USDC_FA = "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b";
const ZUSDC = "0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::USDC";

const fp = (value: number) => ({ v: (BigInt(Math.round(value * 1e9)) * 2n ** 64n / 1_000_000_000n).toString() });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Overrides = { aries?: number; indexer?: number };

function mockFetch(overrides: Overrides = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.startsWith("https://coins.llama.fi/prices/current/")) {
      const keys = decodeURIComponent(url.split("/current/")[1]).split(",");
      const table: Record<string, number> = { [`aptos:${APT}`]: 10, [`aptos:${USDC_FA}`]: 1, "coingecko:usd-coin": 1 };
      return json({ coins: Object.fromEntries(keys.filter((k) => table[k]).map((k) => [k, { price: table[k] }])) });
    }
    if (url === "https://api.mainnet.aptoslabs.com/v1/graphql") {
      if (overrides.indexer) return json({ message: "down" }, overrides.indexer);
      const query: string = body.query;
      if (query.includes("current_fungible_asset_balances")) {
        return json({
          data: {
            current_fungible_asset_balances: [
              { asset_type: APT, amount: 150000000, metadata: { symbol: "APT", decimals: 8 } },
              { asset_type: "0xa", amount: 150000000, metadata: { symbol: "APT", decimals: 8 } },
              { asset_type: USDC_FA, amount: 2500000, metadata: { symbol: "USDC", decimals: 6 } },
              { asset_type: "0xdead::spam::SPAM", amount: 1000, metadata: { symbol: "SPAM", decimals: 0 } },
            ],
          },
        });
      }
      if (query.includes("current_delegator_balances")) {
        return json({ data: { current_delegator_balances: [{ pool_address: POOL, shares: 1000 }] } });
      }
      if (query.includes("fungible_asset_metadata")) return json({ data: { fungible_asset_metadata: [] } });
    }
    if (url === `https://api.mainnet.aptoslabs.com/v1/accounts/${OWNER}/balance/${APT}`) return json(150000000);
    if (url === "https://api.mainnet.aptoslabs.com/v1/view") {
      const fn: string = body.function;
      if (fn === "0x1::delegation_pool::get_stake") return json(["1000000000", "0", "50000000"]);
      if (fn.endsWith("::account_coins")) return json(["200000000"]);
      if (fn.endsWith("::account_liability")) return json(["5000000"]);
      if (fn.endsWith("::supply_interest_rate")) return json([fp(0.03)]);
      if (fn.endsWith("::borrow_interest_rate")) return json([fp(0.08)]);
      if (fn.endsWith("::account_liquidation_threshold")) return json([fp(20)]);
      if (fn.endsWith("::account_liability_value")) return json([fp(10)]);
    }
    if (url === `https://api.mainnet.aptoslabs.com/v1/accounts/${OWNER}/resource/${ECHELON}::lending::Vault`) {
      return json({
        type: `${ECHELON}::lending::Vault`,
        data: {
          efficiency_mode_id: 0,
          collaterals: { data: [{ key: { inner: M_APT }, value: "190000000" }] },
          liabilities: {
            data: [{ key: { inner: M_USDC }, value: { principal: "5000000", interest_accumulated: "0", last_interest_rate_index: { v: "0" } } }],
          },
        },
      });
    }
    if (url === `https://api.mainnet.aptoslabs.com/v1/accounts/${M_APT}/resources`) {
      return json([
        { type: `${ECHELON}::lending::Market`, data: { asset_name: "APT", asset_mantissa: "100000000" } },
        { type: `${ECHELON}::lending::CoinInfo`, data: { type_name: APT } },
        { type: `${ECHELON}::lending::MarketLiquidationThreshold`, data: { value_bps: "7500" } },
      ]);
    }
    if (url === `https://api.mainnet.aptoslabs.com/v1/accounts/${M_USDC}/resources`) {
      return json([
        { type: `${ECHELON}::lending::Market`, data: { asset_name: "USDC", asset_mantissa: "1000000" } },
        { type: `${ECHELON}::lending::FungibleAssetInfo`, data: { metadata: { inner: USDC_FA } } },
      ]);
    }
    if (url.startsWith("https://api-v2.ariesmarkets.xyz/profile.find?input=")) {
      if (overrides.aries) return json({ error: "boom" }, overrides.aries);
      expect(JSON.parse(decodeURIComponent(url.split("input=")[1]))).toEqual({ owner: OWNER });
      return json({
        result: {
          data: {
            profiles: {
              "0xprofile": {
                profileName: "Main Account",
                deposits: { [APT]: { collateral_amount: 290000000, collateral_coins: 300000000, collateral_value: 30 } },
                borrows: { [ZUSDC]: { borrowed_share: 9000000, borrowed_coins: 10000000, borrowed_value: 10 } },
                equity: 20,
                riskFactor: 0.4,
                collateralValue: 30,
                loanValue: 10,
              },
            },
            total_equity: 20,
          },
        },
      });
    }
    if (url === "https://api-v2.ariesmarkets.xyz/reserve.current") {
      return json({
        result: {
          data: {
            stats: [
              {
                key: APT,
                value: {
                  total_borrowed: 50,
                  total_cash_available: 50,
                  reserve_amount: 0,
                  reserve_config: { reserve_ratio: 10, liquidation_threshold: 75 },
                  interest_rate_config: { min_borrow_rate: 0, optimal_borrow_rate: 10, max_borrow_rate: 100, optimal_utilization: 80 },
                },
              },
            ],
          },
        },
      });
    }
    return json({ message: `unexpected ${url}` }, 404);
  }) as typeof fetch;
}

describe("readAptos", () => {
  it("reads balances, delegated stake, Aries and Echelon", async () => {
    const read = await readAptos(OWNER, { fetch: mockFetch() });
    expect(read.notes).toEqual([]);

    expect(read.spot.map((s) => [s.symbol, s.amount, s.usd, s.unpriced])).toEqual([
      ["APT", 1.5, 15, false],
      ["USDC", 2.5, 2.5, false],
      ["SPAM", 1000, 0, true],
    ]);

    const stake = read.positions.find((p) => p.app === "Aptos Staking");
    expect(stake?.category).toBe("staking");
    expect(stake?.legs[0].amount).toBeCloseTo(10.5);
    expect(stake?.legs[0].usd).toBeCloseTo(105);

    const aries = read.positions.find((p) => p.app === "Aries Markets");
    expect(aries?.category).toBe("lending");
    expect(aries?.healthFactor).toBeCloseTo(2.5);
    const [supply, borrow] = aries!.legs;
    expect([supply.side, supply.symbol, supply.amount, supply.usd, supply.isCollateral]).toEqual(["supply", "APT", 3, 30, true]);
    expect(supply.apy).toBeCloseTo(0.028125);
    expect(supply.liquidationThreshold).toBe(0.75);
    expect([borrow.side, borrow.symbol, borrow.amount, borrow.usd]).toEqual(["borrow", "USDC", 10, 10]);

    const echelon = read.positions.find((p) => p.app === "Echelon");
    expect(echelon?.healthFactor).toBeCloseTo(2);
    expect(echelon?.legs.map((l) => [l.side, l.symbol, l.amount, l.usd])).toEqual([
      ["supply", "APT", 2, 20],
      ["borrow", "USDC", 5, 5],
    ]);
    expect(echelon?.legs[0].apy).toBeCloseTo(0.03);
    expect(echelon?.legs[0].liquidationThreshold).toBe(0.75);
    expect(echelon?.legs[1].apy).toBeCloseTo(0.08);
  });

  it("turns a failing app into a note and keeps the rest", async () => {
    const read = await readAptos(OWNER, { fetch: mockFetch({ aries: 500 }) });
    expect(read.notes).toEqual(["Aries Markets: api-v2.ariesmarkets.xyz returned 500"]);
    expect(read.positions.map((p) => p.app).sort()).toEqual(["Aptos Staking", "Echelon"]);
    expect(read.spot.length).toBe(3);
  });

  it("falls back to the fullnode APT balance when the indexer is down", async () => {
    const read = await readAptos(OWNER, { fetch: mockFetch({ indexer: 503 }) });
    expect(read.spot.map((s) => [s.symbol, s.amount])).toEqual([["APT", 1.5]]);
    expect(read.notes).toContain("Aptos indexer unavailable: showing APT only");
    expect(read.notes.some((n) => n.startsWith("Aptos staking:"))).toBe(true);
  });

  it("rejects input that is not an Aptos address", async () => {
    await expect(readAptos("not-an-address", { fetch: mockFetch() })).rejects.toThrow("Aptos address");
  });
});
