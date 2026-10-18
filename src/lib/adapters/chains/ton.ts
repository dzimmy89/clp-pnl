import { sha256 } from "@noble/hashes/sha2.js";
import { Address, beginCell, Cell, Dictionary, storeStateInit, type DictionaryValue } from "@ton/core";
import {
  getJson,
  legOf,
  llamaPrices,
  positionOf,
  readApp,
  spotRow,
  units,
  type ChainDeps,
  type ChainRead,
  type ChainReader,
} from "@/lib/adapters/chains/common";
import type { Leg, Position, SpotHolding } from "@/lib/types";

/**
 * TON wallet reader.
 * - Balances: TON and jettons from tonapi.io (`/v2/accounts/{id}`, `/v2/accounts/{id}/jettons`, which
 *   carries USD prices). Falls back to toncenter v3 (`/api/v3/accountStates`, `/api/v3/jetton/wallets`)
 *   priced through DefiLlama.
 * - Staking: nominator-pool stakes from tonapi (`/v2/staking/nominator/{id}/pools`). Liquid staking
 *   jettons (tsTON, stTON, hTON) stay wallet balances.
 * - EVAA: main, LP, alts and stable pools. Each user contract address is derived the way the EVAA SDK
 *   does it, then the user and pool master states (toncenter v3, tonapi as fallback) are decoded for
 *   principals, accrued rates, APYs and liquidation thresholds.
 * - STON.fi: LP shares from api.ston.fi (`/v1/wallets/{addr}/pools`).
 *
 * Env (all optional): TONAPI_KEY (tonapi.io Bearer token; without it tonapi calls are paced to 1/s),
 * TONCENTER_API_KEY, TONCENTER_API_URL (any toncenter URL; only its origin is used).
 */

const CHAIN = "TON";
const PROTOCOL = "ton" as const;
const TONAPI = "https://tonapi.io";
const STONFI = "https://api.ston.fi";
const TON_PRICE_KEY = "coingecko:the-open-network";
const MAX_SPOT = 100;

type Fetcher = <T>(path: string) => Promise<T>;

function parseTonAddress(input: string): Address {
  let address: Address;
  try {
    address = Address.parse(input.trim());
  } catch {
    throw new Error(`Not a TON address: ${input}`);
  }
  if (address.workChain !== 0 && address.workChain !== -1) throw new Error(`Not a TON address: ${input}`);
  return address;
}

const friendly = (address: Address) => address.toString({ bounceable: true, urlSafe: true });
const raw = (text: string) => Address.parse(text).toRawString();
const llamaKey = (master: string) => `ton:${friendly(Address.parse(master))}`;

let tonapiNextSlot = 0;

function tonapiFetcher(deps: ChainDeps): Fetcher {
  return async <T>(path: string) => {
    const key = process.env.TONAPI_KEY;
    if (!key) {
      const now = Date.now();
      const at = Math.max(now, tonapiNextSlot);
      tonapiNextSlot = at + 1_000;
      if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
    }
    return getJson<T>(`${TONAPI}${path}`, key ? { headers: { authorization: `Bearer ${key}` } } : {}, deps);
  };
}

function toncenterFetcher(deps: ChainDeps): Fetcher {
  let origin = "https://toncenter.com";
  try {
    if (process.env.TONCENTER_API_URL) origin = new URL(process.env.TONCENTER_API_URL).origin;
  } catch {
    // Keep the public endpoint.
  }
  const key = process.env.TONCENTER_API_KEY;
  return <T>(path: string) => getJson<T>(`${origin}${path}`, key ? { headers: { "x-api-key": key } } : {}, deps);
}

// ---------- Balances ----------

interface Holding {
  symbol: string;
  amount: number;
  price: number | null;
  /** Raw jetton master address; absent for TON itself. */
  master?: string;
  /** Known-good token (TON, whitelisted jetton); unpriced ones are kept. */
  trusted: boolean;
}

interface TonapiAccount {
  balance?: number | string;
}

interface TonapiJettons {
  balances?: {
    balance: string;
    price?: { prices?: Record<string, number> };
    jetton: { address: string; symbol?: string; decimals?: number; verification?: string };
  }[];
}

async function balancesFromTonapi(id: string, tonapi: Fetcher): Promise<Holding[]> {
  const [account, jettons] = await Promise.all([
    tonapi<TonapiAccount>(`/v2/accounts/${id}`),
    tonapi<TonapiJettons>(`/v2/accounts/${id}/jettons?currencies=usd`),
  ]);
  const holdings: Holding[] = [{ symbol: "TON", amount: units(String(account.balance ?? 0), 9), price: null, trusted: true }];
  for (const row of jettons.balances ?? []) {
    if (row.jetton.verification === "blacklist") continue;
    holdings.push({
      symbol: row.jetton.symbol || "JETTON",
      amount: units(row.balance, row.jetton.decimals ?? 9),
      price: row.price?.prices?.USD ?? null,
      master: raw(row.jetton.address),
      trusted: row.jetton.verification === "whitelist",
    });
  }
  return holdings;
}

interface ToncenterStates {
  accounts?: { address: string; balance?: string; status?: string; data_boc?: string | null }[];
}

interface ToncenterJettons {
  jetton_wallets?: { balance: string; jetton: string }[];
  metadata?: Record<string, { token_info?: { symbol?: string; extra?: { decimals?: string | number } }[] }>;
}

async function balancesFromToncenter(id: string, toncenter: Fetcher): Promise<Holding[]> {
  const [states, jettons] = await Promise.all([
    toncenter<ToncenterStates>(`/api/v3/accountStates?address=${encodeURIComponent(id)}&include_boc=false`),
    toncenter<ToncenterJettons>(
      `/api/v3/jetton/wallets?owner_address=${encodeURIComponent(id)}&exclude_zero_balance=true&limit=200`,
    ),
  ]);
  const holdings: Holding[] = [
    { symbol: "TON", amount: units(states.accounts?.[0]?.balance ?? "0", 9), price: null, trusted: true },
  ];
  const metadata = new Map(Object.entries(jettons.metadata ?? {}).map(([key, value]) => [raw(key), value]));
  for (const wallet of jettons.jetton_wallets ?? []) {
    const master = raw(wallet.jetton);
    const info = metadata.get(master)?.token_info?.[0];
    holdings.push({
      symbol: info?.symbol || "JETTON",
      amount: units(wallet.balance, Number(info?.extra?.decimals ?? 9)),
      price: null,
      master,
      trusted: false,
    });
  }
  return holdings;
}

async function readBalances(id: string, tonapi: Fetcher, toncenter: Fetcher, deps: ChainDeps, notes: string[]) {
  let holdings: Holding[];
  try {
    holdings = await balancesFromTonapi(id, tonapi);
  } catch (error) {
    try {
      holdings = await balancesFromToncenter(id, toncenter);
      notes.push(`tonapi.io unavailable, balances from toncenter (${error instanceof Error ? error.message : "error"})`);
    } catch (fallbackError) {
      throw new Error(`TON balances unavailable: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`);
    }
  }
  const keys = [TON_PRICE_KEY, ...holdings.filter((h) => h.master && h.price == null).map((h) => llamaKey(h.master!))];
  const prices = await llamaPrices(keys, deps);
  for (const holding of holdings) {
    if (holding.price == null) holding.price = prices[holding.master ? llamaKey(holding.master) : TON_PRICE_KEY] ?? null;
  }
  return { holdings, tonPrice: prices[TON_PRICE_KEY] ?? holdings[0].price ?? null };
}

// ---------- Nominator pools ----------

interface NominatorPools {
  pools?: { pool: string; amount?: number; pending_deposit?: number; pending_withdraw?: number; ready_withdraw?: number }[];
}

interface PoolDetail {
  implementation?: { name?: string };
  pool?: { name?: string; apy?: number; liquid_jetton_master?: string };
}

async function readStaking(id: string, wallet: string, tonapi: Fetcher, tonPrice: number | null): Promise<Position[]> {
  const { pools = [] } = await tonapi<NominatorPools>(`/v2/staking/nominator/${id}/pools`);
  const out: Position[] = [];
  for (const stake of pools) {
    const detail = await tonapi<PoolDetail>(`/v2/staking/pool/${stake.pool}`).catch(() => null);
    const liquid = Boolean(detail?.pool?.liquid_jetton_master);
    // Liquid pools are already counted through their jetton (tsTON, hTON...), so only pending withdrawals count.
    const staked = liquid ? 0 : (stake.amount ?? 0) + (stake.pending_deposit ?? 0);
    const leaving = (stake.pending_withdraw ?? 0) + (stake.ready_withdraw ?? 0);
    const apy = typeof detail?.pool?.apy === "number" ? detail.pool.apy / 100 : 0;
    const position = positionOf({
      protocol: PROTOCOL,
      app: detail?.implementation?.name || "TON Staking",
      category: "staking",
      chain: CHAIN,
      wallet,
      key: raw(stake.pool),
      note: detail?.pool?.name,
      legs: [
        legOf({ id: `${stake.pool}:staked`, side: "supply", symbol: "TON", amount: units(String(staked), 9), price: tonPrice, apy, isCollateral: false }),
        legOf({ id: `${stake.pool}:withdraw`, side: "supply", symbol: "TON", amount: units(String(leaving), 9), price: tonPrice, isCollateral: false }),
      ],
    });
    if (position) out.push(position);
  }
  return out;
}

// ---------- EVAA ----------

/** User contract code shared by every EVAA pool (`LENDING_CODE` in @evaafi/sdk). */
const EVAA_LENDING_CODE = Cell.fromBoc(
  Buffer.from(
    "b5ee9c72c1010e0100fd000d12182a555a6065717691969efd0114ff00f4a413f4bcf2c80b010202c8050202039f740403001ff2f8276a2687d2018fd201800f883b840051d38642c678b64e4400780e58fc10802faf07f80e59fa801e78b096664c02078067c07c100627a7978402014807060007a0ddb0c60201c709080013a0fd007a026900aa90400201200b0a0031b8e1002191960aa00b9e2ca007f4042796d225e8019203f6010201200d0c000bf7c147d2218400b9d10e86981fd201840b07f8138d809797976a2687d2029116382f970fd9178089910374daf81b619fd20182c7883b8701981684100627910eba56001797a6a6ba610fd8200e8768f76a9f6aa00cc2a32a8292878809bef2f1889f883bbcdeb86f01",
    "hex",
  ),
)[0];

export const EVAA_POOLS = [
  { name: "Main", master: "EQC8rUZqR_pWV1BylWUlPNBzyiTYVoBEmQkMIQDZXICfnuRr" },
  { name: "LP", master: "EQBIlZX2URWkXCSg3QF2MJZU-wC5XkBoLww-hdWk2G37Jc6N" },
  { name: "Alts", master: "EQANURVS3fhBO9bivig34iyJQi97FhMbpivo1aUEAS2GYSu-" },
  { name: "Stable", master: "EQCdIdXf1kA_2Hd9mbGzSFDEPA-Px-et8qTWHEXgRGo0K3zd" },
] as const;

/** EVAA asset id is sha256 of its on-chain name; the native coin is registered as "TON". */
export function evaaAssetId(name: string): bigint {
  return BigInt(`0x${Buffer.from(sha256(new TextEncoder().encode(name))).toString("hex")}`);
}

const EVAA_ASSETS = new Map<bigint, { symbol: string; master?: string }>(
  (
    [
      ["TON", "TON"],
      ["USDT", "USDT", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"],
      ["jUSDT", "jUSDT", "EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA"],
      ["jUSDC", "jUSDC", "EQB-MPwrd1G6WKNkLz_VnV6WqBDd142KMQv-g1O-8QUA3728"],
      ["stTON", "stTON", "EQDNhy-nxYFgUqzfUzImBEP67JqsyMIcyk2S5_RwNNEYku0k"],
      ["tsTON", "tsTON", "EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav"],
      ["USDe", "USDe", "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f"],
      ["tsUSDe", "tsUSDe", "EQDQ5UUyPHrLcQJlPAczd_fjxn8SLrlNQwolBznxCdSlfQwr"],
      ["NOT", "NOT", "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT"],
      ["DOGS", "DOGS", "EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS"],
      ["CATI", "CATI", "EQD-cvR0Nz6XAyRBvbhz-abTrRC6sI5tvHvvpeQraV9UAAD7"],
      ["STON", "STON", "EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO"],
      ["EVAA", "EVAA", "EQBKMfjX_a_dsOLm-juxyVZytFP7_KKnzGv6J01kGc72gVBp"],
      ["TONUSDT_DEDUST", "DeDust TON-USDT LP", "EQA-X_yo3fzzbDbJ_0bzFWKqtRuZFIRa1sJsveZJ1YpViO3r"],
      ["TONUSDT_STONFI", "STON.fi TON-USDT LP", "EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4"],
      ["TON_STORM", "Storm TON LP", "EQCNY2AQ3ZDYwJAqx_nzl9i9Xhd_Ex7izKJM6JTxXRnO6n1F"],
      ["USDT_STORM", "Storm USDT LP", "EQCup4xxCulCcNwmOocM9HtDYPU8xe0449tQLp6a-5BLEegW"],
      ["PT_tsUSDe_01Sep2025", "PT-tsUSDe-01SEP2025", "EQDb90Bss5FnIyq7VMmnG2UeZIzZomQsILw9Hjo1wxaF1df3"],
      ["PT_tsUSDe_18Dec2025", "PT-tsUSDe-18DEC2025", "EQBxIkea3baUXLtPVuVaSMsWIkC5S0It3OcM8MeYpPnoEWeM"],
    ] as [string, string, string?][]
  ).map(([name, symbol, master]) => [evaaAssetId(name), { symbol, master }]),
);

/** The user contract an EVAA master deploys for a wallet (subaccount 0), as `calculateUserSCAddr` in the SDK. */
export function evaaUserAddress(master: Address, owner: Address): Address {
  const data = beginCell().storeAddress(master).storeAddress(owner).storeUint(0, 8).storeBit(0).endCell();
  const init = beginCell().store(storeStateInit({ code: EVAA_LENDING_CODE, data })).endCell();
  return new Address(0, init.hash());
}

interface EvaaAssetConfig {
  decimals: number;
  liquidationThreshold: bigint;
  baseBorrowRate: bigint;
  borrowRateSlopeLow: bigint;
  borrowRateSlopeHigh: bigint;
  targetUtilization: bigint;
  reserveFactor: bigint;
}

interface EvaaAssetData {
  sRate: bigint;
  bRate: bigint;
  totalSupply: bigint;
  totalBorrow: bigint;
  lastAccrual: bigint;
}

const readOnly = () => {
  throw new Error("read only");
};

const ASSET_CONFIG_VALUE: DictionaryValue<EvaaAssetConfig> = {
  serialize: readOnly,
  parse: (slice) => {
    slice.loadUintBig(256); // jetton wallet
    const decimals = slice.loadUint(8);
    const ref = slice.loadRef().beginParse();
    ref.loadUint(16); // collateral factor
    const liquidationThreshold = ref.loadUintBig(16);
    ref.loadUint(16); // liquidation bonus
    const baseBorrowRate = ref.loadUintBig(64);
    const borrowRateSlopeLow = ref.loadUintBig(64);
    const borrowRateSlopeHigh = ref.loadUintBig(64);
    ref.loadUintBig(64); // supply slope low
    ref.loadUintBig(64); // supply slope high
    const targetUtilization = ref.loadUintBig(64);
    ref.skip(64 * 3); // origination fee, dust, max total supply
    const reserveFactor = ref.loadUintBig(16);
    return { decimals, liquidationThreshold, baseBorrowRate, borrowRateSlopeLow, borrowRateSlopeHigh, targetUtilization, reserveFactor };
  },
};

const ASSET_DATA_VALUE: DictionaryValue<EvaaAssetData> = {
  serialize: readOnly,
  parse: (slice) => ({
    sRate: slice.loadUintBig(64),
    bRate: slice.loadUintBig(64),
    totalSupply: slice.loadIntBig(64),
    totalBorrow: slice.loadIntBig(64),
    lastAccrual: slice.loadUintBig(32),
  }),
};

const SCALE = BigInt(10) ** BigInt(12);
const ZERO = BigInt(0);

/** Rates accrued to now plus yearly supply and borrow APY, as `calculateCurrentRates` in the SDK. */
function evaaRates(config: EvaaAssetConfig, data: EvaaAssetData, nowSec: bigint) {
  const supplied = (data.totalSupply * data.sRate) / SCALE;
  const borrowed = (data.totalBorrow * data.bRate) / SCALE;
  const utilization = supplied === ZERO ? ZERO : (borrowed * SCALE) / supplied;
  const borrowInterest =
    utilization <= config.targetUtilization
      ? config.baseBorrowRate + (config.borrowRateSlopeLow * utilization) / SCALE
      : config.baseBorrowRate +
        (config.borrowRateSlopeLow * config.targetUtilization) / SCALE +
        (config.borrowRateSlopeHigh * (utilization - config.targetUtilization)) / SCALE;
  const supplyInterest =
    (((borrowInterest * utilization) / SCALE) * (BigInt(10_000) - config.reserveFactor)) / BigInt(10_000);
  const elapsed = nowSec > data.lastAccrual ? nowSec - data.lastAccrual : ZERO;
  const yearly = (perSecond: bigint) => (1 + (Number(perSecond) / 1e12) * 86_400) ** 365 - 1;
  return {
    sRate: data.sRate + (data.sRate * supplyInterest * elapsed) / SCALE,
    bRate: data.bRate + (data.bRate * borrowInterest * elapsed) / SCALE,
    supplyApy: yearly(supplyInterest),
    borrowApy: yearly(borrowInterest),
  };
}

function parseEvaaMaster(data: Cell) {
  const slice = data.beginParse();
  slice.loadRef(); // meta
  slice.loadRef(); // upgrade config
  const config = slice.loadRef().beginParse();
  return {
    configs: config.loadDict(Dictionary.Keys.BigUint(256), ASSET_CONFIG_VALUE),
    assets: slice.loadDict(Dictionary.Keys.BigUint(256), ASSET_DATA_VALUE),
  };
}

function parseEvaaPrincipals(data: Cell): Dictionary<bigint, bigint> {
  const slice = data.beginParse();
  slice.loadCoins(); // code version
  slice.loadAddressAny(); // master
  slice.loadAddressAny(); // owner
  return slice.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.BigInt(64));
}

interface TonapiRawAccount {
  status?: string;
  data?: string;
}

/** Contract data cells by raw address; missing or inactive contracts are left out. */
async function contractData(addresses: Address[], toncenter: Fetcher, tonapi: Fetcher): Promise<Map<string, Cell>> {
  const out = new Map<string, Cell>();
  try {
    const query = addresses.map((a) => `address=${encodeURIComponent(a.toRawString())}`).join("&");
    const { accounts = [] } = await toncenter<ToncenterStates>(`/api/v3/accountStates?${query}&include_boc=true`);
    for (const account of accounts) {
      if (account.status === "active" && account.data_boc) out.set(raw(account.address), Cell.fromBase64(account.data_boc));
    }
  } catch {
    for (const address of addresses) {
      const account = await tonapi<TonapiRawAccount>(`/v2/blockchain/accounts/${address.toRawString()}`).catch((error) => {
        if (error instanceof Error && error.message.endsWith("404")) return null;
        throw error;
      });
      if (account?.status === "active" && account.data) {
        out.set(address.toRawString(), Cell.fromBoc(Buffer.from(account.data, "hex"))[0]);
      }
    }
  }
  return out;
}

async function readEvaa(
  owner: Address,
  wallet: string,
  toncenter: Fetcher,
  tonapi: Fetcher,
  deps: ChainDeps,
  notes: string[],
) {
  const pools = EVAA_POOLS.map((pool) => {
    const master = Address.parse(pool.master);
    return { ...pool, masterAddress: master, user: evaaUserAddress(master, owner) };
  });
  const users = await contractData(pools.map((p) => p.user), toncenter, tonapi);
  const held = pools
    .map((pool) => {
      const data = users.get(pool.user.toRawString());
      const principals = data ? parseEvaaPrincipals(data) : null;
      return principals && principals.values().some((v) => v !== ZERO) ? { ...pool, principals } : null;
    })
    .filter((pool) => pool != null);
  if (!held.length) return [];

  const masters = await contractData(held.map((p) => p.masterAddress), toncenter, tonapi);
  const priceKeys = [TON_PRICE_KEY, ...[...EVAA_ASSETS.values()].filter((a) => a.master).map((a) => llamaKey(a.master!))];
  const prices = await llamaPrices(priceKeys, deps);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));

  const out: Position[] = [];
  for (const pool of held) {
    const masterData = masters.get(pool.masterAddress.toRawString());
    let master: ReturnType<typeof parseEvaaMaster>;
    try {
      if (!masterData) throw new Error("pool state unavailable");
      master = parseEvaaMaster(masterData);
    } catch (error) {
      notes.push(`EVAA ${pool.name} pool: ${error instanceof Error ? error.message : "unreadable"}`);
      continue;
    }
    const { configs, assets } = master;
    const legs: Leg[] = [];
    for (const [assetId, principal] of pool.principals) {
      const meta = EVAA_ASSETS.get(assetId);
      const config = configs.get(assetId);
      const data = assets.get(assetId);
      if (!meta || !config || !data || principal === ZERO) continue;
      const rates = evaaRates(config, data, nowSec);
      const supply = principal > ZERO;
      const amount = units(supply ? (principal * rates.sRate) / SCALE : (-principal * rates.bRate) / SCALE, config.decimals);
      legs.push(
        legOf({
          id: `${pool.name}:${meta.symbol}:${supply ? "supply" : "borrow"}`,
          side: supply ? "supply" : "borrow",
          symbol: meta.symbol,
          amount,
          price: prices[meta.master ? llamaKey(meta.master) : TON_PRICE_KEY],
          apy: supply ? rates.supplyApy : rates.borrowApy,
          liquidationThreshold: supply ? Number(config.liquidationThreshold) / 10_000 : undefined,
        }),
      );
    }
    const position = positionOf({
      protocol: PROTOCOL,
      app: "EVAA",
      category: "lending",
      chain: CHAIN,
      wallet,
      key: pool.name === "Main" ? undefined : pool.name.toLowerCase(),
      label: pool.name === "Main" ? undefined : `EVAA ${pool.name} Pool · ${CHAIN}`,
      legs,
    });
    if (position) out.push(position);
  }
  return out;
}

// ---------- STON.fi ----------

interface StonPools {
  pool_list?: {
    address: string;
    lp_balance?: string;
    lp_total_supply: string;
    reserve0: string;
    reserve1: string;
    token0_address: string;
    token1_address: string;
    apy_7d?: string;
  }[];
}

interface StonAsset {
  asset?: { symbol?: string; decimals?: number; kind?: string; dex_price_usd?: string; third_party_price_usd?: string };
}

async function readStonfi(owner: Address, wallet: string, deps: ChainDeps) {
  const ston = <T>(path: string) => getJson<T>(`${STONFI}${path}`, {}, deps);
  const { pool_list = [] } = await ston<StonPools>(`/v1/wallets/${friendly(owner)}/pools`);
  const pools = pool_list.filter((pool) => BigInt(pool.lp_balance || "0") > ZERO && BigInt(pool.lp_total_supply || "0") > ZERO);
  const assets = new Map<string, Promise<StonAsset["asset"] | null>>();
  const assetOf = (address: string) => {
    if (!assets.has(address)) {
      assets.set(address, ston<StonAsset>(`/v1/assets/${address}`).then((body) => body.asset ?? null, () => null));
    }
    return assets.get(address)!;
  };
  const out: Position[] = [];
  for (const pool of pools) {
    const [token0, token1] = await Promise.all([assetOf(pool.token0_address), assetOf(pool.token1_address)]);
    const share = (reserve: string) => (BigInt(reserve) * BigInt(pool.lp_balance!)) / BigInt(pool.lp_total_supply);
    const apy = Number(pool.apy_7d ?? 0);
    const leg = (token: StonAsset["asset"] | null, reserve: string, address: string) => {
      const symbol = token?.kind === "Ton" || token?.kind === "Wton" ? "TON" : token?.symbol || "JETTON";
      const price = Number(token?.dex_price_usd ?? token?.third_party_price_usd ?? 0);
      return legOf({
        id: `${pool.address}:${address}`,
        side: "supply",
        symbol,
        amount: units(share(reserve), token?.decimals ?? 9),
        price,
        apy: Number.isFinite(apy) ? apy : 0,
        isCollateral: false,
      });
    };
    const legs = [leg(token0, pool.reserve0, pool.token0_address), leg(token1, pool.reserve1, pool.token1_address)];
    const position = positionOf({
      protocol: PROTOCOL,
      app: "STON.fi",
      category: "liquidity",
      chain: CHAIN,
      wallet,
      key: raw(pool.address),
      label: `STON.fi ${legs[0].symbol}/${legs[1].symbol} · ${CHAIN}`,
      legs,
    });
    if (position) out.push(position);
  }
  return { positions: out, lpMasters: new Set(pool_list.map((pool) => raw(pool.address))) };
}

// ---------- Reader ----------

function spotRows(holdings: Holding[], wallet: string, skip: Set<string>): SpotHolding[] {
  return holdings
    .filter((h) => !(h.master && skip.has(h.master)))
    .filter((h) => h.trusted || (h.price ?? 0) > 0)
    .map((h) =>
      spotRow({ protocol: PROTOCOL, wallet, chain: CHAIN, symbol: h.symbol, amount: h.amount, price: h.price, tokenId: h.master ?? "TON" }),
    )
    .filter((row) => row != null)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, MAX_SPOT);
}

export const readTon: ChainReader = async (address, deps = {}) => {
  const owner = parseTonAddress(address);
  const id = owner.toRawString();
  const wallet = address.trim();
  const notes: string[] = [];
  const tonapi = tonapiFetcher(deps);
  const toncenter = toncenterFetcher(deps);

  const balances = readBalances(id, tonapi, toncenter, deps, notes);
  const [evaa, stonfi, staking] = await Promise.all([
    readApp("EVAA", notes, () => readEvaa(owner, wallet, toncenter, tonapi, deps, notes)),
    readApp("STON.fi", notes, () => readStonfi(owner, wallet, deps)),
    balances.then(
      ({ tonPrice }) => readApp("TON staking", notes, () => readStaking(id, wallet, tonapi, tonPrice)),
      () => null,
    ),
  ]);
  const { holdings } = await balances;

  const read: ChainRead = {
    spot: spotRows(holdings, wallet, stonfi?.lpMasters ?? new Set()),
    positions: [...(evaa ?? []), ...(stonfi?.positions ?? []), ...(staking ?? [])],
    notes,
  };
  return read;
};
