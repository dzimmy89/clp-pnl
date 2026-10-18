import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { cosmosAccountBytes, ibcDenom, readCosmos } from "./cosmos";

const BYTES = new Uint8Array(20).fill(0x11);
const COSMOS = bech32.encode("cosmos", bech32.toWords(BYTES));
const OSMO = bech32.encode("osmo", bech32.toWords(BYTES));
const OSMO_USDC = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";

const PRICES = { "coingecko:cosmos": 5, "coingecko:osmosis": 0.5, "coingecko:usd-coin": 1 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(overrides: Record<string, (path: string) => Response> = {}) {
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.host === "coins.llama.fi") {
      const keys = decodeURIComponent(url.pathname.split("/").pop() ?? "").split(",");
      const coins = Object.fromEntries(
        keys.filter((key) => key in PRICES).map((key) => [key, { price: PRICES[key as keyof typeof PRICES], symbol: "X", decimals: 0, timestamp: 1, confidence: 0.99 }]),
      );
      return json({ coins });
    }
    const [, chain, ...rest] = url.pathname.split("/");
    const path = `/${rest.join("/")}`;
    if (overrides[chain]) return overrides[chain](path);
    return json(path.includes("/bank/") ? { balances: [], pagination: { next_key: null, total: "0" } } : {});
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const hub = (path: string) => {
  if (path === `/cosmos/bank/v1beta1/balances/${COSMOS}`) {
    return json({
      balances: [
        { denom: "ibc/0025F8A87464A471E66B234C4F93AEC5B4DA3D42D7986451A059273426290DD5", amount: "999999" },
        { denom: "uatom", amount: "12500000" },
      ],
      pagination: { next_key: null, total: "2" },
    });
  }
  if (path === `/cosmos/staking/v1beta1/delegations/${COSMOS}`) {
    return json({
      delegation_responses: [
        {
          delegation: { delegator_address: COSMOS, validator_address: "cosmosvaloper1aaa", shares: "100000000.000000000000000000" },
          balance: { denom: "uatom", amount: "100000000" },
        },
        {
          delegation: { delegator_address: COSMOS, validator_address: "cosmosvaloper1bbb", shares: "50000000.000000000000000000" },
          balance: { denom: "uatom", amount: "50000000" },
        },
      ],
      pagination: { next_key: null, total: "2" },
    });
  }
  if (path === `/cosmos/staking/v1beta1/delegators/${COSMOS}/unbonding_delegations`) {
    return json({
      unbonding_responses: [
        {
          delegator_address: COSMOS,
          validator_address: "cosmosvaloper1aaa",
          entries: [
            { creation_height: "1", completion_time: "2026-10-30T10:00:00Z", initial_balance: "2000000", balance: "2000000", unbonding_id: "9", unbonding_on_hold_ref_count: "0" },
            { creation_height: "2", completion_time: "2026-10-20T10:00:00Z", initial_balance: "1000000", balance: "1000000", unbonding_id: "8", unbonding_on_hold_ref_count: "0" },
          ],
        },
      ],
      pagination: { next_key: null, total: "1" },
    });
  }
  if (path === `/cosmos/distribution/v1beta1/delegators/${COSMOS}/rewards`) {
    return json({
      rewards: [{ validator_address: "cosmosvaloper1aaa", reward: [{ denom: "uatom", amount: "1500000.250000000000000000" }] }],
      total: [{ denom: "uatom", amount: "1500000.250000000000000000" }],
    });
  }
  return json({ code: 5, message: "not found", details: [] }, 404);
};

const osmosis = (path: string) => {
  if (path === `/cosmos/bank/v1beta1/balances/${OSMO}`) {
    return json({
      balances: [
        { denom: OSMO_USDC, amount: "250000000" },
        { denom: "uosmo", amount: "40000000" },
        { denom: "gamm/pool/1", amount: "1000000000000000000" },
        { denom: "factory/osmo1xyz/meme", amount: "123" },
      ],
      pagination: { next_key: null, total: "4" },
    });
  }
  return json({});
};

describe("readCosmos", () => {
  it("re-encodes the address per chain and reads balances, staking, unbonding and rewards", async () => {
    const { fetch, calls } = mockFetch({
      cosmoshub: hub,
      osmosis,
      celestia: () => json({ code: 13, message: "internal" }, 500),
      neutron: (path) => (path.includes("/bank/") ? json({ balances: [] }) : json({ code: 12, message: "Not Implemented" }, 501)),
    });
    const read = await readCosmos(COSMOS, { fetch });

    expect(calls.some((url) => url.includes(`/osmosis/cosmos/bank/v1beta1/balances/${OSMO}`))).toBe(true);
    expect(calls.some((url) => url.includes("/noble/cosmos/staking"))).toBe(false);

    expect(read.spot.map((s) => [s.chain, s.symbol, s.amount, s.usd])).toEqual([
      ["Osmosis", "USDC", 250, 250],
      ["Cosmos Hub", "ATOM", 12.5, 62.5],
      ["Osmosis", "OSMO", 40, 20],
    ]);
    expect(read.spot[0].kind).toBe("stable");

    const staking = read.positions.find((p) => p.category === "staking");
    expect(staking?.chain).toBe("Cosmos Hub");
    expect(staking?.legs.map((l) => [l.symbol, l.amount, l.usd])).toEqual([["ATOM", 150, 750]]);
    expect(staking?.note).toBe("2 validators");

    const locked = read.positions.find((p) => p.category === "locked");
    expect(locked?.legs[0].amount).toBe(3);
    expect(locked?.note).toBe("Next unlock 2026-10-20");

    const rewards = read.positions.find((p) => p.category === "rewards");
    expect(rewards?.legs[0].amount).toBeCloseTo(1.50000025, 6);
    expect(rewards?.legs[0].usd).toBeCloseTo(7.5, 4);

    expect(read.notes).toEqual(["Celestia: rest.cosmos.directory returned 500"]);
  });

  it("throws when no chain answers", async () => {
    const fetch = (async () => json({}, 503)) as typeof globalThis.fetch;
    await expect(readCosmos(COSMOS, { fetch })).rejects.toThrow(/unreachable/);
  });

  it("rejects bad input and other-key chains", () => {
    expect(() => cosmosAccountBytes("hello")).toThrow(/bech32/);
    expect(() => cosmosAccountBytes(bech32.encode("inj", bech32.toWords(BYTES)))).toThrow(/different key/);
    expect(cosmosAccountBytes(OSMO)).toEqual(BYTES);
  });

  it("derives IBC denoms from their transfer path", () => {
    expect(ibcDenom("channel-750/uusdc")).toBe(OSMO_USDC);
    expect(ibcDenom("channel-0/uatom")).toBe("ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2");
  });
});
