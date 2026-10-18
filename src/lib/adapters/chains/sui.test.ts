import { describe, expect, it } from "vitest";
import { dynamicFieldId, normalizeCoinType, readSui } from "./sui";

const OWNER = `0x${"ab".repeat(32)}`;
const SUI = "0x2::sui::SUI";
const SUI_NAME = `${"0".repeat(63)}2::sui::SUI`;
const USDC_PKG = "dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7";
const USDC = `0x${USDC_PKG}::usdc::USDC`;
const USDC_NAME = `${USDC_PKG}::usdc::USDC`;
const SSUI = "0xaafc4f740de0dd0dde642a31148fb94517087052f19afb0f7bed1dc41a50c77b::scallop_sui::SCALLOP_SUI";
const SPAM = `0x${"5a".repeat(32)}::claim::CLAIM`;

const SUILEND_PKG = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const SUILEND_MARKET = "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1";
const NAVI_RESERVES = "0xe6d4c6610b86ce7735ea754596d71d72d10c7980b5052fc3c8cdf8d09fea9b4b";
const SCALLOP_PKG = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const SCALLOP_MARKET = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";

const id = (byte: string) => `0x${byte.repeat(32)}`;
const PRICES: Record<string, number> = { [`sui:${SUI}`]: 3, [`sui:${USDC}`]: 1 };

const typeName = (name: string) => ({ type: "0x1::type_name::TypeName", fields: { name } });
const decimal = (value: string) => ({ type: `${SUILEND_PKG}::decimal::Decimal`, fields: { value } });
const fixed32 = (value: number) => ({ type: "0x1::fixed_point32::FixedPoint32", fields: { value: String(Math.round(value * 2 ** 32)) } });
const table = (tableId: string) => ({ type: "0x2::table::Table<0x1::type_name::TypeName, u64>", fields: { id: { id: tableId }, size: "2" } });
const witTable = (tableId: string) => ({ type: "0x779b::wit_table::WitTable", fields: { id: { id: id("77") }, table: table(tableId), keys: null, with_keys: false } });
const moveObject = (type: string, fields: Record<string, unknown>) => ({ dataType: "moveObject", type, hasPublicTransfer: false, fields });

// --- Suilend -------------------------------------------------------------------------------------

const SUILEND_OBLIGATION = id("0b");
function suilendReserve(name: string, opts: { decimals: number; available: string; borrowed: string; ctokens: string; cumulative: string; price: string; closeLtv: number }) {
  return {
    type: `${SUILEND_PKG}::reserve::Reserve<${SUILEND_PKG}::suilend::MAIN_POOL>`,
    fields: {
      id: { id: id("e1") },
      lending_market_id: SUILEND_MARKET,
      array_index: "0",
      coin_type: typeName(name),
      config: {
        type: `${SUILEND_PKG}::cell::Cell<${SUILEND_PKG}::reserve_config::ReserveConfig>`,
        fields: {
          element: {
            type: `${SUILEND_PKG}::reserve_config::ReserveConfig`,
            fields: {
              open_ltv_pct: opts.closeLtv - 5,
              close_ltv_pct: opts.closeLtv,
              max_close_ltv_pct: opts.closeLtv,
              borrow_weight_bps: "10000",
              interest_rate_utils: [0, 80, 100],
              interest_rate_aprs: ["0", "1000", "20000"],
              spread_fee_bps: "2000",
            },
          },
        },
      },
      mint_decimals: opts.decimals,
      price: decimal(opts.price),
      smoothed_price: decimal(opts.price),
      available_amount: opts.available,
      ctoken_supply: opts.ctokens,
      borrowed_amount: decimal(opts.borrowed),
      cumulative_borrow_rate: decimal(opts.cumulative),
      unclaimed_spread_fees: decimal("0"),
    },
  };
}

const suilendMarket = moveObject(`${SUILEND_PKG}::lending_market::LendingMarket<${SUILEND_PKG}::suilend::MAIN_POOL>`, {
  id: { id: SUILEND_MARKET },
  reserves: [
    // 4M SUI borrowed of 10M, 8M cTokens: 1.25 SUI per cToken, 40% utilization.
    suilendReserve(SUI_NAME, { decimals: 9, available: "6000000000000000", borrowed: "4000000000000000000000000000000000", ctokens: "8000000000000000", cumulative: "1100000000000000000", price: "3500000000000000000", closeLtv: 75 }),
    suilendReserve(USDC_NAME, { decimals: 6, available: "3000000000000", borrowed: "1000000000000000000000000000000", ctokens: "4000000000000", cumulative: "1050000000000000000", price: "1000000000000000000", closeLtv: 77 }),
  ],
});

const suilendObligation = moveObject(`${SUILEND_PKG}::obligation::Obligation<${SUILEND_PKG}::suilend::MAIN_POOL>`, {
  id: { id: SUILEND_OBLIGATION },
  deposits: [
    {
      type: `${SUILEND_PKG}::obligation::Deposit`,
      fields: { coin_type: typeName(SUI_NAME), reserve_array_index: "0", deposited_ctoken_amount: "1000000000000", market_value: decimal("0"), user_reward_manager_index: "0", attributed_borrow_value: decimal("0") },
    },
  ],
  borrows: [
    {
      type: `${SUILEND_PKG}::obligation::Borrow`,
      fields: {
        coin_type: typeName(USDC_NAME),
        reserve_array_index: "1",
        borrowed_amount: decimal("1000000000000000000000000000"),
        cumulative_borrow_rate: decimal("1000000000000000000"),
        market_value: decimal("0"),
        user_reward_manager_index: "1",
      },
    },
  ],
});

// --- NAVI ----------------------------------------------------------------------------------------

const NAVI_TABLES = { suiSupply: id("a1"), suiBorrow: id("a2"), usdcSupply: id("a3"), usdcBorrow: id("a4") };
function naviReserve(index: number, coinType: string, supply: string, borrow: string, supplyIndex: string, borrowIndex: string, threshold: string) {
  return moveObject(`0x2::dynamic_field::Field<u8, 0xd899::storage::ReserveData>`, {
    id: { id: id(`c${index}`) },
    name: index,
    value: {
      type: "0xd899::storage::ReserveData",
      fields: {
        id: index,
        oracle_id: index,
        coin_type: coinType,
        is_isolated: false,
        supply_cap_ceiling: "0",
        borrow_cap_ceiling: "0",
        current_supply_rate: "30000000000000000000000000",
        current_borrow_rate: "60000000000000000000000000",
        current_supply_index: supplyIndex,
        current_borrow_index: borrowIndex,
        supply_balance: { type: "0xd899::storage::TokenBalance", fields: { user_state: table(supply), total_supply: "0" } },
        borrow_balance: { type: "0xd899::storage::TokenBalance", fields: { user_state: table(borrow), total_supply: "0" } },
        last_update_timestamp: "1760000000000",
        ltv: "700000000000000000000000000",
        liquidation_factors: { type: "0xd899::storage::LiquidationFactors", fields: { ratio: "0", bonus: "0", threshold } },
      },
    },
  });
}
const naviBalance = (value: string) => moveObject("0x2::dynamic_field::Field<address, u256>", { id: { id: id("dd") }, name: OWNER, value });
const ownerKey = Uint8Array.from(Buffer.from(OWNER.slice(2), "hex"));
const ADDRESS_TAG = Uint8Array.of(4);

// --- Scallop -------------------------------------------------------------------------------------

const SCALLOP_OBLIGATION = id("5b");
const SC = { coll: id("61"), debt: id("62"), borrow: id("63"), risk: id("64"), interest: id("65"), balance: id("66") };
const NOW_S = Math.floor(Date.now() / 1000);
const typeNameTag = Uint8Array.from([
  7,
  ...Buffer.from("1".padStart(64, "0"), "hex"),
  9,
  ...Buffer.from("type_name"),
  8,
  ...Buffer.from("TypeName"),
  0,
]);
const scallopFieldId = (tableId: string, name: string) => dynamicFieldId(tableId, Uint8Array.from([name.length, ...Buffer.from(name)]), typeNameTag);
const scallopField = (name: string, value: Record<string, unknown>) =>
  moveObject("0x2::dynamic_field::Field<0x1::type_name::TypeName, x>", { id: { id: id("ee") }, name: typeName(name), value: { type: "x", fields: value } });
const PER_SEC_10PCT = (0.1 * 1_000_000) / (365 * 24 * 3600);

function objects(): Map<string, unknown> {
  const map = new Map<string, unknown>([
    [SUILEND_MARKET, suilendMarket],
    [SUILEND_OBLIGATION, suilendObligation],
    [id("c0"), naviReserve(0, SUI_NAME, NAVI_TABLES.suiSupply, NAVI_TABLES.suiBorrow, "1050000000000000000000000000", "1100000000000000000000000000", "800000000000000000000000000")],
    [id("c1"), naviReserve(1, USDC_NAME, NAVI_TABLES.usdcSupply, NAVI_TABLES.usdcBorrow, "1000000000000000000000000000", "1020000000000000000000000000", "850000000000000000000000000")],
    // 100 SUI scaled supply and 50 USDC scaled debt, both in NAVI's 9 decimals.
    [dynamicFieldId(NAVI_TABLES.suiSupply, ownerKey, ADDRESS_TAG), naviBalance("100000000000")],
    [dynamicFieldId(NAVI_TABLES.usdcBorrow, ownerKey, ADDRESS_TAG), naviBalance("50000000000")],
    [
      SCALLOP_MARKET,
      moveObject(`${SCALLOP_PKG}::market::Market`, {
        id: { id: SCALLOP_MARKET },
        borrow_dynamics: witTable(SC.borrow),
        risk_models: witTable(SC.risk),
        interest_models: witTable(SC.interest),
        collateral_stats: witTable(id("67")),
        vault: { type: `${SCALLOP_PKG}::reserve::Reserve`, fields: { id: { id: id("68") }, balance_sheets: witTable(SC.balance) } },
      }),
    ],
    [
      SCALLOP_OBLIGATION,
      moveObject(`${SCALLOP_PKG}::obligation::Obligation`, {
        id: { id: SCALLOP_OBLIGATION },
        collaterals: witTable(SC.coll),
        debts: witTable(SC.debt),
        lock_key: null,
      }),
    ],
    [id("c7"), scallopField(SUI_NAME, { amount: "200000000000" })],
    [id("d7"), scallopField(USDC_NAME, { amount: "100000000", borrow_index: "1000000000" })],
    [scallopFieldId(SC.borrow, USDC_NAME), scallopField(USDC_NAME, { interest_rate: fixed32(PER_SEC_10PCT), interest_rate_scale: "1000000", borrow_index: "1050000000", last_updated: String(NOW_S) })],
    [scallopFieldId(SC.borrow, SUI_NAME), scallopField(SUI_NAME, { interest_rate: fixed32(PER_SEC_10PCT), interest_rate_scale: "1000000", borrow_index: "1000000000", last_updated: String(NOW_S) })],
    [scallopFieldId(SC.interest, USDC_NAME), scallopField(USDC_NAME, { borrow_weight: fixed32(1), revenue_factor: fixed32(0.1) })],
    [scallopFieldId(SC.interest, SUI_NAME), scallopField(SUI_NAME, { borrow_weight: fixed32(1), revenue_factor: fixed32(0.1) })],
    [scallopFieldId(SC.risk, SUI_NAME), scallopField(SUI_NAME, { collateral_factor: fixed32(0.7), liquidation_factor: fixed32(0.8) })],
    // 1e15 supplied (30% borrowed) against 8e14 sCoins: 1.25 SUI per sSUI.
    [scallopFieldId(SC.balance, SUI_NAME), scallopField(SUI_NAME, { cash: "700000000000000", debt: "300000000000000", revenue: "0", market_coin_supply: "800000000000000" })],
  ]);
  return map;
}

const DYNAMIC_FIELDS: Record<string, string[]> = {
  [NAVI_RESERVES]: [id("c0"), id("c1")],
  [SC.coll]: [id("c7")],
  [SC.debt]: [id("d7")],
};

const METADATA: Record<string, unknown> = {
  [USDC]: { decimals: 6, symbol: "USDC", name: "USDC", description: "", iconUrl: null, id: id("7d") },
  [SPAM]: { decimals: 9, symbol: "CLAIM", name: "Visit claim-sui.io for rewards", description: "", iconUrl: null, id: id("7e") },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(fail: Partial<Record<string, string>> = {}) {
  const store = objects();
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "coins.llama.fi") {
      const keys = decodeURIComponent(url.pathname.split("/").pop() ?? "").split(",");
      return json({ coins: Object.fromEntries(keys.filter((key) => key in PRICES).map((key) => [key, { price: PRICES[key], symbol: "X", decimals: 9, timestamp: 1, confidence: 0.99 }])) });
    }
    if (url.host === "sui.apis.scallop.io") {
      return json({
        sui: { coinName: "sui", symbol: "SUI", coinType: `0x${SUI_NAME}`, decimals: 9, isIsolated: false, sCoinType: SSUI, sCoinName: "ssui", isolatedAssetKey: "" },
        usdc: { coinName: "usdc", symbol: "USDC", coinType: USDC, decimals: 6, isIsolated: false, isolatedAssetKey: "" },
      });
    }
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(method);
    const ok = (result: unknown) => json({ jsonrpc: "2.0", id: 1, result });
    const key = `${method}:${String(params[0])}`;
    if (fail[key] ?? fail[method]) return json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: fail[key] ?? fail[method] } });
    const wrap = (objectId: string) => {
      const content = store.get(objectId) as { type?: string } | undefined;
      return content ? { data: { objectId, version: "1", digest: "d", type: content.type, content } } : { error: { code: "notExists", object_id: objectId } };
    };
    switch (method) {
      case "suix_getAllBalances":
        return ok([
          { coinType: SUI, coinObjectCount: 3, totalBalance: "12500000000", lockedBalance: {} },
          { coinType: USDC, coinObjectCount: 1, totalBalance: "250000000", lockedBalance: {} },
          { coinType: SSUI, coinObjectCount: 1, totalBalance: "1000000000", lockedBalance: {} },
          { coinType: SPAM, coinObjectCount: 1, totalBalance: "1000000000", lockedBalance: {} },
        ]);
      case "suix_getCoinMetadata":
        return ok(METADATA[String(params[0])] ?? null);
      case "suix_getStakes":
        return ok([
          {
            validatorAddress: id("aa"),
            stakingPool: id("ab"),
            stakes: [
              { stakedSuiId: id("ac"), stakeRequestEpoch: "500", stakeActiveEpoch: "501", principal: "100000000000", status: "Active", estimatedReward: "2500000000" },
              { stakedSuiId: id("ad"), stakeRequestEpoch: "900", stakeActiveEpoch: "901", principal: "10000000000", status: "Pending" },
            ],
          },
        ]);
      case "suix_getValidatorsApy":
        return ok({ apys: [{ address: id("aa"), apy: 0.025 }], epoch: "900" });
      case "suix_getOwnedObjects": {
        const type = (params[1] as { filter: { StructType: string } }).filter.StructType;
        const owned = type.includes("ObligationOwnerCap")
          ? [moveObject(type, { id: { id: id("ca") }, obligation_id: SUILEND_OBLIGATION })]
          : type === `${SCALLOP_PKG}::obligation::ObligationKey`
            ? [moveObject(type, { id: { id: id("cb") }, ownership: { type: "x::ownership::Ownership", fields: { id: { id: id("cc") }, of: SCALLOP_OBLIGATION } } })]
            : [];
        return ok({ data: owned.map((content) => ({ data: { objectId: (content.fields.id as { id: string }).id, version: "1", digest: "d", type, content } })), nextCursor: null, hasNextPage: false });
      }
      case "sui_getObject":
        return ok(wrap(String(params[0])));
      case "sui_multiGetObjects":
        return ok((params[0] as string[]).map(wrap));
      case "suix_getDynamicFields":
        return ok({
          data: (DYNAMIC_FIELDS[String(params[0])] ?? []).map((objectId) => ({ name: { type: "u8", value: 0 }, objectId, objectType: "x", type: "DynamicField", version: "1", digest: "d" })),
          nextCursor: null,
          hasNextPage: false,
        });
      default:
        return json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("Sui helpers", () => {
  it("derives dynamic field ids the way Sui does", () => {
    // The 0x5 system state wrapper's field for version 2 is a well-known mainnet object id.
    const key = new Uint8Array(8);
    key[0] = 2;
    expect(dynamicFieldId("0x5", key, Uint8Array.of(2))).toBe("0x5b890eaf2abcfa2ab90b77b8e6f3d5d8609586c3e583baf3dccd5af17edf48d1");
  });

  it("normalizes coin types to the RPC's spelling", () => {
    expect(normalizeCoinType(`0x${SUI_NAME}`)).toBe(SUI);
    expect(normalizeCoinType(USDC_NAME)).toBe(USDC);
    expect(normalizeCoinType(`0xefe8::reserve::MarketCoin<${SUI_NAME}>`)).toBe(`0x${"0".repeat(60)}efe8::reserve::MarketCoin<0x2::sui::SUI>`);
  });
});

describe("readSui", () => {
  it("reads balances, stakes, Suilend, NAVI and Scallop", async () => {
    const { fetch } = mockFetch();
    const read = await readSui(OWNER, { fetch });
    expect(read.notes).toEqual([]);

    expect(read.spot.map((row) => [row.symbol, row.amount, row.usd])).toEqual([
      ["USDC", 250, 250],
      ["SUI", 12.5, 37.5],
    ]);
    expect(read.spot.some((row) => row.symbol === "CLAIM" || row.symbol.includes("SCALLOP"))).toBe(false);

    const staking = read.positions.find((position) => position.category === "staking")!;
    expect(staking.app).toBe("Sui");
    expect(staking.legs.map((leg) => [leg.id, leg.amount, leg.usd])).toEqual([
      ["staked", 110, 330],
      ["rewards", 2.5, 7.5],
    ]);
    expect(staking.legs[0].apy).toBeCloseTo(0.025, 9);

    const suilend = read.positions.find((position) => position.app === "Suilend")!;
    expect(suilend.category).toBe("lending");
    const [deposit, borrow] = suilend.legs;
    expect(deposit).toMatchObject({ side: "supply", symbol: "SUI", amount: 1250, usd: 3750, isCollateral: true, liquidationThreshold: 0.75 });
    expect(deposit.apy).toBeCloseTo(0.4 * 0.05 * 0.8, 9);
    expect(borrow).toMatchObject({ side: "borrow", symbol: "USDC", usd: 1050 });
    expect(borrow.amount).toBeCloseTo(1050, 9);
    expect(borrow.apy).toBeCloseTo(0.03125, 9);
    expect(suilend.healthFactor).toBeCloseTo((3750 * 0.75) / 1050, 9);
    expect(suilend.healthFactorSource).toBe("protocol");

    const navi = read.positions.find((position) => position.app === "NAVI")!;
    expect(navi.legs.map((leg) => [leg.side, leg.symbol, leg.amount, leg.usd])).toEqual([
      ["supply", "SUI", 105, 315],
      ["borrow", "USDC", 51, 51],
    ]);
    expect(navi.legs[0]).toMatchObject({ apy: 0.03, liquidationThreshold: 0.8 });
    expect(navi.legs[1].apy).toBeCloseTo(0.06, 12);
    expect(navi.healthFactor).toBeCloseTo((315 * 0.8) / 51, 9);

    const scallop = read.positions.find((position) => position.app === "Scallop" && position.legs.some((leg) => leg.side === "borrow"))!;
    const [collateral, debt] = scallop.legs;
    expect(collateral).toMatchObject({ side: "supply", symbol: "SUI", amount: 200, usd: 600, apy: 0, isCollateral: true });
    expect(collateral.liquidationThreshold).toBeCloseTo(0.8, 9);
    expect(debt).toMatchObject({ side: "borrow", symbol: "USDC" });
    expect(debt.amount).toBeCloseTo(105, 3);
    expect(debt.apy).toBeCloseTo(0.1, 6);
    expect(scallop.healthFactor).toBeCloseTo((600 * 0.8) / 105, 3);

    const supply = read.positions.find((position) => position.id.endsWith(":supply"))!;
    expect(supply.app).toBe("Scallop");
    expect(supply.legs).toHaveLength(1);
    expect(supply.legs[0]).toMatchObject({ symbol: "SUI", amount: 1.25, usd: 3.75, isCollateral: false });
    expect(supply.legs[0].apy).toBeCloseTo(0.1 * 0.3 * 0.9, 6);
    expect(supply.healthFactor).toBeNull();
  });

  it("turns one failing app into a note and keeps the rest", async () => {
    const { fetch } = mockFetch({ [`suix_getDynamicFields:${NAVI_RESERVES}`]: "Too many requests" });
    const read = await readSui(OWNER, { fetch });
    expect(read.notes).toEqual(["NAVI: Too many requests"]);
    expect(read.positions.map((position) => position.app).sort()).toEqual(["Scallop", "Scallop", "Sui", "Suilend"]);
    expect(read.spot.length).toBe(2);
  });

  it("fails the whole read only when balances are unreachable", async () => {
    const { fetch } = mockFetch({ suix_getAllBalances: "node down" });
    await expect(readSui(OWNER, { fetch })).rejects.toThrow("node down");
  });

  it("rejects input that is not a Sui address", async () => {
    await expect(readSui("cosmos1abc", {})).rejects.toThrow("Not a Sui address");
  });
});
