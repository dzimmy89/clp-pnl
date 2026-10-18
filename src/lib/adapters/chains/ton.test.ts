import { Address, beginCell, Cell, Dictionary, type DictionaryValue } from "@ton/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVAA_POOLS, evaaAssetId, evaaUserAddress, readTon } from "./ton";

const OWNER = "0:" + "ab".repeat(32);
const OWNER_ADDRESS = Address.parseRaw(OWNER);
const USDT_FRIENDLY = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const USDT = Address.parse(USDT_FRIENDLY).toRawString();
const TSTON = Address.parse("EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav").toRawString();
const STON_POOL = "EQD8TJ8xEWB1SpnRE4d89YO3jl0W0EiBnNS4IBaHaUmdfizE";
const STON_POOL_RAW = Address.parse(STON_POOL).toRawString();
const PTON = "EQBnGWMCf3-FZZq1W4IWcWiGAc3PHuZ0_H-7sad2oY00o83S";
const NOMINATOR_POOL = "0:" + "cd".repeat(32);

const MAIN_MASTER = Address.parse(EVAA_POOLS[0].master);
const MAIN_USER = evaaUserAddress(MAIN_MASTER, OWNER_ADDRESS);

const write = <T>(store: (src: T, builder: ReturnType<typeof beginCell>) => void): DictionaryValue<T> => ({
  serialize: store,
  parse: () => {
    throw new Error("unused");
  },
});

function assetConfig(decimals: number, liquidationThreshold: number) {
  return { decimals, liquidationThreshold };
}

/** A master data cell laid out like the EVAA master contract stores it. */
function masterData(): Cell {
  const configs = Dictionary.empty(
    Dictionary.Keys.BigUint(256),
    write<ReturnType<typeof assetConfig>>((src, b) => {
      b.storeUint(0, 256).storeUint(src.decimals, 8);
      b.storeRef(
        beginCell()
          .storeUint(7000, 16) // collateral factor
          .storeUint(src.liquidationThreshold, 16)
          .storeUint(10500, 16)
          .storeUint(1_000, 64) // base borrow rate per second, 1e12 scale
          .storeUint(2_000, 64)
          .storeUint(10_000, 64)
          .storeUint(0, 64)
          .storeUint(0, 64)
          .storeUint(800_000_000_000, 64) // target utilization 0.8
          .storeUint(0, 64)
          .storeUint(0, 64)
          .storeUint(0, 64)
          .storeUint(1_000, 16) // reserve factor 10%
          .storeUint(0, 16)
          .endCell(),
      );
    }),
  );
  configs.set(evaaAssetId("TON"), assetConfig(9, 8500));
  configs.set(evaaAssetId("USDT"), assetConfig(6, 9000));

  const assets = Dictionary.empty(
    Dictionary.Keys.BigUint(256),
    write<{ sRate: bigint; bRate: bigint; supply: bigint; borrow: bigint }>((src, b) => {
      b.storeUint(src.sRate, 64).storeUint(src.bRate, 64).storeInt(src.supply, 64).storeInt(src.borrow, 64);
      b.storeUint(0xffffffff, 32); // last accrual in the future: no accrual drift in the test
      b.storeUint(0, 64).storeUint(0, 64).storeUint(0, 64).storeUint(0, 64);
    }),
  );
  const rate = (n: number) => BigInt(Math.round(n * 1e12));
  assets.set(evaaAssetId("TON"), { sRate: rate(1.05), bRate: rate(1.1), supply: BigInt(1000e9), borrow: BigInt(500e9) });
  assets.set(evaaAssetId("USDT"), { sRate: rate(1.02), bRate: rate(1.1), supply: BigInt(1000e6), borrow: BigInt(100e6) });

  return beginCell()
    .storeRef(beginCell().storeStringTail("evaa").endCell())
    .storeRef(beginCell().storeCoins(11).storeCoins(5).endCell())
    .storeRef(beginCell().storeDict(configs).storeBit(1).endCell())
    .storeDict(assets)
    .endCell();
}

function userData(): Cell {
  const principals = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(64));
  principals.set(evaaAssetId("TON"), BigInt(100e9));
  principals.set(evaaAssetId("USDT"), BigInt(-200e6));
  return beginCell()
    .storeCoins(5)
    .storeAddress(MAIN_MASTER)
    .storeAddress(OWNER_ADDRESS)
    .storeDict(principals)
    .storeInt(0, 64)
    .endCell();
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Override = (url: URL) => Response | undefined;

function mockFetch(override: Override = () => undefined) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), headers: (init?.headers ?? {}) as Record<string, string> });
    const custom = override(url);
    if (custom) return custom;
    const path = decodeURIComponent(url.pathname);

    if (url.host === "tonapi.io") {
      if (path === `/v2/accounts/${OWNER}`) return json({ address: OWNER, balance: 12_500_000_000, status: "active" });
      if (path === `/v2/accounts/${OWNER}/jettons`) {
        return json({
          balances: [
            {
              balance: "250000000",
              price: { prices: { USD: 1 }, diff_24h: { USD: "0.00%" } },
              wallet_address: { address: "0:" + "11".repeat(32), is_scam: false, is_wallet: false },
              jetton: { address: USDT, name: "Tether USD", symbol: "USD₮", decimals: 6, image: "", verification: "whitelist", score: 100 },
            },
            {
              balance: "2000000000",
              price: { prices: { USD: 3.3 } },
              wallet_address: { address: "0:" + "12".repeat(32), is_scam: false, is_wallet: false },
              jetton: { address: TSTON, name: "Tonstakers TON", symbol: "tsTON", decimals: 9, image: "", verification: "whitelist", score: 100 },
            },
            {
              balance: "999000000000",
              price: { prices: { USD: 0 } },
              wallet_address: { address: "0:" + "13".repeat(32), is_scam: false, is_wallet: false },
              jetton: { address: "0:" + "77".repeat(32), name: "Free Airdrop", symbol: "FREE", decimals: 9, image: "", verification: "none", score: 0 },
            },
            {
              balance: "5000000000",
              wallet_address: { address: "0:" + "14".repeat(32), is_scam: false, is_wallet: false },
              jetton: { address: STON_POOL_RAW, name: "STON.fi pTON-USD₮ LP", symbol: "pTON-USD₮ LP", decimals: 9, image: "", verification: "whitelist", score: 0 },
            },
          ],
        });
      }
      if (path === `/v2/staking/nominator/${OWNER}/pools`) {
        return json({ pools: [{ pool: NOMINATOR_POOL, amount: 50_000_000_000, pending_deposit: 0, pending_withdraw: 1_000_000_000, ready_withdraw: 0 }] });
      }
      if (path === `/v2/staking/pool/${NOMINATOR_POOL}`) {
        return json({
          implementation: { name: "TON Whales", description: "", url: "https://tonwhales.com", socials: [] },
          pool: { address: NOMINATOR_POOL, name: "Whales Nominators #1", apy: 4.2, implementation: "whales", total_amount: 1, min_stake: 1 },
        });
      }
    }

    if (url.host === "toncenter.com" && path === "/api/v3/accountStates") {
      const accounts = url.searchParams.getAll("address").map((a) => {
        const address = Address.parse(a);
        const base = { address: address.toRawString().toUpperCase(), balance: "0", status: "nonexist", data_boc: null };
        if (address.equals(MAIN_USER)) return { ...base, status: "active", data_boc: userData().toBoc().toString("base64") };
        if (address.equals(MAIN_MASTER)) return { ...base, status: "active", data_boc: masterData().toBoc().toString("base64") };
        return base;
      });
      return json({ accounts, address_book: {} });
    }

    if (url.host === "coins.llama.fi") {
      const keys = path.replace("/prices/current/", "").split(",");
      const table: Record<string, number> = {
        "coingecko:the-open-network": 3,
        [`ton:${USDT_FRIENDLY}`]: 1,
      };
      const coins: Record<string, { price: number }> = {};
      for (const key of keys) if (table[key]) coins[key] = { price: table[key] };
      return json({ coins });
    }

    if (url.host === "api.ston.fi") {
      if (path.endsWith("/pools")) {
        return json({
          pool_list: [
            {
              address: STON_POOL,
              router_address: "EQ...",
              reserve0: "1000000000000",
              reserve1: "3000000000",
              token0_address: PTON,
              token1_address: USDT_FRIENDLY,
              lp_total_supply: "50000000000",
              lp_balance: "5000000000",
              lp_fee: "20",
              protocol_fee: "10",
              ref_fee: "10",
              deprecated: false,
              apy_7d: "0.12",
            },
          ],
        });
      }
      if (path === `/v1/assets/${PTON}`) return json({ asset: { contract_address: PTON, symbol: "pTON", decimals: 9, kind: "Wton", dex_price_usd: "3.0" } });
      if (path === `/v1/assets/${USDT_FRIENDLY}`) return json({ asset: { contract_address: USDT_FRIENDLY, symbol: "USD₮", decimals: 6, kind: "Jetton", dex_price_usd: "1.0" } });
    }
    return json({ error: "not found" }, 404);
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

beforeEach(() => {
  vi.stubEnv("TONAPI_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readTon", () => {
  it("reads balances, nominator stakes, EVAA lending and STON.fi liquidity", async () => {
    const { fetch, calls } = mockFetch();
    const read = await readTon(OWNER, { fetch });
    expect(read.notes).toEqual([]);

    expect(read.spot.map((s) => [s.symbol, s.amount, s.usd])).toEqual([
      ["TON", 12.5, 37.5],
      ["tsTON", 2, 6.6],
      ["USD₮", 250, 250],
    ].sort((a, b) => Number(b[2]) - Number(a[2])));
    expect(read.spot.find((s) => s.symbol === "FREE")).toBeUndefined();
    expect(read.spot.find((s) => s.symbol.includes("LP"))).toBeUndefined();
    expect(calls.find((c) => c.url.startsWith("https://tonapi.io"))?.headers.authorization).toBe("Bearer test-key");

    const evaa = read.positions.find((p) => p.app === "EVAA")!;
    expect(evaa.category).toBe("lending");
    expect(evaa.label).toBe("EVAA Lending · TON");
    const [supply, borrow] = evaa.legs;
    expect([supply.side, supply.symbol, supply.amount, supply.usd, supply.liquidationThreshold, supply.isCollateral]).toEqual([
      "supply", "TON", 105, 315, 0.85, true,
    ]);
    expect([borrow.side, borrow.symbol, borrow.amount, borrow.usd, borrow.isCollateral]).toEqual(["borrow", "USDT", 220, 220, false]);
    expect(supply.apy).toBeGreaterThan(0);
    expect(borrow.apy).toBeGreaterThan(supply.apy);
    expect(evaa.healthFactorSource).toBe("estimated");

    const stake = read.positions.find((p) => p.category === "staking")!;
    expect(stake.app).toBe("TON Whales");
    expect(stake.legs.map((l) => [l.amount, l.usd, l.apy])).toEqual([
      [50, 150, 0.042],
      [1, 3, 0],
    ]);

    const lp = read.positions.find((p) => p.app === "STON.fi")!;
    expect(lp.category).toBe("liquidity");
    expect(lp.label).toBe("STON.fi TON/USD₮ · TON");
    expect(lp.legs.map((l) => [l.symbol, l.amount, l.usd, l.apy])).toEqual([
      ["TON", 100, 300, 0.12],
      ["USD₮", 300, 300, 0.12],
    ]);
  });

  it("turns one failing app into a note and keeps the rest", async () => {
    const { fetch } = mockFetch((url) => (url.host === "api.ston.fi" ? json({ error: "boom" }, 500) : undefined));
    const read = await readTon(OWNER, { fetch });
    expect(read.notes).toEqual(["STON.fi: api.ston.fi returned 500"]);
    expect(read.positions.map((p) => p.app).sort()).toEqual(["EVAA", "TON Whales"]);
    expect(read.spot.length).toBeGreaterThan(0);
  });

  it("falls back to toncenter for balances when tonapi is down", async () => {
    const { fetch } = mockFetch((url) => {
      if (url.host === "tonapi.io") return json({ error: "rate limit" }, 429);
      if (url.host === "toncenter.com" && url.pathname === "/api/v3/jetton/wallets") {
        return json({
          jetton_wallets: [
            { address: "0:" + "11".repeat(32), balance: "250000000", owner: OWNER.toUpperCase(), jetton: USDT.toUpperCase(), last_transaction_lt: "1" },
            { address: "0:" + "13".repeat(32), balance: "999000000000", owner: OWNER.toUpperCase(), jetton: "0:" + "77".repeat(32), last_transaction_lt: "1" },
          ],
          address_book: {},
          metadata: {
            [USDT.toUpperCase()]: { is_indexed: true, token_info: [{ symbol: "USD₮", name: "Tether USD", type: "jetton_masters", extra: { decimals: "6" }, valid: true }] },
          },
        });
      }
      if (url.host === "toncenter.com" && url.searchParams.get("include_boc") === "false") {
        return json({ accounts: [{ address: OWNER.toUpperCase(), balance: "12500000000", status: "active" }] });
      }
      return undefined;
    });
    const read = await readTon(OWNER, { fetch });
    expect(read.spot.map((s) => [s.symbol, s.usd])).toEqual([
      ["USD₮", 250],
      ["TON", 37.5],
    ]);
    expect(read.notes.some((n) => n.startsWith("tonapi.io unavailable"))).toBe(true);
    expect(read.notes.some((n) => n.startsWith("TON staking:"))).toBe(true);
    expect(read.positions.some((p) => p.app === "EVAA")).toBe(true);
  });

  it("rejects input that is not a TON address", async () => {
    await expect(readTon("not-an-address")).rejects.toThrow("Not a TON address");
  });
});
