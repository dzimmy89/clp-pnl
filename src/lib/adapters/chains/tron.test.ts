import { describe, expect, it, vi } from "vitest";
import { JUSTLEND_COMPTROLLER, KNOWN_TOKENS, readTron, tronBase58, tronHex } from "./tron";

const USER = tronBase58("a1".repeat(20));
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const J_TRX = "TE2RzoSV3wFK99w6J9UnnZ4vLfXYoxvRwP";
const J_USDT = tronBase58("b2".repeat(20));
const J_ABC = tronBase58("b3".repeat(20));
const ABC = tronBase58("c1".repeat(20));
const PRICED_UNKNOWN = tronBase58("c2".repeat(20));
const SPAM = tronBase58("c3".repeat(20));

const E18 = BigInt(10) ** BigInt(18);
const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const wa = (address: string) => tronHex(address).padStart(64, "0");
const list = (addresses: string[]) => w(32) + w(addresses.length) + addresses.map(wa).join("");
const str = (text: string) => {
  const hex = Buffer.from(text, "utf8").toString("hex");
  return w(32) + w(hex.length / 2) + hex.padEnd(64, "0");
};

const ok = (hex: string) => ({
  result: { result: true },
  energy_used: 1234,
  constant_result: [hex],
  transaction: { ret: [{}], visible: true, txID: "00", raw_data: {} },
});
const reverted = () => ({
  result: { result: true },
  energy_used: 50,
  constant_result: [""],
  transaction: { ret: [{ ret: "FAILED" }], visible: true, txID: "00", raw_data: {} },
});

const CONTRACTS: Record<string, Record<string, () => unknown>> = {
  [JUSTLEND_COMPTROLLER]: {
    "getAssetsIn(address)": () => ok(list([J_TRX, J_USDT])),
    "getAllMarkets()": () => ok(list([J_TRX, J_USDT, J_ABC])),
    [`markets(address):${wa(J_TRX)}`]: () => ok(w(1) + w((BigInt(75) * E18) / BigInt(100)) + w(0)),
    [`markets(address):${wa(J_ABC)}`]: () => ok(w(1) + w(E18 / BigInt(2)) + w(0)),
  },
  // 100 jTRX at 0.1 TRX each = 1000 TRX supplied.
  [J_TRX]: {
    "getAccountSnapshot(address)": () => ok(w(0) + w(10_000_000_000) + w(0) + w(E18 / BigInt(10))),
    "underlying()": reverted,
    "supplyRatePerBlock()": () => ok(w(1_000_000_000)),
  },
  // Borrowed 40 USDT, nothing supplied.
  [J_USDT]: {
    "getAccountSnapshot(address)": () => ok(w(0) + w(0) + w(40_000_000) + w(BigInt(2) * BigInt(10) ** BigInt(16))),
    "underlying()": () => ok(wa(USDT)),
    "borrowRatePerBlock()": () => ok(w(3_000_000_000)),
  },
  // 50 jABC worth 10 ABC (18 decimals), supplied but not entered as collateral.
  [J_ABC]: {
    "getAccountSnapshot(address)": () => ok(w(0) + w(5_000_000_000) + w(0) + w(BigInt(2) * BigInt(10) ** BigInt(27))),
    "underlying()": () => ok(wa(ABC)),
    "supplyRatePerBlock()": () => ok(w(2_000_000_000)),
  },
  [ABC]: { "decimals()": () => ok(w(18)), "symbol()": () => ok(str("ABC")) },
  [PRICED_UNKNOWN]: { "decimals()": () => ok(w(6)), "symbol()": () => ok(str("XYZ")) },
};

const PRICES: Record<string, number> = {
  "coingecko:tron": 0.25,
  [`tron:${USDT}`]: 1,
  [`tron:${ABC}`]: 2,
  [`tron:${PRICED_UNKNOWN}`]: 0.5,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(override: (url: URL, body: Record<string, string>) => Response | undefined = () => undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
    const custom = override(url, body);
    if (custom) return custom;

    if (url.host === "api.trongrid.io" && url.pathname === `/v1/accounts/${USER}`) {
      return json({
        data: [
          {
            address: `41${"a1".repeat(20)}`,
            balance: 1_500_000_000,
            create_time: 1_600_000_000_000,
            frozenV2: [{ amount: 1_000_000_000 }, { type: "ENERGY", amount: 2_000_000_000 }, { type: "TRON_POWER" }],
            unfrozenV2: [{ type: "ENERGY", unfreeze_amount: 500_000_000, unfreeze_expire_time: 1_900_000_000_000 }],
            delegated_frozenV2_balance_for_bandwidth: 100_000_000,
            account_resource: { delegated_frozenV2_balance_for_energy: 400_000_000, energy_window_size: 28_800_000 },
            votes: [{ vote_address: "TLyqzVGLV1srkB7dToTAEqgDSfPtXRJZYH", vote_count: 3500 }],
            trc20: [
              { [USDT]: "250000000" },
              { [J_TRX]: "10000000000" },
              { [J_ABC]: "5000000000" },
              { [SPAM]: "1000000000000" },
              { [PRICED_UNKNOWN]: "1000000000" },
            ],
          },
        ],
        success: true,
        meta: { at: 1_700_000_000_000, page_size: 1 },
      });
    }
    if (url.host === "api.trongrid.io" && url.pathname === "/wallet/getReward") return json({ reward: 12_345_678 });
    if (url.host === "api.trongrid.io" && url.pathname === "/wallet/triggerconstantcontract") {
      const handlers = CONTRACTS[body.contract_address] ?? {};
      const handler = handlers[`${body.function_selector}:${body.parameter}`] ?? handlers[body.function_selector];
      return json(handler ? handler() : reverted());
    }
    if (url.host === "coins.llama.fi") {
      const coins: Record<string, { price: number }> = {};
      for (const key of decodeURIComponent(url.pathname.replace("/prices/current/", "")).split(",")) {
        if (PRICES[key]) coins[key] = { price: PRICES[key] };
      }
      return json({ coins });
    }
    return json({ Error: "not found" }, 404);
  });
  return fetchMock as unknown as typeof fetch;
}

describe("readTron", () => {
  it("knows only valid base58check addresses", () => {
    for (const address of [...Object.keys(KNOWN_TOKENS), JUSTLEND_COMPTROLLER, J_TRX]) {
      expect(tronBase58(tronHex(address))).toBe(address);
    }
  });

  it("reads balances, staking, voting rewards and JustLend DAO", async () => {
    const read = await readTron(USER, { fetch: mockFetch() });
    expect(read.notes).toEqual([]);

    expect(read.spot.map((s) => [s.symbol, s.amount, s.usd])).toEqual([
      ["XYZ", 1000, 500],
      ["TRX", 1500, 375],
      ["USDT", 250, 250],
    ]);

    const staking = read.positions.find((p) => p.category === "staking")!;
    expect(staking.app).toBe("TRON Staking");
    expect(staking.legs.map((l) => [l.amount, l.usd])).toEqual([
      [3500, 875],
      [500, 125],
    ]);
    const rewards = read.positions.find((p) => p.category === "rewards")!;
    expect(rewards.legs[0].amount).toBeCloseTo(12.345678, 9);

    const lend = read.positions.find((p) => p.app === "JustLend DAO")!;
    expect(lend.category).toBe("lending");
    expect(lend.label).toBe("JustLend DAO Lending · Tron");
    expect(
      lend.legs.map((l) => [l.side, l.symbol, l.amount, l.usd, l.isCollateral, l.liquidationThreshold]),
    ).toEqual([
      ["supply", "TRX", 1000, 250, true, 0.75],
      ["borrow", "USDT", 40, 40, false, undefined],
      ["supply", "ABC", 10, 20, false, undefined],
    ]);
    expect(lend.legs[0].apy).toBeCloseTo(0.010512, 9);
    expect(lend.legs[1].apy).toBeCloseTo(0.031536, 9);
    expect(lend.healthFactorSource).toBe("estimated");
  });

  it("turns a failing JustLend read into a note and keeps balances and staking", async () => {
    const fetch = mockFetch((url) => (url.pathname === "/wallet/triggerconstantcontract" ? json({}, 503) : undefined));
    const read = await readTron(USER, { fetch });
    expect(read.notes).toEqual(["JustLend DAO: api.trongrid.io returned 503"]);
    expect(read.spot.map((s) => s.symbol)).toEqual(["TRX", "USDT"]);
    expect(read.positions.map((p) => p.category)).toEqual(["staking", "rewards"]);
  });

  it("sends the TronGrid key when one is set", async () => {
    vi.stubEnv("TRONGRID_API_KEY", "grid-key");
    const fetch = mockFetch();
    await readTron(USER, { fetch });
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["TRON-PRO-API-KEY"]).toBe("grid-key");
    vi.unstubAllEnvs();
  });

  it("rejects input that is not a Tron address", async () => {
    await expect(readTron("0x1111111111111111111111111111111111111111")).rejects.toThrow("Not a Tron address");
    await expect(readTron(USER.slice(0, -1) + (USER.endsWith("a") ? "b" : "a"))).rejects.toThrow("Not a Tron address");
  });
});
