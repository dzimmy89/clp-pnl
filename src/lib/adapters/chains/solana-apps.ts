import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import { isSolanaAddress } from "@/lib/addresses";
import {
  emptyRead,
  getJson,
  legOf,
  llamaPrices,
  positionOf,
  readApp,
  rpc,
  units,
  type ChainDeps,
  type ChainReader,
} from "@/lib/adapters/chains/common";
import type { Leg, Position } from "@/lib/types";

/**
 * Solana app positions that the wallet and Kamino Lend readers do not cover. Spot stays empty.
 * - Solana staking: native stake accounts by staker or withdrawer (RPC getProgramAccounts, jsonParsed).
 * - marginfi: accounts in the main group by authority (RPC getProgramAccounts with dataSize + memcmp),
 *   banks via getMultipleAccounts. Health uses marginfi's maintenance weights at DefiLlama prices.
 * - Drift: sub-account PDAs from the UserStats PDA, spot and perp markets parsed from their PDAs.
 *   Health is Drift's maintenance collateral over its maintenance margin requirement.
 * - Save (formerly Solend): market list from api.save.finance, each market's default obligation
 *   derived with createWithSeed and read via getMultipleAccounts.
 * - Jupiter Lend Earn: lite-api.jup.ag/lend/v1/earn/positions.
 * Env: SOLANA_RPC_URL (default public mainnet RPC, which may refuse getProgramAccounts on large
 * programs; marginfi then becomes a note), JUPITER_API_KEY (optional, switches to api.jup.ag).
 */

const PROTOCOL = "solana-apps" as const;
const CHAIN = "Solana";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const MARGINFI_PROGRAM = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";
const MARGINFI_GROUP = "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8";
const DRIFT_PROGRAM = "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH";
const SAVE_PROGRAM = "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo";
const SAVE_MAIN_MARKET = "4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY";
const SAVE_CONFIGS = "https://api.save.finance/v1/markets/configs?scope=all&deployment=production";

const KNOWN_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA: "USDS",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: "bSOL",
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: "JupSOL",
  "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm": "INF",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: "JTO",
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: "PYTH",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: "WIF",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC",
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: "cbBTC",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "ETH",
};

function rpcUrl(): string {
  return process.env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC;
}

// ---- bytes, addresses and accounts ----

const utf8 = (text: string) => new TextEncoder().encode(text);
const u16le = (value: number) => Uint8Array.of(value & 0xff, value >> 8);
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const u8 = (data: Uint8Array, at: number) => data[at];
const u16 = (data: Uint8Array, at: number) => view(data).getUint16(at, true);
const u32 = (data: Uint8Array, at: number) => view(data).getUint32(at, true);
const u64 = (data: Uint8Array, at: number) => view(data).getBigUint64(at, true);
const i64 = (data: Uint8Array, at: number) => view(data).getBigInt64(at, true);
const u128 = (data: Uint8Array, at: number) => (view(data).getBigUint64(at + 8, true) << 64n) | u64(data, at);
const i128 = (data: Uint8Array, at: number) => BigInt.asIntN(128, u128(data, at));
const key = (data: Uint8Array, at: number) => base58.encode(data.subarray(at, at + 32));
const wad = (value: bigint) => Number(value) / 1e18;
/** marginfi's fixed-point I80F48. */
const i80f48 = (data: Uint8Array, at: number) => Number(i128(data, at)) / 2 ** 48;
const label32 = (data: Uint8Array, at: number) => new TextDecoder().decode(data.subarray(at, at + 32)).replace(/\0/g, "").trim();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Solana's findProgramAddress. */
export function findPda(seeds: Uint8Array[], program: string): string {
  const programBytes = base58.decode(program);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(concat(...seeds, Uint8Array.of(bump), programBytes, utf8("ProgramDerivedAddress")));
    if (!isOnCurve(hash)) return base58.encode(hash);
  }
  throw new Error("No program address found");
}

/** Solana's createWithSeed. */
export function addressWithSeed(base: string, seed: string, program: string): string {
  return base58.encode(sha256(concat(base58.decode(base), utf8(seed), base58.decode(program))));
}

type AccountData = { data: [string, string] } | null;

async function getAccounts(keys: string[], deps: ChainDeps): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const unique = [...new Set(keys)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));
  const results = await Promise.all(
    chunks.map((chunk) =>
      rpc<{ value: AccountData[] }>(rpcUrl(), "getMultipleAccounts", [chunk, { encoding: "base64" }], deps),
    ),
  );
  results.forEach((result, index) =>
    result.value.forEach((account, i) => {
      if (account) out.set(chunks[index][i], base64.decode(account.data[0]));
    }),
  );
  return out;
}

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

async function mintPrices(mints: string[], deps: ChainDeps): Promise<Record<string, number>> {
  const prices = await llamaPrices(mints.map((mint) => `solana:${mint}`), deps);
  return Object.fromEntries(mints.map((mint) => [mint, prices[`solana:${mint}`] ?? 0]));
}

/** Symbols for mints: a small known list first, then DefiLlama's coin data. */
async function mintSymbols(mints: string[], deps: ChainDeps): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const unknown: string[] = [];
  for (const mint of new Set(mints)) {
    if (KNOWN_MINTS[mint]) out[mint] = KNOWN_MINTS[mint];
    else unknown.push(mint);
  }
  if (unknown.length) {
    const body = await getJson<{ coins?: Record<string, { symbol?: string }> }>(
      `https://coins.llama.fi/prices/current/${unknown.map((mint) => `solana:${mint}`).join(",")}`,
      {},
      deps,
    ).catch(() => ({ coins: undefined }));
    for (const mint of unknown) out[mint] = body.coins?.[`solana:${mint}`]?.symbol ?? short(mint);
  }
  return out;
}

// ---- native stake ----

const NO_EPOCH = "18446744073709551615";
const SOL_MINT = "So11111111111111111111111111111111111111112";

interface StakeAccount {
  pubkey: string;
  account: {
    lamports: number;
    data: {
      parsed?: {
        type?: string;
        info?: { stake?: { delegation?: { voter: string; activationEpoch: string; deactivationEpoch: string } } | null };
      };
    };
  };
}

function stakeStatus(account: StakeAccount, epoch: number | null): string {
  const delegation = account.account.data.parsed?.info?.stake?.delegation;
  if (!delegation) return "undelegated";
  if (epoch == null) return "delegated";
  if (String(delegation.deactivationEpoch) !== NO_EPOCH) return Number(delegation.deactivationEpoch) <= epoch ? "inactive" : "deactivating";
  return Number(delegation.activationEpoch) >= epoch ? "activating" : "active";
}

async function readStake(wallet: string, deps: ChainDeps): Promise<Position[]> {
  const query = (offset: number) =>
    rpc<StakeAccount[]>(
      rpcUrl(),
      "getProgramAccounts",
      [STAKE_PROGRAM, { encoding: "jsonParsed", filters: [{ dataSize: 200 }, { memcmp: { offset, bytes: wallet } }] }],
      deps,
    );
  const [byStaker, byWithdrawer, epochInfo] = await Promise.all([
    query(12),
    query(44),
    rpc<{ epoch: number }>(rpcUrl(), "getEpochInfo", [], deps).catch(() => null),
  ]);
  const accounts = [...new Map([...byStaker, ...byWithdrawer].map((item) => [item.pubkey, item])).values()];
  if (!accounts.length) return [];
  const { [SOL_MINT]: price } = await mintPrices([SOL_MINT], deps);
  const counts = new Map<string, number>();
  const legs = accounts.map((item) => {
    const status = stakeStatus(item, epochInfo?.epoch ?? null);
    counts.set(status, (counts.get(status) ?? 0) + 1);
    return legOf({
      id: `stake-${item.pubkey}`,
      side: "supply",
      symbol: "SOL",
      amount: units(item.account.lamports, 9),
      price,
      isCollateral: false,
    });
  });
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(", ");
  const position = positionOf({
    protocol: PROTOCOL,
    app: "Solana staking",
    category: "staking",
    chain: CHAIN,
    wallet,
    legs,
    note: `${accounts.length} native stake account${accounts.length === 1 ? "" : "s"} (${summary}). Amounts include the rent reserve.`,
  });
  return position ? [position] : [];
}

// ---- marginfi ----

const MARGINFI_ACCOUNT_SIZE = 2312;
const U32_MAX = 0xffffffff;

interface MarginfiBank {
  mint: string;
  decimals: number;
  assetShareValue: number;
  liabilityShareValue: number;
  assetWeightMaint: number;
  liabilityWeightMaint: number;
  lendingApr: number;
  borrowingApr: number;
}

const weight = (value: number) => Math.round(value * 1e4) / 1e4;

function parseMarginfiBank(data: Uint8Array): MarginfiBank {
  return {
    mint: key(data, 8),
    decimals: u8(data, 40),
    assetShareValue: i80f48(data, 80),
    liabilityShareValue: i80f48(data, 96),
    assetWeightMaint: weight(i80f48(data, 312)),
    liabilityWeightMaint: weight(i80f48(data, 344)),
    lendingApr: (u32(data, 1380) / U32_MAX) * 10,
    borrowingApr: (u32(data, 1384) / U32_MAX) * 10,
  };
}

function parseMarginfiBalances(data: Uint8Array) {
  const out: { bank: string; assetShares: number; liabilityShares: number }[] = [];
  for (let i = 0; i < 16; i++) {
    const at = 72 + i * 104;
    if (!u8(data, at)) continue;
    out.push({ bank: key(data, at + 1), assetShares: i80f48(data, at + 40), liabilityShares: i80f48(data, at + 56) });
  }
  return out;
}

async function readMarginfi(wallet: string, deps: ChainDeps): Promise<Position[]> {
  const found = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>(
    rpcUrl(),
    "getProgramAccounts",
    [
      MARGINFI_PROGRAM,
      {
        encoding: "base64",
        filters: [
          { dataSize: MARGINFI_ACCOUNT_SIZE },
          { memcmp: { offset: 8, bytes: MARGINFI_GROUP } },
          { memcmp: { offset: 40, bytes: wallet } },
        ],
      },
    ],
    deps,
  );
  const accounts = found.map((item) => ({ address: item.pubkey, balances: parseMarginfiBalances(base64.decode(item.account.data[0])) }));
  const bankKeys = accounts.flatMap((account) => account.balances.map((balance) => balance.bank));
  if (!bankKeys.length) return [];
  const bankData = await getAccounts(bankKeys, deps);
  const banks = new Map([...bankData].map(([address, data]) => [address, parseMarginfiBank(data)]));
  const mints = [...new Set([...banks.values()].map((bank) => bank.mint))];
  const [prices, symbols] = await Promise.all([mintPrices(mints, deps), mintSymbols(mints, deps)]);

  const positions: Position[] = [];
  for (const account of accounts) {
    const legs: Leg[] = [];
    let weightedAssets = 0;
    let weightedLiabilities = 0;
    for (const balance of account.balances) {
      const bank = banks.get(balance.bank);
      if (!bank) continue;
      const price = prices[bank.mint];
      const symbol = symbols[bank.mint];
      const supplied = (balance.assetShares * bank.assetShareValue) / 10 ** bank.decimals;
      const borrowed = (balance.liabilityShares * bank.liabilityShareValue) / 10 ** bank.decimals;
      if (supplied > 0) {
        const threshold = bank.assetWeightMaint > 0 && bank.assetWeightMaint <= 1 ? bank.assetWeightMaint : undefined;
        legs.push(
          legOf({ id: `supply-${balance.bank}`, side: "supply", symbol, amount: supplied, price, apy: bank.lendingApr, liquidationThreshold: threshold }),
        );
        weightedAssets += supplied * price * bank.assetWeightMaint;
      }
      if (borrowed > 0) {
        legs.push(legOf({ id: `borrow-${balance.bank}`, side: "borrow", symbol, amount: borrowed, price, apy: bank.borrowingApr }));
        weightedLiabilities += borrowed * price * bank.liabilityWeightMaint;
      }
    }
    const position = positionOf({
      protocol: PROTOCOL,
      app: "marginfi",
      category: "lending",
      chain: CHAIN,
      wallet,
      legs,
      key: accounts.length > 1 ? account.address : undefined,
      label: accounts.length > 1 ? `marginfi Lending ${short(account.address)} · ${CHAIN}` : undefined,
      healthFactor: weightedLiabilities > 0 ? weightedAssets / weightedLiabilities : null,
      note: "Health is marginfi's maintenance-weighted assets over liabilities at DefiLlama prices.",
    });
    if (position) positions.push(position);
  }
  return positions;
}

// ---- Drift ----

const DRIFT_MAX_SUBACCOUNTS = 16;

interface DriftSpotMarket {
  mint: string;
  name: string;
  oraclePrice: number;
  cumulativeDepositInterest: bigint;
  cumulativeBorrowInterest: bigint;
  maintenanceAssetWeight: number;
  maintenanceLiabilityWeight: number;
  decimals: number;
}

interface DriftPerpMarket {
  name: string;
  oraclePrice: number;
  marginRatioMaintenance: number;
  unrealizedPnlMaintenanceAssetWeight: number;
}

function parseDriftSpotMarket(data: Uint8Array): DriftSpotMarket {
  return {
    mint: key(data, 72),
    name: label32(data, 136),
    oraclePrice: Number(i64(data, 168)) / 1e6,
    cumulativeDepositInterest: u128(data, 464),
    cumulativeBorrowInterest: u128(data, 480),
    maintenanceAssetWeight: u32(data, 644) / 1e4,
    maintenanceLiabilityWeight: u32(data, 652) / 1e4,
    decimals: u32(data, 680),
  };
}

function parseDriftPerpMarket(data: Uint8Array): DriftPerpMarket {
  return {
    name: label32(data, 1000),
    oraclePrice: Number(i64(data, 72)) / 1e6,
    marginRatioMaintenance: u32(data, 1140) / 1e4,
    unrealizedPnlMaintenanceAssetWeight: u32(data, 1148) / 1e4,
  };
}

function parseDriftUser(data: Uint8Array) {
  const spot: { marketIndex: number; scaledBalance: bigint; borrow: boolean }[] = [];
  const perp: { marketIndex: number; base: number; quote: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const at = 104 + i * 40;
    const scaledBalance = u64(data, at);
    if (scaledBalance > 0n) spot.push({ marketIndex: u16(data, at + 32), scaledBalance, borrow: u8(data, at + 34) === 1 });
  }
  for (let i = 0; i < 8; i++) {
    const at = 424 + i * 96;
    const base = Number(i64(data, at + 8)) / 1e9;
    const quote = Number(i64(data, at + 16)) / 1e6;
    if (base !== 0 || quote !== 0) perp.push({ marketIndex: u16(data, at + 92), base, quote });
  }
  return { name: label32(data, 72), subAccountId: u16(data, 4346), spot, perp };
}

/** Drift's getTokenAmount: scaled balance × cumulative interest ÷ 10^(19 − decimals). */
function driftTokenAmount(scaled: bigint, market: DriftSpotMarket, borrow: boolean): number {
  const interest = borrow ? market.cumulativeBorrowInterest : market.cumulativeDepositInterest;
  return units((scaled * interest) / 10n ** BigInt(19 - market.decimals), market.decimals);
}

async function readDrift(wallet: string, deps: ChainDeps): Promise<Position[]> {
  const owner = base58.decode(wallet);
  const statsKey = findPda([utf8("user_stats"), owner], DRIFT_PROGRAM);
  const stats = (await getAccounts([statsKey], deps)).get(statsKey);
  if (!stats) return [];
  const created = Math.min(u16(stats, 186), DRIFT_MAX_SUBACCOUNTS);
  const userKeys = Array.from({ length: created }, (_, id) => findPda([utf8("user"), owner, u16le(id)], DRIFT_PROGRAM));
  const users = [...(await getAccounts(userKeys, deps)).values()].map(parseDriftUser);
  const spotIndexes = [...new Set(users.flatMap((user) => user.spot.map((item) => item.marketIndex)))];
  const perpIndexes = [...new Set(users.flatMap((user) => user.perp.map((item) => item.marketIndex)))];
  if (!spotIndexes.length && !perpIndexes.length) return [];
  const spotKey = (index: number) => findPda([utf8("spot_market"), u16le(index)], DRIFT_PROGRAM);
  const perpKey = (index: number) => findPda([utf8("perp_market"), u16le(index)], DRIFT_PROGRAM);
  const marketData = await getAccounts([...spotIndexes.map(spotKey), ...perpIndexes.map(perpKey)], deps);
  const spotMarkets = new Map<number, DriftSpotMarket>();
  const perpMarkets = new Map<number, DriftPerpMarket>();
  for (const index of spotIndexes) {
    const data = marketData.get(spotKey(index));
    if (data) spotMarkets.set(index, parseDriftSpotMarket(data));
  }
  for (const index of perpIndexes) {
    const data = marketData.get(perpKey(index));
    if (data) perpMarkets.set(index, parseDriftPerpMarket(data));
  }
  const prices = await mintPrices([...spotMarkets.values()].map((market) => market.mint), deps);

  const positions: Position[] = [];
  for (const user of users) {
    const legs: Leg[] = [];
    let collateral = 0;
    let requirement = 0;
    for (const item of user.spot) {
      const market = spotMarkets.get(item.marketIndex);
      if (!market) continue;
      const amount = driftTokenAmount(item.scaledBalance, market, item.borrow);
      const price = prices[market.mint] || market.oraclePrice;
      if (item.borrow) {
        legs.push(legOf({ id: `borrow-${item.marketIndex}`, side: "borrow", symbol: market.name, amount, price }));
        requirement += amount * price * market.maintenanceLiabilityWeight;
      } else {
        legs.push(
          legOf({
            id: `supply-${item.marketIndex}`,
            side: "supply",
            symbol: market.name,
            amount,
            price,
            liquidationThreshold: market.maintenanceAssetWeight || undefined,
          }),
        );
        collateral += amount * price * market.maintenanceAssetWeight;
      }
    }
    for (const item of user.perp) {
      const market = perpMarkets.get(item.marketIndex);
      if (!market) continue;
      const base = market.name.replace(/-PERP$/i, "");
      const notional = Math.abs(item.base) * market.oraclePrice;
      const pnl = item.base * market.oraclePrice + item.quote;
      collateral += pnl > 0 ? pnl * market.unrealizedPnlMaintenanceAssetWeight : pnl;
      requirement += notional * market.marginRatioMaintenance;
      legs.push(
        legOf({
          id: `perp-${item.marketIndex}`,
          side: item.base > 0 ? "supply" : "borrow",
          symbol: base,
          amount: Math.abs(item.base),
          price: market.oraclePrice,
          isCollateral: false,
        }),
        legOf({
          id: `perp-${item.marketIndex}-quote`,
          side: item.quote >= 0 ? "supply" : "borrow",
          symbol: "USDC",
          amount: Math.abs(item.quote),
          usd: Math.abs(item.quote),
          price: 1,
          isCollateral: false,
        }),
      );
    }
    const hasPerps = user.perp.length > 0;
    const position = positionOf({
      protocol: PROTOCOL,
      app: "Drift",
      category: hasPerps ? "other" : "lending",
      chain: CHAIN,
      wallet,
      legs,
      key: String(user.subAccountId),
      label: `Drift ${user.name || `sub-account ${user.subAccountId}`} · ${CHAIN}`,
      healthFactor: requirement > 0 ? collateral / requirement : null,
      note: [
        "Health is Drift's maintenance collateral over its maintenance margin requirement.",
        hasPerps ? "Each perp is a base-asset leg (long supply, short borrow) plus its USDC quote leg, so the net is the unsettled PnL." : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
    if (position) positions.push(position);
  }
  return positions;
}

// ---- Save (Solend) ----

const OBLIGATION_SIZE = 1300;
const U64_MAX = 2n ** 64n - 1n;

interface SaveMarketConfig {
  name?: string;
  address: string;
  isPrimary?: boolean;
  reserves?: { address: string; liquidityToken?: { symbol?: string; mint?: string } }[];
}

interface SaveReserve {
  mint: string;
  decimals: number;
  totalSupply: number;
  collateralSupply: number;
  cumulativeBorrowRate: number;
  marketPrice: number;
  liquidationThreshold: number;
  borrowWeight: number;
  supplyApr: number;
  borrowApr: number;
}

function parseSaveReserve(data: Uint8Array): SaveReserve {
  const available = Number(u64(data, 171));
  const borrowed = wad(u128(data, 179));
  const fees = wad(u128(data, 373));
  const total = borrowed + available;
  const utilization = total > 0 ? borrowed / total : 0;
  const optimal = u8(data, 299) / 100;
  const max = Math.max(u8(data, 470), u8(data, 299)) / 100;
  const [minRate, optimalRate, maxRate] = [u8(data, 303) / 100, u8(data, 304) / 100, u8(data, 305) / 100];
  const superMax = Math.max(Number(u64(data, 471)) / 100, maxRate);
  let borrowApr: number;
  if (utilization <= optimal) borrowApr = optimal > 0 ? (utilization / optimal) * (optimalRate - minRate) + minRate : minRate;
  else if (utilization <= max) borrowApr = ((utilization - optimal) / (max - optimal || 1)) * (maxRate - optimalRate) + optimalRate;
  else borrowApr = ((utilization - max) / (1 - max || 1)) * (superMax - maxRate) + maxRate;
  const addedWeight = u64(data, 445);
  return {
    mint: key(data, 42),
    decimals: u8(data, 74),
    totalSupply: total - fees,
    collateralSupply: Number(u64(data, 259)),
    cumulativeBorrowRate: wad(u128(data, 195)),
    marketPrice: wad(u128(data, 211)),
    liquidationThreshold: u8(data, 302) / 100,
    borrowWeight: addedWeight === U64_MAX ? 1 : 1 + Number(addedWeight) / 1e4,
    supplyApr: utilization * borrowApr * (1 - u8(data, 372) / 100),
    borrowApr,
  };
}

function parseObligation(data: Uint8Array) {
  const depositsLen = u8(data, 202);
  const borrowsLen = u8(data, 203);
  const deposits = Array.from({ length: depositsLen }, (_, i) => {
    const at = 204 + i * 88;
    return { reserve: key(data, at), cTokens: Number(u64(data, at + 32)) };
  });
  const borrows = Array.from({ length: borrowsLen }, (_, i) => {
    const at = 204 + depositsLen * 88 + i * 112;
    return { reserve: key(data, at), cumulativeBorrowRate: wad(u128(data, at + 32)), borrowedWads: wad(u128(data, at + 48)) };
  });
  return { market: key(data, 10), owner: key(data, 42), deposits, borrows };
}

async function readSave(wallet: string, notes: string[], deps: ChainDeps): Promise<Position[]> {
  const listed = await getJson<SaveMarketConfig[]>(SAVE_CONFIGS, {}, deps).catch(() => {
    notes.push("Save: market list unavailable, read the main pool only");
    return [];
  });
  const markets = Array.isArray(listed) ? listed.filter((market) => isSolanaAddress(market?.address ?? "")) : [];
  if (!markets.some((market) => market.address === SAVE_MAIN_MARKET)) markets.unshift({ name: "Main", address: SAVE_MAIN_MARKET, isPrimary: true });
  const byMarket = new Map(markets.slice(0, 300).map((market) => [market.address, market]));
  const obligationKeys = [...byMarket.keys()].map((market) => addressWithSeed(wallet, market.slice(0, 32), SAVE_PROGRAM));
  const obligations = [...(await getAccounts(obligationKeys, deps)).values()]
    .filter((data) => data.length === OBLIGATION_SIZE)
    .map(parseObligation)
    .filter((item) => item.owner === wallet && (item.deposits.length || item.borrows.length));
  if (!obligations.length) return [];

  const reserveKeys = obligations.flatMap((item) => [...item.deposits, ...item.borrows].map((entry) => entry.reserve));
  const reserves = new Map([...(await getAccounts(reserveKeys, deps))].map(([address, data]) => [address, parseSaveReserve(data)]));
  const configSymbols = new Map(
    markets.flatMap((market) => (market.reserves ?? []).map((reserve) => [reserve.address, reserve.liquidityToken?.symbol ?? ""] as const)),
  );
  const mints = [...new Set([...reserves.values()].map((reserve) => reserve.mint))];
  const unnamed = [...reserves].filter(([address]) => !configSymbols.get(address)).map(([, reserve]) => reserve.mint);
  const [prices, symbols] = await Promise.all([mintPrices(mints, deps), mintSymbols(unnamed, deps)]);

  const positions: Position[] = [];
  for (const obligation of obligations) {
    const legs: Leg[] = [];
    let limit = 0;
    let debt = 0;
    for (const deposit of obligation.deposits) {
      const reserve = reserves.get(deposit.reserve);
      if (!reserve || !(reserve.collateralSupply > 0)) continue;
      const amount = (deposit.cTokens * reserve.totalSupply) / reserve.collateralSupply / 10 ** reserve.decimals;
      const price = prices[reserve.mint] || reserve.marketPrice;
      const symbol = configSymbols.get(deposit.reserve) || symbols[reserve.mint];
      legs.push(
        legOf({
          id: `supply-${deposit.reserve}`,
          side: "supply",
          symbol,
          amount,
          price,
          apy: reserve.supplyApr,
          liquidationThreshold: reserve.liquidationThreshold || undefined,
        }),
      );
      limit += amount * price * reserve.liquidationThreshold;
    }
    for (const borrow of obligation.borrows) {
      const reserve = reserves.get(borrow.reserve);
      if (!reserve || !(borrow.cumulativeBorrowRate > 0)) continue;
      const amount = (borrow.borrowedWads * (reserve.cumulativeBorrowRate / borrow.cumulativeBorrowRate)) / 10 ** reserve.decimals;
      const price = prices[reserve.mint] || reserve.marketPrice;
      const symbol = configSymbols.get(borrow.reserve) || symbols[reserve.mint];
      legs.push(legOf({ id: `borrow-${borrow.reserve}`, side: "borrow", symbol, amount, price, apy: reserve.borrowApr }));
      debt += amount * price * reserve.borrowWeight;
    }
    const market = byMarket.get(obligation.market);
    const primary = obligation.market === SAVE_MAIN_MARKET || market?.isPrimary;
    const position = positionOf({
      protocol: PROTOCOL,
      app: "Save",
      category: "lending",
      chain: CHAIN,
      wallet,
      legs,
      key: primary ? undefined : obligation.market,
      label: primary ? undefined : `Save ${market?.name ?? short(obligation.market)} pool · ${CHAIN}`,
      healthFactor: debt > 0 ? limit / debt : null,
      note: "Health is Save's liquidation threshold over borrow-weighted debt at DefiLlama prices.",
    });
    if (position) positions.push(position);
  }
  return positions;
}

// ---- Jupiter Lend Earn ----

interface JupiterEarnPosition {
  token: {
    symbol: string;
    totalRate?: string;
    asset: { address: string; symbol: string; decimals: number; price?: string };
  };
  underlyingAssets: string;
}

async function readJupiterLend(wallet: string, deps: ChainDeps): Promise<Position[]> {
  const apiKey = process.env.JUPITER_API_KEY?.trim();
  const base = apiKey ? "https://api.jup.ag/lend" : "https://lite-api.jup.ag/lend";
  const rows = await getJson<JupiterEarnPosition[]>(
    `${base}/v1/earn/positions?users=${wallet}`,
    apiKey ? { headers: { "x-api-key": apiKey } } : {},
    deps,
  );
  const held = rows.filter((row) => BigInt(row.underlyingAssets || "0") > 0n);
  if (!held.length) return [];
  const prices = await mintPrices(held.map((row) => row.token.asset.address), deps);
  const legs = held.map((row) =>
    legOf({
      id: `earn-${row.token.asset.address}`,
      side: "supply",
      symbol: row.token.asset.symbol,
      amount: units(row.underlyingAssets, row.token.asset.decimals),
      price: prices[row.token.asset.address] || Number(row.token.asset.price ?? 0),
      apy: Number(row.token.totalRate ?? 0) / 1e4,
      isCollateral: false,
    }),
  );
  const position = positionOf({
    protocol: PROTOCOL,
    app: "Jupiter Lend",
    category: "yield",
    chain: CHAIN,
    wallet,
    legs,
    note: "Jupiter Lend Earn deposits, valued in the underlying token.",
  });
  return position ? [position] : [];
}

// ---- reader ----

export const readSolanaApps: ChainReader = async (address, deps = {}) => {
  const wallet = address.trim();
  if (!isSolanaAddress(wallet) || base58.decode(wallet).length !== 32) {
    throw new Error("That does not look like a Solana address.");
  }
  const out = emptyRead();
  const results = await Promise.all([
    readApp("Solana staking", out.notes, () => readStake(wallet, deps)),
    readApp("marginfi", out.notes, () => readMarginfi(wallet, deps)),
    readApp("Drift", out.notes, () => readDrift(wallet, deps)),
    readApp("Save", out.notes, () => readSave(wallet, out.notes, deps)),
    readApp("Jupiter Lend", out.notes, () => readJupiterLend(wallet, deps)),
  ]);
  for (const positions of results) out.positions.push(...(positions ?? []));
  return out;
};
