import { base58, base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { addressWithSeed, findPda, readSolanaApps } from "@/lib/adapters/chains/solana-apps";

const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DRIFT = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
const SAVE = "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo";
const SAVE_MAIN = "4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY";
const MARGINFI_GROUP = "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8";
const NO_EPOCH = "18446744073709551615";

const pubkey = (fill: number) => base58.encode(new Uint8Array(32).fill(fill));
const MARGINFI_ACCOUNT = pubkey(1);
const BANK_SOL = pubkey(2);
const BANK_USDC = pubkey(3);
const RESERVE_SOL = pubkey(4);
const RESERVE_USDC = pubkey(5);
const STAKE_A = pubkey(6);
const STAKE_B = pubkey(7);

/** Little-endian account bytes, written at the offsets the on-chain layouts use. */
class Bytes {
  data: Uint8Array;
  view: DataView;
  constructor(size: number) {
    this.data = new Uint8Array(size);
    this.view = new DataView(this.data.buffer);
  }
  u8(at: number, value: number) {
    this.data[at] = value;
    return this;
  }
  u16(at: number, value: number) {
    this.view.setUint16(at, value, true);
    return this;
  }
  u32(at: number, value: number) {
    this.view.setUint32(at, value, true);
    return this;
  }
  u64(at: number, value: bigint) {
    this.view.setBigUint64(at, BigInt.asUintN(64, value), true);
    return this;
  }
  u128(at: number, value: bigint) {
    const raw = BigInt.asUintN(128, value);
    this.view.setBigUint64(at, raw & (2n ** 64n - 1n), true);
    this.view.setBigUint64(at + 8, raw >> 64n, true);
    return this;
  }
  fixed(at: number, value: number) {
    return this.u128(at, BigInt(Math.round(value * 2 ** 48)));
  }
  key(at: number, address: string) {
    this.data.set(base58.decode(address), at);
    return this;
  }
  text(at: number, value: string) {
    this.data.set(new TextEncoder().encode(value), at);
    return this;
  }
}

const WAD = 10n ** 18n;

function marginfiAccount() {
  const bytes = new Bytes(2312).key(8, MARGINFI_GROUP).key(40, WALLET);
  bytes.u8(72, 1).key(73, BANK_SOL).fixed(72 + 40, 8e9);
  bytes.u8(176, 1).key(177, BANK_USDC).fixed(176 + 56, 500e6);
  return bytes.data;
}

function marginfiBank(mint: string, decimals: number, assetShareValue: number, assetWeight: number, liabilityWeight: number) {
  return new Bytes(1864)
    .key(8, mint)
    .u8(40, decimals)
    .fixed(80, assetShareValue)
    .fixed(96, 1)
    .fixed(312, assetWeight)
    .fixed(344, liabilityWeight)
    .u32(1380, Math.round(0.005 * 0xffffffff))
    .u32(1384, Math.round(0.008 * 0xffffffff)).data;
}

const owner = base58.decode(WALLET);
const utf8 = (text: string) => new TextEncoder().encode(text);
const DRIFT_STATS = findPda([utf8("user_stats"), owner], DRIFT);
const DRIFT_USER = findPda([utf8("user"), owner, Uint8Array.of(0, 0)], DRIFT);
const DRIFT_SPOT_USDC = findPda([utf8("spot_market"), Uint8Array.of(0, 0)], DRIFT);
const DRIFT_PERP_SOL = findPda([utf8("perp_market"), Uint8Array.of(0, 0)], DRIFT);
const SAVE_OBLIGATION = addressWithSeed(WALLET, SAVE_MAIN.slice(0, 32), SAVE);

function driftUser() {
  const bytes = new Bytes(4376).key(8, WALLET).text(72, "Main");
  bytes.u64(104, 800_000_000_000n).u16(104 + 32, 0).u8(104 + 34, 0);
  bytes.u64(424 + 8, 50_000_000_000n).u64(424 + 16, -7_400_000_000n).u16(424 + 92, 0);
  return bytes.u16(4346, 0).data;
}

function driftSpotUsdc() {
  return new Bytes(776)
    .key(72, USDC)
    .text(136, "USDC")
    .u64(168, 1_000_000n)
    .u128(464, 12_500_000_000n)
    .u128(480, 10_000_000_000n)
    .u32(644, 10_000)
    .u32(652, 10_000)
    .u32(680, 6).data;
}

function driftPerpSol() {
  return new Bytes(1216).u64(72, 150_000_000n).text(1000, "SOL-PERP").u32(1140, 300).u32(1148, 10_000).data;
}

function saveObligation() {
  const bytes = new Bytes(1300).u8(0, 1).key(10, SAVE_MAIN).key(42, WALLET).u8(202, 1).u8(203, 1);
  bytes.key(204, RESERVE_SOL).u64(236, 4_000_000_000n);
  bytes.key(292, RESERVE_USDC).u128(324, WAD).u128(340, 200_000_000n * WAD);
  return bytes.data;
}

function saveReserve(mint: string, decimals: number, available: bigint, borrowed: bigint, cTokenSupply: bigint, cumulativeRate: bigint) {
  return new Bytes(619)
    .u8(0, 1)
    .key(10, SAVE_MAIN)
    .key(42, mint)
    .u8(74, decimals)
    .u64(171, available)
    .u128(179, borrowed * WAD)
    .u128(195, cumulativeRate)
    .u64(259, cTokenSupply)
    .u8(299, 80)
    .u8(302, 85)
    .u8(303, 0)
    .u8(304, 8)
    .u8(305, 50)
    .u8(372, 20)
    .u8(470, 90).data;
}

const ACCOUNTS: Record<string, Uint8Array> = {
  [BANK_SOL]: marginfiBank(SOL, 9, 1.25, 0.9, 1.1),
  [BANK_USDC]: marginfiBank(USDC, 6, 1, 0.95, 1),
  [DRIFT_STATS]: new Bytes(240).key(8, WALLET).u16(186, 1).data,
  [DRIFT_USER]: driftUser(),
  [DRIFT_SPOT_USDC]: driftSpotUsdc(),
  [DRIFT_PERP_SOL]: driftPerpSol(),
  [SAVE_OBLIGATION]: saveObligation(),
  [RESERVE_SOL]: saveReserve(SOL, 9, 600_000_000_000n, 400_000_000_000n, 800_000_000_000n, WAD),
  [RESERVE_USDC]: saveReserve(USDC, 6, 1_000_000_000n, 0n, 1_000_000_000n, (11n * WAD) / 10n),
};

function stakeAccount(pubkey: string, lamports: number, activationEpoch: string, deactivationEpoch: string) {
  return {
    pubkey,
    account: {
      lamports,
      owner: "Stake11111111111111111111111111111111111111",
      executable: false,
      rentEpoch: 18446744073709552000,
      space: 200,
      data: {
        program: "stake",
        space: 200,
        parsed: {
          type: "delegated",
          info: {
            meta: {
              authorized: { staker: WALLET, withdrawer: WALLET },
              lockup: { custodian: "11111111111111111111111111111111", epoch: 0, unixTimestamp: 0 },
              rentExemptReserve: "2282880",
            },
            stake: {
              creditsObserved: 1000,
              delegation: {
                activationEpoch,
                deactivationEpoch,
                stake: String(lamports - 2282880),
                voter: pubkey,
                warmupCooldownRate: 0.09,
              },
            },
          },
        },
      },
    },
  };
}

const LLAMA: Record<string, { price: number; symbol: string; decimals: number }> = {
  [`solana:${SOL}`]: { price: 150, symbol: "SOL", decimals: 9 },
  [`solana:${USDC}`]: { price: 1, symbol: "USDC", decimals: 6 },
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mockFetch(fail: { jupiter?: boolean; marginfi?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://coins.llama.fi/prices/current/")) {
      const keys = decodeURIComponent(url.split("/current/")[1]).split(",");
      return json({ coins: Object.fromEntries(keys.filter((k) => LLAMA[k]).map((k) => [k, { ...LLAMA[k], timestamp: 1, confidence: 0.99 }])) });
    }
    if (url.startsWith("https://api.save.finance/v1/markets/configs")) {
      return json([
        {
          name: "Main Pool",
          address: SAVE_MAIN,
          isPrimary: true,
          isPermissionless: false,
          hidden: false,
          owner: pubkey(9),
          authorityAddress: pubkey(10),
          reserves: [
            { address: RESERVE_SOL, liquidityToken: { symbol: "SOL", mint: SOL, decimals: 9, name: "Wrapped SOL" } },
            { address: RESERVE_USDC, liquidityToken: { symbol: "USDC", mint: USDC, decimals: 6, name: "USD Coin" } },
          ],
        },
      ]);
    }
    if (url.startsWith("https://lite-api.jup.ag/lend/v1/earn/positions")) {
      if (fail.jupiter) return json({ error: "down" }, 500);
      expect(url).toContain(`users=${WALLET}`);
      const token = (symbol: string, asset: string, decimals: number) => ({
        id: 1,
        address: pubkey(11),
        name: `jupiter lend ${symbol}`,
        symbol: `jl${symbol}`,
        decimals,
        assetAddress: asset,
        asset: { address: asset, chainId: "solana", name: symbol, symbol, decimals, price: "0.9997" },
        totalAssets: "1",
        totalSupply: "1",
        convertToShares: "1",
        convertToAssets: "1",
        rewardsRate: "0",
        supplyRate: "448",
        totalRate: "448",
      });
      return json([
        { token: token("USDC", USDC, 6), ownerAddress: WALLET, shares: "98000000", underlyingAssets: "100500000", underlyingBalance: "0", allowance: "0" },
        { token: token("SOL", SOL, 9), ownerAddress: WALLET, shares: "0", underlyingAssets: "0", underlyingBalance: "0", allowance: "0" },
      ]);
    }
    if (url === "https://api.mainnet-beta.solana.com") {
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (method === "getEpochInfo") return json({ jsonrpc: "2.0", id: 1, result: { epoch: 800, slotIndex: 1, slotsInEpoch: 432000 } });
      if (method === "getMultipleAccounts") {
        const keys = params[0] as string[];
        const value = keys.map((k) =>
          ACCOUNTS[k] ? { data: [base64.encode(ACCOUNTS[k]), "base64"], executable: false, lamports: 1, owner: DRIFT, rentEpoch: 0, space: ACCOUNTS[k].length } : null,
        );
        return json({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });
      }
      if (method === "getProgramAccounts") {
        const [program, config] = params as [string, { filters: { memcmp?: { offset: number } }[] }];
        if (program.startsWith("Stake")) {
          const offset = config.filters.find((f) => f.memcmp)?.memcmp?.offset;
          const a = stakeAccount(STAKE_A, 10_002_282_880, "700", NO_EPOCH);
          const b = stakeAccount(STAKE_B, 2_000_000_000, "650", "801");
          return json({ jsonrpc: "2.0", id: 1, result: offset === 12 ? [a, b] : [a] });
        }
        if (program.startsWith("MFv2")) {
          if (fail.marginfi) return json({ jsonrpc: "2.0", id: 1, error: { code: -32010, message: "MFv2… excluded from account secondary indexes; this RPC method unavailable for key" } });
          const data = marginfiAccount();
          return json({ jsonrpc: "2.0", id: 1, result: [{ pubkey: MARGINFI_ACCOUNT, account: { data: [base64.encode(data), "base64"], lamports: 1, owner: program, executable: false, rentEpoch: 0, space: data.length } }] });
        }
      }
    }
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
}

const byApp = (positions: Awaited<ReturnType<typeof readSolanaApps>>["positions"], app: string) => positions.filter((p) => p.app === app);

describe("readSolanaApps", () => {
  it("reads stake accounts, marginfi, Drift, Save and Jupiter Lend", async () => {
    const read = await readSolanaApps(WALLET, { fetch: mockFetch() });
    expect(read.notes).toEqual([]);
    expect(read.spot).toEqual([]);

    const [stake] = byApp(read.positions, "Solana staking");
    expect(stake.category).toBe("staking");
    expect(stake.legs).toHaveLength(2);
    expect(stake.legs.reduce((sum, leg) => sum + leg.amount, 0)).toBeCloseTo(12.00228288, 8);
    expect(stake.legs[0].usd).toBeCloseTo(10.00228288 * 150, 6);
    expect(stake.note).toContain("1 active, 1 deactivating");

    const [marginfi] = byApp(read.positions, "marginfi");
    expect(marginfi.category).toBe("lending");
    const mSupply = marginfi.legs.find((leg) => leg.side === "supply")!;
    const mBorrow = marginfi.legs.find((leg) => leg.side === "borrow")!;
    expect(mSupply).toMatchObject({ symbol: "SOL", isCollateral: true, liquidationThreshold: 0.9 });
    expect(mSupply.amount).toBeCloseTo(10, 9);
    expect(mSupply.usd).toBeCloseTo(1500, 6);
    expect(mSupply.apy).toBeCloseTo(0.05, 6);
    expect(mBorrow).toMatchObject({ symbol: "USDC" });
    expect(mBorrow.amount).toBeCloseTo(500, 6);
    expect(mBorrow.apy).toBeCloseTo(0.08, 6);
    expect(marginfi.healthFactor).toBeCloseTo((1500 * 0.9) / 500, 6);
    expect(marginfi.healthFactorSource).toBe("protocol");

    const [drift] = byApp(read.positions, "Drift");
    expect(drift.category).toBe("other");
    expect(drift.label).toBe("Drift Main · Solana");
    const usdc = drift.legs.find((leg) => leg.id === "supply-0")!;
    expect(usdc.amount).toBeCloseTo(1000, 6);
    expect(usdc.liquidationThreshold).toBe(1);
    const perp = drift.legs.find((leg) => leg.id === "perp-0")!;
    expect(perp).toMatchObject({ side: "supply", symbol: "SOL", amount: 50, usd: 7500, isCollateral: false });
    expect(drift.legs.find((leg) => leg.id === "perp-0-quote")).toMatchObject({ side: "borrow", symbol: "USDC", amount: 7400, usd: 7400 });
    const net = drift.legs.reduce((sum, leg) => sum + (leg.side === "supply" ? leg.usd : -leg.usd), 0);
    expect(net).toBeCloseTo(1100, 6);
    expect(drift.healthFactor).toBeCloseTo((1000 + 100) / (7500 * 0.03), 6);

    const [save] = byApp(read.positions, "Save");
    expect(save.label).toBe("Save Lending · Solana");
    const sSupply = save.legs.find((leg) => leg.side === "supply")!;
    const sBorrow = save.legs.find((leg) => leg.side === "borrow")!;
    expect(sSupply.symbol).toBe("SOL");
    expect(sSupply.amount).toBeCloseTo(5, 9);
    expect(sSupply.liquidationThreshold).toBe(0.85);
    expect(sSupply.apy).toBeCloseTo(0.4 * 0.04 * 0.8, 9);
    expect(sBorrow.symbol).toBe("USDC");
    expect(sBorrow.amount).toBeCloseTo(220, 6);
    expect(save.healthFactor).toBeCloseTo((5 * 150 * 0.85) / 220, 6);

    const [jupiter] = byApp(read.positions, "Jupiter Lend");
    expect(jupiter.category).toBe("yield");
    expect(jupiter.legs).toHaveLength(1);
    expect(jupiter.legs[0]).toMatchObject({ symbol: "USDC", amount: 100.5, usd: 100.5, apy: 0.0448, isCollateral: false });
  });

  it("turns failing apps into notes and keeps the rest", async () => {
    const read = await readSolanaApps(WALLET, { fetch: mockFetch({ jupiter: true, marginfi: true }) });
    expect(read.notes).toHaveLength(2);
    expect(read.notes).toContain("Jupiter Lend: lite-api.jup.ag returned 500");
    expect(read.notes.find((note) => note.startsWith("marginfi:"))).toContain("excluded from account secondary indexes");
    expect(byApp(read.positions, "Drift")).toHaveLength(1);
    expect(byApp(read.positions, "Save")).toHaveLength(1);
    expect(byApp(read.positions, "Solana staking")).toHaveLength(1);
  });

  it("rejects input that is not a Solana address", async () => {
    await expect(readSolanaApps("0x1234", { fetch: mockFetch() })).rejects.toThrow("Solana address");
  });
});
