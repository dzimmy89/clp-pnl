import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { cardanoAccount, readCardano } from "./cardano";

// CIP-19 test vectors: a base address and the reward address of the same stake key.
const BASE = "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";
const STAKE = "stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw";
const ENTERPRISE = "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8";
const POOL = "pool1pu5jlj4q9w9jlxeu370a3c9myx47md5j5m2str0naunn2q3lkdy";
const MIN_POLICY = "29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6";
const SPAM_POLICY = "deadbeef00000000000000000000000000000000000000000000beef";
const NFT_POLICY = "0123456789abcdef0123456789abcdef0123456789abcdef01234567";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Handler = (body: Record<string, unknown>) => Response;

function mockFetch(handlers: Record<string, Handler>) {
  const bodies: Record<string, unknown> = {};
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "coins.llama.fi") {
      const prices: Record<string, number> = { "coingecko:cardano": 0.5, [`cardano:${MIN_POLICY}4d494e`]: 0.02 };
      const keys = decodeURIComponent(url.pathname.split("/").pop() ?? "").split(",");
      return json({ coins: Object.fromEntries(keys.filter((k) => k in prices).map((k) => [k, { price: prices[k], symbol: "X", timestamp: 1, confidence: 0.99 }])) });
    }
    const path = url.pathname.replace("/api/v1", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    bodies[path] = body;
    const handler = handlers[path];
    return handler ? handler(body) : json([]);
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

const accountInfo: Handler = () =>
  json([
    {
      stake_address: STAKE,
      status: "registered",
      delegated_drep: "drep_always_abstain",
      delegated_pool: POOL,
      total_balance: "1505000000",
      utxo: "1500000000",
      rewards: "42000000",
      withdrawals: "37000000",
      rewards_available: "5000000",
      deposit: "2000000",
      reserves: "0",
      treasury: "0",
      proposal_refund: "0",
    },
  ]);

const accountAssets: Handler = () =>
  json([
    { stake_address: STAKE, policy_id: MIN_POLICY, asset_name: "4d494e", fingerprint: "asset1d9v7aptfvpx7we2la8f25kwprkj2ma5rp6uwzv", decimals: 6, quantity: "2500000000" },
    { stake_address: STAKE, policy_id: SPAM_POLICY, asset_name: "46524545", fingerprint: "asset1spam", decimals: 0, quantity: "1000000" },
    { stake_address: STAKE, policy_id: NFT_POLICY, asset_name: "4e465431", fingerprint: "asset1nft", decimals: 0, quantity: "1" },
  ]);

const assetInfo: Handler = () =>
  json([
    {
      policy_id: MIN_POLICY,
      asset_name: "4d494e",
      asset_name_ascii: "MIN",
      fingerprint: "asset1d9v7aptfvpx7we2la8f25kwprkj2ma5rp6uwzv",
      total_supply: "5000000000000000",
      token_registry_metadata: { name: "Minswap", description: "Minswap DEX token", ticker: "MIN", url: "https://minswap.org", logo: "", decimals: 6 },
      cip68_metadata: null,
    },
    { policy_id: SPAM_POLICY, asset_name: "46524545", asset_name_ascii: "FREE", fingerprint: "asset1spam", token_registry_metadata: null, cip68_metadata: null },
  ]);

const poolInfo: Handler = () =>
  json([{ pool_id_bech32: POOL, pool_status: "registered", meta_json: { name: "Bloom Pool", ticker: "BLOOM", homepage: "https://example.org", description: "" } }]);

describe("cardanoAccount", () => {
  it("derives the stake address from a base address", () => {
    expect(cardanoAccount(BASE)).toEqual({ stake: STAKE, payment: BASE });
    expect(cardanoAccount(STAKE)).toEqual({ stake: STAKE, payment: null });
    expect(cardanoAccount(ENTERPRISE)).toEqual({ stake: null, payment: ENTERPRISE });
  });

  it("rejects bad input", () => {
    expect(() => cardanoAccount("DdzFFzCqrht")).toThrow(/Cardano/);
    const testnet = bech32.encode("addr_test", bech32.toWords(Uint8Array.from([0x60, ...new Uint8Array(28).fill(7)])), 1023);
    expect(() => cardanoAccount(testnet)).toThrow(/mainnet/);
  });
});

describe("readCardano", () => {
  it("reads delegated ADA, rewards and native tokens for the whole account", async () => {
    const { fetch, bodies } = mockFetch({
      "/account_info": accountInfo,
      "/account_assets": accountAssets,
      "/asset_info": assetInfo,
      "/pool_info": poolInfo,
    });
    const read = await readCardano(BASE, { fetch });

    expect(bodies["/account_info"]).toEqual({ _stake_addresses: [STAKE] });
    expect(bodies["/asset_info"]).toEqual({ _asset_list: [[MIN_POLICY, "4d494e"], [SPAM_POLICY, "46524545"]] });

    const staking = read.positions[0];
    expect(staking.category).toBe("staking");
    expect(staking.label).toBe("Cardano staking · BLOOM");
    expect(staking.legs.map((l) => [l.symbol, l.amount, l.usd])).toEqual([
      ["ADA", 1500, 750],
      ["ADA", 5, 2.5],
    ]);

    expect(read.spot.map((s) => [s.symbol, s.amount, s.usd])).toEqual([["MIN", 2500, 50]]);
    expect(read.notes).toEqual([]);
  });

  it("keeps ADA when the token read fails", async () => {
    const { fetch } = mockFetch({
      "/account_info": accountInfo,
      "/account_assets": () => json({ message: "boom" }, 500),
      "/pool_info": () => json({}, 500),
    });
    const read = await readCardano(STAKE, { fetch });
    expect(read.notes).toEqual(["Cardano tokens: api.koios.rest returned 500"]);
    expect(read.positions[0].label).toBe("Cardano staking");
    expect(read.positions[0].legs[0].usd).toBe(750);
  });

  it("reads an enterprise address directly and puts undelegated ADA in spot", async () => {
    const { fetch } = mockFetch({
      "/address_info": () => json([{ address: ENTERPRISE, balance: "12345678", stake_address: null, script_address: false, utxo_set: [] }]),
      "/address_assets": () => json([]),
    });
    const read = await readCardano(ENTERPRISE, { fetch });
    expect(read.positions).toEqual([]);
    expect(read.spot.map((s) => [s.symbol, s.amount, s.usd])).toEqual([["ADA", 12.345678, 6.172839]]);
  });

  it("fails when Koios is unreachable", async () => {
    const fetch = (async () => json({}, 503)) as typeof globalThis.fetch;
    await expect(readCardano(BASE, { fetch })).rejects.toThrow(/503/);
  });
});
