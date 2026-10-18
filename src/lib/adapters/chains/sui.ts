import { blake2b } from "@noble/hashes/blake2.js";
import {
  emptyRead,
  getJson,
  legOf,
  llamaPrices,
  positionOf,
  readApp,
  rpc,
  spotRow,
  units,
  type ChainDeps,
  type ChainReader,
} from "@/lib/adapters/chains/common";
import type { Leg, Position, SpotHolding } from "@/lib/types";

/**
 * Sui reader, all through Sui JSON-RPC (default https://fullnode.mainnet.sui.io, override with
 * env SUI_RPC_URL): wallet coins (suix_getAllBalances + suix_getCoinMetadata), native stakes
 * (suix_getStakes, APY from suix_getValidatorsApy), and lending positions read straight from the
 * protocols' on-chain objects, with layouts taken from their public SDKs:
 * - Suilend main market: the wallet's ObligationOwnerCaps, their Obligations and the market's reserves.
 * - NAVI main market: the reserves table, then the wallet's entries in each reserve's supply and
 *   borrow balance tables (dynamic field ids derived locally, fetched in one batch).
 * - Scallop: the wallet's ObligationKeys, their collateral and debt tables, and the market's
 *   borrow, risk and interest tables. sCoins in the wallet become Scallop supply, mapped to their
 *   underlying with Scallop's public pool list (https://sui.apis.scallop.io/pool/addresses).
 * Prices come from DefiLlama (`sui:<coin type>`), with the protocol's own oracle price as fallback.
 */

const DEFAULT_RPC = "https://fullnode.mainnet.sui.io";
const CHAIN = "Sui";
const SUI = "0x2::sui::SUI";
const MAX_SPOT = 100;
const MAX_METADATA = 80;
const MAX_PRICED = 300;

const SUILEND_PACKAGE = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const SUILEND_MARKET = "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1";
const SUILEND_CAP_TYPE = `${SUILEND_PACKAGE}::lending_market::ObligationOwnerCap<${SUILEND_PACKAGE}::suilend::MAIN_POOL>`;

/** NAVI main market `storage.reserves` table (Table<u8, ReserveData>). */
const NAVI_RESERVES = "0xe6d4c6610b86ce7735ea754596d71d72d10c7980b5052fc3c8cdf8d09fea9b4b";

const SCALLOP_PACKAGE = "0xefe8b36d5b2e43728cc323298626b83177803521d195cfb11e15b910e892fddf";
const SCALLOP_MARKET = "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9";
const SCALLOP_POOLS_API = "https://sui.apis.scallop.io/pool/addresses";

const WAD = 1e18;
const RAY = BigInt(10) ** BigInt(27);
const FIXED32 = 2 ** 32;
const SECONDS_PER_YEAR = 365 * 24 * 3600;

type Call = <T>(method: string, params: unknown[]) => Promise<T>;

interface ObjectResponse {
  data?: { objectId: string; type?: string; content?: { dataType?: string; type?: string; fields?: Record<string, unknown> } };
  error?: unknown;
}

interface Page<T> {
  data: T[];
  nextCursor?: string | null;
  hasNextPage?: boolean;
}

interface CoinBalance {
  coinType: string;
  totalBalance: string;
}

interface DelegatedStake {
  validatorAddress: string;
  stakes: { principal: string; status: string; estimatedReward?: string }[];
}

interface CoinMeta {
  decimals: number;
  symbol: string;
  name?: string;
}

/** One supply or borrow line before prices, in raw base units. */
interface RawLeg {
  coinType: string;
  side: Leg["side"];
  raw: number;
  /** Known from the protocol; otherwise read from coin metadata. */
  decimals?: number;
  apy: number;
  liquidationThreshold?: number;
  /** Multiplier on the borrow's USD value in the health factor (Suilend, Scallop). */
  borrowWeight?: number;
  isCollateral?: boolean;
  fallbackPrice?: number;
}

interface RawPosition {
  app: string;
  key?: string;
  legs: RawLeg[];
}

// ---------------------------------------------------------------------------------------------
// Small JSON and byte helpers
// ---------------------------------------------------------------------------------------------

/** Walks a Move value from JSON-RPC, stepping into `fields` wherever a struct wraps them. */
function dig(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    let obj = current as Record<string, unknown>;
    if (!(key in obj) && obj.fields && typeof obj.fields === "object") obj = obj.fields as Record<string, unknown>;
    current = obj[key];
  }
  return current;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  const name = dig(value, "name");
  return typeof name === "string" ? name : "";
}

function num(value: unknown): number {
  const n = Number(typeof value === "object" && value ? dig(value, "value") : value);
  return Number.isFinite(n) ? n : 0;
}

function big(value: unknown): bigint {
  try {
    return BigInt(String(typeof value === "object" && value ? dig(value, "value") : (value ?? "0")).split(".")[0] || "0");
  } catch {
    return BigInt(0);
  }
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, "").padStart(64, "0"), "hex"));
}

function bcsString(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  const len: number[] = [];
  let n = bytes.length;
  do {
    len.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
    n >>= 7;
  } while (n > 0);
  return [...len, ...bytes];
}

const ADDRESS_TAG = Uint8Array.of(4);
const TYPE_NAME_TAG = Uint8Array.from([7, ...hexBytes("0x1"), ...bcsString("type_name"), ...bcsString("TypeName"), 0]);

/** Object id of a dynamic field: blake2b(0xf0 ‖ parent ‖ len(key) as u64 ‖ key ‖ bcs(key type)). */
export function dynamicFieldId(parent: string, key: Uint8Array, keyTypeTag: Uint8Array): string {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(key.length), true);
  const hash = blake2b.create({ dkLen: 32 });
  hash.update(Uint8Array.of(0xf0));
  hash.update(hexBytes(parent));
  hash.update(length);
  hash.update(key);
  hash.update(keyTypeTag);
  return `0x${Buffer.from(hash.digest()).toString("hex")}`;
}

/** `0x2::sui::SUI` style for system addresses, full 64-hex addresses otherwise, generics included. */
export function normalizeCoinType(type: string): string {
  return type.trim().replace(/(^|[<,\s])(?:0x)?([0-9a-fA-F]{1,64})::/g, (_, lead: string, hex: string) => {
    const short = hex.toLowerCase().replace(/^0+/, "") || "0";
    return `${lead}0x${short.length <= 2 ? short : short.padStart(64, "0")}::`;
  });
}

/** The on-chain TypeName string of a coin type: 64-hex addresses without `0x`. */
function typeNameOf(type: string): string {
  return normalizeCoinType(type).replace(/0x([0-9a-f]{1,64})::/g, (_, hex: string) => `${hex.padStart(64, "0")}::`);
}

function symbolFromType(type: string): string {
  return type.split("<")[0].split("::").pop() || type;
}

export function suiAddress(input: string): string {
  const value = input.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(value)) throw new Error(`Not a Sui address: ${input.slice(0, 80)}`);
  return `0x${value.slice(2).padStart(64, "0")}`;
}

async function pool<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await task(items[index]);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sui JSON-RPC helpers
// ---------------------------------------------------------------------------------------------

/** Object contents by id, in order, with null for ids that do not exist. */
async function multiGet(call: Call, ids: string[]): Promise<(Record<string, unknown> | null)[]> {
  const out: (Record<string, unknown> | null)[] = [];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const pages = await Promise.all(
    chunks.map((chunk) => call<ObjectResponse[]>("sui_multiGetObjects", [chunk, { showContent: true }])),
  );
  for (const page of pages) for (const item of page ?? []) out.push((item?.data?.content as Record<string, unknown>) ?? null);
  return out;
}

async function getObject(call: Call, id: string): Promise<Record<string, unknown>> {
  const response = await call<ObjectResponse>("sui_getObject", [id, { showContent: true }]);
  const content = response?.data?.content;
  if (!content) throw new Error(`object ${id.slice(0, 10)}… not found`);
  return content as Record<string, unknown>;
}

async function ownedObjects(call: Call, owner: string, structType: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const result: Page<ObjectResponse> = await call("suix_getOwnedObjects", [
      owner,
      { filter: { StructType: structType }, options: { showContent: true, showType: true } },
      cursor,
      50,
    ]);
    for (const item of result?.data ?? []) if (item.data?.content) out.push(item.data.content as Record<string, unknown>);
    if (!result?.hasNextPage || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return out;
}

async function dynamicFieldIds(call: Call, parent: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 6; page++) {
    const result: Page<{ objectId: string }> = await call("suix_getDynamicFields", [parent, cursor, 50]);
    for (const item of result?.data ?? []) out.push(item.objectId);
    if (!result?.hasNextPage || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Suilend
// ---------------------------------------------------------------------------------------------

function suilendReserve(reserve: unknown) {
  const element = dig(reserve, "config", "element");
  const config = arr(dig(element, "vec"))[0] ?? element;
  const decimals = num(dig(reserve, "mint_decimals"));
  const available = num(dig(reserve, "available_amount"));
  const borrowed = num(dig(reserve, "borrowed_amount")) / WAD;
  const unclaimed = num(dig(reserve, "unclaimed_spread_fees")) / WAD;
  const ctokens = num(dig(reserve, "ctoken_supply"));
  const utilization = borrowed + available > 0 ? borrowed / (borrowed + available) : 0;
  const utils = arr(dig(config, "interest_rate_utils")).map(Number);
  const aprs = arr(dig(config, "interest_rate_aprs")).map((apr) => Number(apr) / 10_000);
  const borrowApr = interpolate(utils, aprs, utilization * 100);
  return {
    coinType: normalizeCoinType(`0x${text(dig(reserve, "coin_type"))}`),
    decimals,
    ctokenRatio: ctokens > 0 ? (available + borrowed - unclaimed) / ctokens : 1,
    cumulativeBorrowRate: num(dig(reserve, "cumulative_borrow_rate")),
    price: num(dig(reserve, "price")) / WAD,
    closeLtv: num(dig(config, "close_ltv_pct")) / 100,
    borrowWeight: num(dig(config, "borrow_weight_bps")) / 10_000 || 1,
    borrowApr,
    depositApr: utilization * borrowApr * (1 - num(dig(config, "spread_fee_bps")) / 10_000),
  };
}

function interpolate(xs: number[], ys: number[], x: number): number {
  if (!xs.length || xs.length !== ys.length) return 0;
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1] || 1);
  }
  return ys[ys.length - 1];
}

async function readSuilend(call: Call, owner: string): Promise<RawPosition[]> {
  const caps = await ownedObjects(call, owner, SUILEND_CAP_TYPE);
  const ids = caps.map((cap) => text(dig(cap, "obligation_id"))).filter(Boolean);
  if (!ids.length) return [];
  const [obligations, market] = await Promise.all([multiGet(call, ids), getObject(call, SUILEND_MARKET)]);
  const reserves = arr(dig(market, "reserves")).map(suilendReserve);
  const byType = new Map(reserves.map((reserve) => [reserve.coinType, reserve]));
  const reserveOf = (entry: unknown) => {
    const type = normalizeCoinType(`0x${text(dig(entry, "coin_type"))}`);
    const indexed = reserves[num(dig(entry, "reserve_array_index"))];
    return indexed?.coinType === type ? indexed : byType.get(type);
  };

  return obligations.flatMap((obligation, i) => {
    if (!obligation) return [];
    const legs: RawLeg[] = [];
    for (const deposit of arr(dig(obligation, "deposits"))) {
      const reserve = reserveOf(deposit);
      if (!reserve) continue;
      legs.push({
        coinType: reserve.coinType,
        side: "supply",
        raw: num(dig(deposit, "deposited_ctoken_amount")) * reserve.ctokenRatio,
        decimals: reserve.decimals,
        apy: reserve.depositApr,
        liquidationThreshold: reserve.closeLtv,
        fallbackPrice: reserve.price,
      });
    }
    for (const borrow of arr(dig(obligation, "borrows"))) {
      const reserve = reserveOf(borrow);
      if (!reserve) continue;
      const userRate = num(dig(borrow, "cumulative_borrow_rate"));
      const growth = userRate > 0 ? reserve.cumulativeBorrowRate / userRate : 1;
      legs.push({
        coinType: reserve.coinType,
        side: "borrow",
        raw: (num(dig(borrow, "borrowed_amount")) / WAD) * growth,
        decimals: reserve.decimals,
        apy: reserve.borrowApr,
        borrowWeight: reserve.borrowWeight,
        fallbackPrice: reserve.price,
      });
    }
    return [{ app: "Suilend", key: ids[i].slice(0, 10), legs }];
  });
}

// ---------------------------------------------------------------------------------------------
// NAVI
// ---------------------------------------------------------------------------------------------

async function readNavi(call: Call, owner: string): Promise<RawPosition[]> {
  const fieldIds = await dynamicFieldIds(call, NAVI_RESERVES);
  if (!fieldIds.length) throw new Error("no reserves found");
  const reserves = (await multiGet(call, fieldIds))
    .map((field) => dig(field, "value"))
    .filter(Boolean)
    .map((reserve) => ({
      coinType: normalizeCoinType(`0x${text(dig(reserve, "coin_type")).replace(/^0x/, "")}`),
      supplyTable: text(dig(reserve, "supply_balance", "user_state", "id", "id")),
      borrowTable: text(dig(reserve, "borrow_balance", "user_state", "id", "id")),
      supplyIndex: big(dig(reserve, "current_supply_index")),
      borrowIndex: big(dig(reserve, "current_borrow_index")),
      supplyRate: Number(big(dig(reserve, "current_supply_rate"))) / 1e27,
      borrowRate: Number(big(dig(reserve, "current_borrow_rate"))) / 1e27,
      threshold: Number(big(dig(reserve, "liquidation_factors", "threshold"))) / 1e27,
    }))
    .filter((reserve) => reserve.supplyTable && reserve.borrowTable);

  const key = hexBytes(owner);
  const ids = reserves.flatMap((reserve) => [
    dynamicFieldId(reserve.supplyTable, key, ADDRESS_TAG),
    dynamicFieldId(reserve.borrowTable, key, ADDRESS_TAG),
  ]);
  const balances = await multiGet(call, ids);
  const legs: RawLeg[] = [];
  reserves.forEach((reserve, i) => {
    // Balances are scaled by the reserve index (ray) and kept in 9 decimals for every coin.
    const supply = (big(dig(balances[2 * i], "value")) * reserve.supplyIndex) / RAY;
    const borrow = (big(dig(balances[2 * i + 1], "value")) * reserve.borrowIndex) / RAY;
    if (supply > BigInt(0)) {
      legs.push({
        coinType: reserve.coinType,
        side: "supply",
        raw: Number(supply),
        decimals: 9,
        apy: reserve.supplyRate,
        liquidationThreshold: reserve.threshold || undefined,
      });
    }
    if (borrow > BigInt(0)) {
      legs.push({ coinType: reserve.coinType, side: "borrow", raw: Number(borrow), decimals: 9, apy: reserve.borrowRate });
    }
  });
  return legs.length ? [{ app: "NAVI", legs }] : [];
}

// ---------------------------------------------------------------------------------------------
// Scallop
// ---------------------------------------------------------------------------------------------

interface ScallopPool {
  coinType: string;
  sCoinType?: string;
  decimals?: number;
}

async function readScallop(
  call: Call,
  owner: string,
  balancesPromise: Promise<CoinBalance[]>,
  deps: ChainDeps,
): Promise<{ positions: RawPosition[]; sCoins: Set<string> }> {
  const [keys, market, balances, pools] = await Promise.all([
    ownedObjects(call, owner, `${SCALLOP_PACKAGE}::obligation::ObligationKey`),
    getObject(call, SCALLOP_MARKET),
    balancesPromise,
    getJson<Record<string, ScallopPool>>(SCALLOP_POOLS_API, { timeoutMs: 8_000 }, deps).catch(() => null),
  ]);

  const sCoinPool = new Map<string, ScallopPool>();
  for (const pool of Object.values(pools ?? {})) {
    if (pool?.sCoinType && pool.coinType) sCoinPool.set(normalizeCoinType(pool.sCoinType), pool);
  }
  const heldSCoins = balances
    .map((balance) => ({ balance, pool: sCoinPool.get(normalizeCoinType(balance.coinType)) }))
    .filter((item): item is { balance: CoinBalance; pool: ScallopPool } => !!item.pool && big(item.balance.totalBalance) > BigInt(0));

  const obligationIds = keys.map((key) => text(dig(key, "ownership", "of"))).filter(Boolean);
  if (!obligationIds.length && !heldSCoins.length) return { positions: [], sCoins: new Set() };

  const obligations = await multiGet(call, obligationIds);
  const tables = obligations.map((obligation) => ({
    collaterals: text(dig(obligation, "collaterals", "table", "id", "id")),
    debts: text(dig(obligation, "debts", "table", "id", "id")),
  }));
  const entryIds = await Promise.all(
    tables.map(async (table) => ({
      collaterals: table.collaterals ? await dynamicFieldIds(call, table.collaterals) : [],
      debts: table.debts ? await dynamicFieldIds(call, table.debts) : [],
    })),
  );
  const flatIds = entryIds.flatMap((entry) => [...entry.collaterals, ...entry.debts]);
  const entries = new Map<string, unknown>();
  (await multiGet(call, flatIds)).forEach((entry, i) => entries.set(flatIds[i], entry));

  const coinTypes = new Set<string>();
  for (const entry of entries.values()) coinTypes.add(typeNameOf(`0x${text(dig(entry, "name"))}`));
  for (const { pool } of heldSCoins) coinTypes.add(typeNameOf(pool.coinType));

  const marketTable = (...path: string[]) => text(dig(market, ...path, "table", "id", "id"));
  const tableIds = {
    borrow: marketTable("borrow_dynamics"),
    risk: marketTable("risk_models"),
    interest: marketTable("interest_models"),
    balance: marketTable("vault", "balance_sheets"),
  };
  const names = [...coinTypes];
  const wanted = names.flatMap((name) => {
    const key = Uint8Array.from(bcsString(name));
    return Object.values(tableIds).map((table) => dynamicFieldId(table, key, TYPE_NAME_TAG));
  });
  const marketFields = await multiGet(call, wanted);
  const now = Date.now() / 1000;
  const marketOf = new Map(
    names.map((name, i) => {
      const [borrow, risk, interest, balance] = marketFields.slice(i * 4, i * 4 + 4).map((field) => dig(field, "value"));
      const rate = num(dig(borrow, "interest_rate")) / FIXED32;
      const scale = num(dig(borrow, "interest_rate_scale")) || 1;
      const index = num(dig(borrow, "borrow_index"));
      const elapsed = Math.max(0, now - num(dig(borrow, "last_updated")));
      const borrowApr = (rate * SECONDS_PER_YEAR) / scale;
      const cash = num(dig(balance, "cash"));
      const debt = num(dig(balance, "debt"));
      const supplied = cash + debt - num(dig(balance, "revenue"));
      const utilization = supplied > 0 ? debt / supplied : 0;
      const sCoinSupply = num(dig(balance, "market_coin_supply"));
      return [
        name,
        {
          coinType: normalizeCoinType(`0x${name}`),
          borrowIndex: index * (1 + (elapsed * rate) / scale),
          borrowApr,
          supplyApr: borrowApr * utilization * (1 - num(dig(interest, "revenue_factor")) / FIXED32),
          borrowWeight: num(dig(interest, "borrow_weight")) / FIXED32 || 1,
          liquidationFactor: num(dig(risk, "liquidation_factor")) / FIXED32,
          conversionRate: sCoinSupply > 0 && supplied > 0 ? supplied / sCoinSupply : 1,
        },
      ] as const;
    }),
  );

  const positions: RawPosition[] = obligations.flatMap((obligation, i) => {
    if (!obligation) return [];
    const legs: RawLeg[] = [];
    for (const id of entryIds[i].collaterals) {
      const entry = entries.get(id);
      const info = marketOf.get(typeNameOf(`0x${text(dig(entry, "name"))}`));
      if (!info) continue;
      legs.push({
        coinType: info.coinType,
        side: "supply",
        raw: num(dig(entry, "value", "amount")),
        apy: 0,
        liquidationThreshold: info.liquidationFactor || undefined,
      });
    }
    for (const id of entryIds[i].debts) {
      const entry = entries.get(id);
      const info = marketOf.get(typeNameOf(`0x${text(dig(entry, "name"))}`));
      if (!info) continue;
      const userIndex = num(dig(entry, "value", "borrow_index"));
      legs.push({
        coinType: info.coinType,
        side: "borrow",
        raw: num(dig(entry, "value", "amount")) * (userIndex > 0 ? info.borrowIndex / userIndex : 1),
        apy: info.borrowApr,
        borrowWeight: info.borrowWeight,
      });
    }
    return [{ app: "Scallop", key: obligationIds[i].slice(0, 10), legs }];
  });

  const supplyLegs: RawLeg[] = [];
  const sCoins = new Set<string>();
  for (const { balance, pool } of heldSCoins) {
    const info = marketOf.get(typeNameOf(pool.coinType));
    if (!info) continue;
    sCoins.add(normalizeCoinType(balance.coinType));
    supplyLegs.push({
      coinType: info.coinType,
      side: "supply",
      raw: num(balance.totalBalance) * info.conversionRate,
      decimals: typeof pool.decimals === "number" ? pool.decimals : undefined,
      apy: info.supplyApr,
      isCollateral: false,
    });
  }
  if (supplyLegs.length) positions.push({ app: "Scallop", key: "supply", legs: supplyLegs });
  return { positions, sCoins };
}

// ---------------------------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------------------------

const SPAM = /https?:|www\.|\.(com|io|xyz|net|org|app|fi|site|top)\b|claim|airdrop|reward|visit|voucher|gift/i;

async function coinMetadata(call: Call, types: string[], cache: Map<string, CoinMeta | null>): Promise<void> {
  const missing = types.filter((type) => !cache.has(type));
  await pool(missing, 8, async (type) => {
    if (type === SUI) return cache.set(type, { decimals: 9, symbol: "SUI", name: "Sui" });
    try {
      const meta = await call<{ decimals?: number; symbol?: string; name?: string } | null>("suix_getCoinMetadata", [type]);
      cache.set(type, meta && typeof meta.decimals === "number" ? { decimals: meta.decimals, symbol: meta.symbol || symbolFromType(type), name: meta.name } : null);
    } catch {
      // Unknown this time; try again on the next read.
    }
  });
}

const META_CACHE = new Map<string, CoinMeta | null>();

export const readSui: ChainReader = async (address, deps = {}) => {
  const owner = suiAddress(address);
  const url = process.env.SUI_RPC_URL?.trim() || DEFAULT_RPC;
  const call: Call = (method, params) => rpc(url, method, params, deps);
  const read = emptyRead();

  const balancesPromise = call<CoinBalance[]>("suix_getAllBalances", [owner]);
  const [balancesRaw, stakes, suilend, navi, scallop] = await Promise.all([
    balancesPromise,
    readApp("Sui staking", read.notes, async () => {
      const [list, apys] = await Promise.all([
        call<DelegatedStake[]>("suix_getStakes", [owner]),
        call<{ apys?: { address: string; apy: number }[] }>("suix_getValidatorsApy", []).catch(() => null),
      ]);
      return { list: list ?? [], apys: new Map((apys?.apys ?? []).map((item) => [item.address, item.apy])) };
    }),
    readApp("Suilend", read.notes, () => readSuilend(call, owner)),
    readApp("NAVI", read.notes, () => readNavi(call, owner)),
    readApp("Scallop", read.notes, () => readScallop(call, owner, balancesPromise, deps)),
  ]);

  const balances = (balancesRaw ?? [])
    .map((balance) => ({ coinType: normalizeCoinType(balance.coinType), raw: big(balance.totalBalance) }))
    .filter((balance) => balance.raw > BigInt(0) && !scallop?.sCoins.has(balance.coinType));
  const raw: RawPosition[] = [...(suilend ?? []), ...(navi ?? []), ...(scallop?.positions ?? [])];

  const appTypes = new Set(raw.flatMap((position) => position.legs.map((leg) => leg.coinType)));
  const prices = await llamaPrices(
    [SUI, ...balances.slice(0, MAX_PRICED).map((balance) => balance.coinType), ...appTypes].map((type) => `sui:${type}`),
    deps,
  );
  const priceOf = (type: string) => prices[`sui:${type}`];

  // Metadata for every app coin and priced wallet coin, then the rest of the wallet up to a cap.
  const priced = balances.filter((balance) => priceOf(balance.coinType)).map((balance) => balance.coinType);
  const unpriced = balances.filter((balance) => !priceOf(balance.coinType)).map((balance) => balance.coinType);
  const first = [...new Set([SUI, ...appTypes, ...priced])];
  await coinMetadata(call, [...first, ...unpriced.slice(0, Math.max(0, MAX_METADATA - first.length))], META_CACHE);
  const meta = (type: string) => META_CACHE.get(type) ?? null;
  const symbolOf = (type: string) => meta(type)?.symbol || symbolFromType(type);

  const spot: SpotHolding[] = [];
  for (const balance of balances) {
    const info = meta(balance.coinType);
    const price = priceOf(balance.coinType);
    if (!info) continue;
    if (!price && (SPAM.test(info.symbol) || SPAM.test(info.name ?? ""))) continue;
    const row = spotRow({
      protocol: "sui",
      wallet: owner,
      chain: CHAIN,
      symbol: info.symbol,
      amount: units(balance.raw, info.decimals),
      price,
      tokenId: balance.coinType,
    });
    if (row) spot.push(row);
  }
  spot.sort((a, b) => b.usd - a.usd || Number(!!a.unpriced) - Number(!!b.unpriced));
  read.spot = spot.slice(0, MAX_SPOT);

  if (stakes) {
    let principal = BigInt(0);
    let reward = BigInt(0);
    let weightedApy = 0;
    for (const validator of stakes.list) {
      for (const stake of validator.stakes ?? []) {
        if (stake.status === "Unstaked") continue;
        const amount = big(stake.principal);
        principal += amount;
        reward += big(stake.estimatedReward);
        weightedApy += Number(amount) * (stakes.apys.get(validator.validatorAddress) ?? 0);
      }
    }
    const suiPrice = priceOf(SUI);
    const position = positionOf({
      protocol: "sui",
      app: "Sui",
      category: "staking",
      chain: CHAIN,
      wallet: owner,
      legs: [
        legOf({ id: "staked", side: "supply", symbol: "SUI", amount: units(principal, 9), price: suiPrice, apy: principal > BigInt(0) ? weightedApy / Number(principal) : 0, isCollateral: false }),
        legOf({ id: "rewards", side: "supply", symbol: "SUI", amount: units(reward, 9), price: suiPrice, isCollateral: false }),
      ],
      note: "Native SUI stake; rewards are the node's estimate.",
    });
    if (position) read.positions.push(position);
  }

  for (const rawPosition of raw) {
    const built = await readApp(rawPosition.app, read.notes, async () => buildLending(rawPosition, owner, priceOf, meta, symbolOf));
    if (built) read.positions.push(built);
  }
  return read;
};

function buildLending(
  raw: RawPosition,
  wallet: string,
  priceOf: (type: string) => number | undefined,
  meta: (type: string) => CoinMeta | null,
  symbolOf: (type: string) => string,
): Position | null {
  let collateralPower = 0;
  let weightedDebt = 0;
  let healthKnown = true;
  const legs: Leg[] = [];
  for (const leg of raw.legs) {
    const decimals = leg.decimals ?? meta(leg.coinType)?.decimals;
    if (decimals == null) throw new Error(`no decimals for ${symbolFromType(leg.coinType)}`);
    const amount = leg.raw / 10 ** decimals;
    const price = priceOf(leg.coinType) ?? (leg.fallbackPrice || undefined);
    const built = legOf({
      id: `${leg.side}:${leg.coinType}`,
      side: leg.side,
      symbol: symbolOf(leg.coinType),
      amount,
      price,
      apy: leg.apy,
      liquidationThreshold: leg.side === "supply" && leg.isCollateral !== false ? leg.liquidationThreshold : undefined,
      isCollateral: leg.side === "supply" ? leg.isCollateral ?? true : false,
    });
    if (built.amount <= 0) continue;
    legs.push(built);
    if (leg.side === "borrow") {
      if (!price) healthKnown = false;
      weightedDebt += built.usd * (leg.borrowWeight ?? 1);
    } else if (built.isCollateral) {
      collateralPower += built.usd * (leg.liquidationThreshold ?? 0);
    }
  }
  return positionOf({
    protocol: "sui",
    app: raw.app,
    category: "lending",
    chain: CHAIN,
    wallet,
    legs,
    key: raw.key,
    healthFactor: healthKnown && weightedDebt > 0 ? collateralPower / weightedDebt : null,
  });
}
