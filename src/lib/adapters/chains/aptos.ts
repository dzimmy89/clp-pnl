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
 * Aptos reader.
 * - Balances: coins and fungible assets from the Aptos Labs indexer (`current_fungible_asset_balances`),
 *   falling back to the fullnode's APT balance when the indexer is down.
 * - Staking: delegation pool stakes (indexer `current_delegator_balances`, amounts from
 *   `0x1::delegation_pool::get_stake`).
 * - Aries Markets: lending profiles from the Aries API (api-v2.ariesmarkets.xyz, tRPC `profile.find`),
 *   rates from `reserve.current`.
 * - Echelon: the on-chain `lending::Vault` resource, amounts, rates and health from Echelon's view functions.
 * Prices from DefiLlama (`aptos:<asset type>`, CoinGecko ids for the majors).
 * Env: APTOS_API_KEY (optional) is sent as a Bearer token to the Aptos Labs node and indexer.
 */

const CHAIN = "Aptos";
const NODE = "https://api.mainnet.aptoslabs.com/v1";
const INDEXER = "https://api.mainnet.aptoslabs.com/v1/graphql";
const ARIES_API = "https://api-v2.ariesmarkets.xyz";
const ECHELON = "0xc6bc659f1649553c1a3fa05d9727433dc03843baac29473c817d06d39e7621ba";
const APT = "0x1::aptos_coin::AptosCoin";
const APT_FA = "0x000000000000000000000000000000000000000000000000000000000000000a";
const MAX_SPOT = 100;
const TIMEOUT_MS = 8_000;

interface TokenInfo {
  symbol: string;
  decimals: number;
  /** CoinGecko id used when DefiLlama has no `aptos:` price. */
  cg?: string;
}

const LZ = "0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::";
const AMNIS = "0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a";
const THALA = "0xfaf4e633ae9eb31366c9ca24214231760926576c7b625313b3688b5e900731f6";

/** Majors, with the symbols the rest of the app understands (bridged USDC is still USDC). */
const KNOWN: Record<string, TokenInfo> = {
  [APT]: { symbol: "APT", decimals: 8, cg: "aptos" },
  "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b": { symbol: "USDC", decimals: 6, cg: "usd-coin" },
  "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b": { symbol: "USDT", decimals: 6, cg: "tether" },
  [`${LZ}USDC`]: { symbol: "USDC", decimals: 6, cg: "usd-coin" },
  [`${LZ}USDT`]: { symbol: "USDT", decimals: 6, cg: "tether" },
  [`${LZ}WETH`]: { symbol: "WETH", decimals: 6, cg: "ethereum" },
  "0x5e156f1207d0ebfa19a9eeff00d62a282278fb8719f4fab3a586a0a2c0fffbea::coin::T": { symbol: "USDC", decimals: 6, cg: "usd-coin" },
  [`${AMNIS}::amapt_token::AmnisApt`]: { symbol: "amAPT", decimals: 8, cg: "aptos" },
  [`${AMNIS}::stapt_token::StakedApt`]: { symbol: "stAPT", decimals: 8, cg: "amnis-staked-aptos-coin" },
  [`${THALA}::staking::ThalaAPT`]: { symbol: "thAPT", decimals: 8 },
  [`${THALA}::staking::StakedThalaAPT`]: { symbol: "sthAPT", decimals: 8 },
  "0x159df6b7689437016108a019fd5bef736bac692b6d4a1f10c941f6fbb9a74ca6::oft::CakeOFT": { symbol: "CAKE", decimals: 8, cg: "pancakeswap-token" },
};

/** Aptos addresses as 0x + 64 lowercase hex. */
export function aptosAddress(input: string): string {
  const value = input.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(value)) throw new Error("That does not look like an Aptos address.");
  return `0x${value.slice(2).padStart(64, "0")}`;
}

/** APT has a coin type and a paired fungible asset (0xa); treat both as the coin type. */
function assetKey(type: string): string {
  const value = type.trim();
  return value === "0xa" || value === APT_FA ? APT : value;
}

function authHeaders(): Record<string, string> {
  const key = process.env.APTOS_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}

async function gql<T>(query: string, variables: Record<string, unknown>, deps: ChainDeps): Promise<T> {
  const body = await getJson<{ data?: T; errors?: { message?: string }[] }>(
    INDEXER,
    { method: "POST", body: JSON.stringify({ query, variables }), headers: authHeaders(), timeoutMs: TIMEOUT_MS },
    deps,
  );
  if (body.errors?.length) throw new Error(body.errors[0].message ?? "indexer query failed");
  if (!body.data) throw new Error("indexer returned no data");
  return body.data;
}

async function view<T extends unknown[]>(fn: string, args: unknown[], deps: ChainDeps): Promise<T> {
  return getJson<T>(
    `${NODE}/view`,
    {
      method: "POST",
      body: JSON.stringify({ function: fn, type_arguments: [], arguments: args }),
      headers: authHeaders(),
      timeoutMs: TIMEOUT_MS,
    },
    deps,
  );
}

/** One resource, or null when the account doesn't hold it. */
async function resource<T>(owner: string, type: string, deps: ChainDeps): Promise<T | null> {
  try {
    const body = await getJson<{ data?: T }>(`${NODE}/accounts/${owner}/resource/${type}`, { headers: authHeaders(), timeoutMs: TIMEOUT_MS }, deps);
    return body.data ?? null;
  } catch (error) {
    if (error instanceof Error && /returned 404/.test(error.message)) return null;
    throw error;
  }
}

/** Raw integer amounts from the node or indexer (strings, or numbers from Hasura). */
function amountOf(raw: unknown, decimals: number): number {
  if (typeof raw === "number") return raw / 10 ** decimals;
  const text = String(raw ?? "0");
  if (/^\d+$/.test(text)) return units(text, decimals);
  const value = Number(text);
  return Number.isFinite(value) ? value / 10 ** decimals : 0;
}

/** FixedPoint64 (`{ v: "…" }`) as a float. */
function fp64(raw: unknown): number {
  const v = (raw as { v?: string } | null)?.v ?? raw;
  try {
    return units(BigInt(String(v)), 0) / 2 ** 64;
  } catch {
    return 0;
  }
}

const metaCache = new Map<string, TokenInfo>();

/** Symbol and decimals for asset types: known majors first, then the indexer. */
async function tokenInfo(types: string[], deps: ChainDeps): Promise<Record<string, TokenInfo>> {
  const out: Record<string, TokenInfo> = {};
  const missing: string[] = [];
  for (const type of new Set(types.map(assetKey))) {
    const known = KNOWN[type] ?? metaCache.get(type);
    if (known) out[type] = known;
    else missing.push(type);
  }
  if (missing.length) {
    try {
      const data = await gql<{ fungible_asset_metadata?: { asset_type: string; symbol?: string; decimals?: number }[] }>(
        "query Meta($types: [String!]) { fungible_asset_metadata(where: {asset_type: {_in: $types}}) { asset_type symbol decimals } }",
        { types: missing },
        deps,
      );
      for (const row of data.fungible_asset_metadata ?? []) {
        if (!row.symbol || row.decimals == null) continue;
        const info = { symbol: row.symbol, decimals: row.decimals };
        metaCache.set(row.asset_type, info);
        out[row.asset_type] = info;
      }
    } catch {
      // Callers fall back to their own names and decimals.
    }
  }
  return out;
}

function fallbackSymbol(type: string): string {
  const parts = type.split("::");
  return parts.length > 1 ? parts[parts.length - 1] : `${type.slice(0, 6)}…${type.slice(-4)}`;
}

function priceKeys(type: string): string[] {
  const known = KNOWN[type];
  return [`aptos:${type}`, ...(known?.cg ? [`coingecko:${known.cg}`] : [])];
}

function priceOf(prices: Record<string, number>, type: string): number | undefined {
  const known = KNOWN[type];
  return prices[`aptos:${type}`] ?? (known?.cg ? prices[`coingecko:${known.cg}`] : undefined);
}

// ---------- Balances ----------

interface Balance {
  type: string;
  symbol: string;
  decimals: number;
  amount: number;
}

interface BalanceRow {
  asset_type: string;
  amount: number | string;
  metadata?: { symbol?: string; decimals?: number } | null;
}

async function readBalances(owner: string, deps: ChainDeps, notes: string[]): Promise<Balance[]> {
  let rows: BalanceRow[];
  try {
    const data = await gql<{ current_fungible_asset_balances?: BalanceRow[] }>(
      "query Balances($owner: String!) { current_fungible_asset_balances(where: {owner_address: {_eq: $owner}, amount: {_gt: 0}}, limit: 300) { asset_type amount metadata { symbol decimals } } }",
      { owner },
      deps,
    );
    rows = data.current_fungible_asset_balances ?? [];
  } catch (error) {
    // The indexer is down: show APT from the fullnode and say so.
    const raw = await getJson<number | string>(`${NODE}/accounts/${owner}/balance/${APT}`, { headers: authHeaders(), timeoutMs: TIMEOUT_MS }, deps).catch(
      () => {
        throw error;
      },
    );
    notes.push("Aptos indexer unavailable: showing APT only");
    rows = [{ asset_type: APT, amount: raw, metadata: { symbol: "APT", decimals: 8 } }];
  }
  const byType = new Map<string, Balance>();
  for (const row of rows) {
    const type = assetKey(row.asset_type);
    const known = KNOWN[type];
    const decimals = known?.decimals ?? row.metadata?.decimals;
    if (decimals == null) continue;
    const amount = amountOf(row.amount, decimals);
    const symbol = known?.symbol ?? row.metadata?.symbol ?? fallbackSymbol(type);
    // A coin and its paired fungible asset can both show up; they are the same balance.
    const prev = byType.get(type);
    if (!prev || amount > prev.amount) byType.set(type, { type, symbol, decimals, amount });
  }
  return [...byType.values()].filter((row) => row.amount > 0);
}

// ---------- Delegated staking ----------

interface Stake {
  pool: string;
  active: number;
  inactive: number;
  pendingInactive: number;
}

async function readStakes(owner: string, deps: ChainDeps): Promise<Stake[]> {
  const data = await gql<{ current_delegator_balances?: { pool_address: string; shares: number | string }[] }>(
    "query Delegations($owner: String!) { current_delegator_balances(where: {delegator_address: {_eq: $owner}, shares: {_gt: 0}}) { pool_address shares } }",
    { owner },
    deps,
  );
  const pools = [...new Set((data.current_delegator_balances ?? []).map((row) => row.pool_address))];
  return Promise.all(
    pools.map(async (pool) => {
      const [active, inactive, pending] = await view<[string, string, string]>(
        "0x1::delegation_pool::get_stake",
        [pool, owner],
        deps,
      );
      return { pool, active: amountOf(active, 8), inactive: amountOf(inactive, 8), pendingInactive: amountOf(pending, 8) };
    }),
  );
}

// ---------- Aries Markets ----------

interface AriesProfile {
  profileName?: string;
  deposits?: Record<string, { collateral_coins?: number; collateral_value?: number }>;
  borrows?: Record<string, { borrowed_coins?: number; borrowed_value?: number }>;
  riskFactor?: number;
  loanValue?: number;
}

interface AriesReserve {
  total_borrowed?: number;
  total_cash_available?: number;
  reserve_amount?: number;
  reserve_config?: { reserve_ratio?: number; liquidation_threshold?: number };
  interest_rate_config?: {
    min_borrow_rate?: number;
    optimal_borrow_rate?: number;
    max_borrow_rate?: number;
    optimal_utilization?: number;
  };
}

interface AriesRead {
  profiles: Record<string, AriesProfile>;
  reserves: Map<string, AriesReserve>;
}

async function readAries(owner: string, deps: ChainDeps): Promise<AriesRead> {
  const input = encodeURIComponent(JSON.stringify({ owner }));
  const [profile, reserves] = await Promise.all([
    getJson<{ result?: { data?: { profiles?: Record<string, AriesProfile> } } }>(
      `${ARIES_API}/profile.find?input=${input}`,
      { timeoutMs: TIMEOUT_MS },
      deps,
    ),
    getJson<{ result?: { data?: { stats?: { key: string; value: AriesReserve }[] } } }>(
      `${ARIES_API}/reserve.current`,
      { timeoutMs: TIMEOUT_MS },
      deps,
    ).catch(() => null),
  ]);
  return {
    profiles: profile.result?.data?.profiles ?? {},
    reserves: new Map((reserves?.result?.data?.stats ?? []).map((row) => [row.key, row.value])),
  };
}

/** Aries rates (the same model the Aries app and DefiLlama use). Rates come back as decimals. */
function ariesRates(reserve: AriesReserve | undefined): { supply: number; borrow: number; threshold?: number } {
  if (!reserve) return { supply: 0, borrow: 0 };
  const rate = reserve.interest_rate_config ?? {};
  const borrowed = Number(reserve.total_borrowed ?? 0);
  const total = borrowed + Number(reserve.total_cash_available ?? 0) + Number(reserve.reserve_amount ?? 0);
  const optimal = Number(rate.optimal_utilization ?? 0);
  const lt = Number(reserve.reserve_config?.liquidation_threshold ?? 0);
  const threshold = lt > 0 ? (lt > 1 ? lt / 100 : lt) : undefined;
  if (total <= 0 || optimal <= 0) return { supply: 0, borrow: 0, threshold };
  const util = (borrowed / total) * 100;
  const min = Number(rate.min_borrow_rate ?? 0);
  const mid = Number(rate.optimal_borrow_rate ?? 0);
  const max = Number(rate.max_borrow_rate ?? 0);
  const borrowPct = util <= optimal ? min + (util / optimal) * (mid - min) : mid + ((util - optimal) / optimal) * (max - mid);
  const supplyPct = (borrowPct * util * (100 - Number(reserve.reserve_config?.reserve_ratio ?? 0))) / 10_000;
  return { supply: supplyPct / 100, borrow: borrowPct / 100, threshold };
}

/**
 * Aries reports coin amounts in base units next to a USD value. Pick the scale that agrees with the
 * value, so a whole-unit amount from the API still reads right.
 */
function ariesAmount(coins: number, value: number, decimals: number, price: number | undefined): number {
  const scaled = coins / 10 ** decimals;
  if (!price || !(value > 0)) return scaled;
  return Math.abs(scaled * price - value) <= Math.abs(coins * price - value) ? scaled : coins;
}

// ---------- Echelon ----------

interface EchelonVault {
  collaterals?: { data?: { key: { inner: string }; value: string }[] };
  liabilities?: { data?: { key: { inner: string }; value: unknown }[] };
}

interface EchelonMarket {
  market: string;
  type: string;
  name?: string;
  decimals?: number;
  supplied: string;
  borrowed: string;
  supplyApr: number;
  borrowApr: number;
  threshold?: number;
}

interface EchelonRead {
  markets: EchelonMarket[];
  health: number | null;
}

async function readEchelon(owner: string, deps: ChainDeps): Promise<EchelonRead | null> {
  const vault = await resource<EchelonVault>(owner, `${ECHELON}::lending::Vault`, deps);
  if (!vault) return null;
  const collateral = new Set((vault.collaterals?.data ?? []).map((row) => row.key.inner));
  const debt = new Set((vault.liabilities?.data ?? []).map((row) => row.key.inner));
  const markets = [...new Set([...collateral, ...debt])];
  if (!markets.length) return null;
  const fn = (name: string) => `${ECHELON}::lending::${name}`;
  const [rows, health] = await Promise.all([
    Promise.all(
      markets.map(async (market): Promise<EchelonMarket> => {
        const [resources, supplied, borrowed, supplyApr, borrowApr] = await Promise.all([
          getJson<{ type: string; data: Record<string, unknown> }[]>(`${NODE}/accounts/${market}/resources`, { headers: authHeaders(), timeoutMs: TIMEOUT_MS }, deps),
          collateral.has(market) ? view<[string]>(fn("account_coins"), [owner, market], deps) : (["0"] as [string]),
          debt.has(market) ? view<[string]>(fn("account_liability"), [owner, market], deps) : (["0"] as [string]),
          view<[unknown]>(fn("supply_interest_rate"), [market], deps).catch(() => [null]),
          view<[unknown]>(fn("borrow_interest_rate"), [market], deps).catch(() => [null]),
        ]);
        const find = (suffix: string) => resources.find((row) => row.type.endsWith(`::lending::${suffix}`))?.data;
        const info = find("Market") as { asset_name?: string; asset_mantissa?: string } | undefined;
        const coin = find("CoinInfo") as { type_name?: string } | undefined;
        const fa = find("FungibleAssetInfo") as { metadata?: { inner?: string } } | undefined;
        const lt = find("MarketLiquidationThreshold") as { value_bps?: string } | undefined;
        const type = coin?.type_name ?? fa?.metadata?.inner;
        if (!type) throw new Error(`unknown asset for market ${market.slice(0, 10)}…`);
        const mantissa = Number(info?.asset_mantissa ?? 0);
        const decimals = mantissa > 0 ? Math.round(Math.log10(mantissa)) : undefined;
        return {
          market,
          type: assetKey(type),
          name: info?.asset_name,
          decimals,
          supplied: String(supplied[0] ?? "0"),
          borrowed: String(borrowed[0] ?? "0"),
          supplyApr: supplyApr[0] == null ? 0 : fp64(supplyApr[0]),
          borrowApr: borrowApr[0] == null ? 0 : fp64(borrowApr[0]),
          threshold: lt?.value_bps ? Number(lt.value_bps) / 10_000 : undefined,
        };
      }),
    ),
    debt.size
      ? Promise.all([
          view<[unknown]>(fn("account_liquidation_threshold"), [owner], deps),
          view<[unknown]>(fn("account_liability_value"), [owner], deps),
        ])
          .then(([threshold, liability]) => {
            const owed = fp64(liability[0]);
            return owed > 0 ? fp64(threshold[0]) / owed : null;
          })
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return { markets: rows, health };
}

// ---------- Reader ----------

export const readAptos: ChainReader = async (address, deps = {}) => {
  const owner = aptosAddress(address);
  const notes: string[] = [];
  const [balances, stakes, aries, echelon] = await Promise.all([
    readBalances(owner, deps, notes),
    readApp("Aptos staking", notes, () => readStakes(owner, deps)),
    readApp("Aries Markets", notes, () => readAries(owner, deps)),
    readApp("Echelon", notes, () => readEchelon(owner, deps)),
  ]);

  const appTypes = [
    ...Object.values(aries?.profiles ?? {}).flatMap((p) => [...Object.keys(p.deposits ?? {}), ...Object.keys(p.borrows ?? {})]),
    ...(echelon?.markets ?? []).map((m) => m.type),
  ].map(assetKey);
  const [info, prices] = await Promise.all([
    tokenInfo(appTypes, deps),
    llamaPrices([APT, ...balances.map((b) => b.type), ...appTypes].flatMap(priceKeys), deps),
  ]);
  const aptPrice = priceOf(prices, APT);

  const spot = balances
    .map((b) => spotRow({ protocol: "aptos", wallet: owner, chain: CHAIN, symbol: b.symbol, amount: b.amount, price: priceOf(prices, b.type), tokenId: b.type }))
    .filter((row): row is SpotHolding => row !== null)
    .sort((a, b) => b.usd - a.usd || Number(a.unpriced) - Number(b.unpriced))
    .slice(0, MAX_SPOT);

  const positions: Position[] = [];
  const push = (position: Position | null) => {
    if (position) positions.push(position);
  };

  for (const stake of stakes ?? []) {
    const total = stake.active + stake.inactive + stake.pendingInactive;
    const unlocking = stake.inactive + stake.pendingInactive;
    push(
      positionOf({
        protocol: "aptos",
        app: "Aptos Staking",
        category: "staking",
        chain: CHAIN,
        wallet: owner,
        key: stake.pool,
        label: `Delegated APT · ${stake.pool.slice(0, 6)}…${stake.pool.slice(-4)}`,
        legs: [{ ...legOf({ id: `aptos-stake:${stake.pool}`, side: "supply", symbol: "APT", amount: total, price: aptPrice, isCollateral: false }), apyUnknown: true }],
        note: unlocking > 0 ? `${unlocking.toFixed(4)} APT unstaking or withdrawable` : undefined,
      }),
    );
  }

  for (const [name, profile] of Object.entries(aries?.profiles ?? {})) {
    const legs: Leg[] = [];
    const meta = (type: string) => info[assetKey(type)] ?? { symbol: fallbackSymbol(type), decimals: 8 };
    for (const [type, deposit] of Object.entries(profile.deposits ?? {})) {
      const { symbol, decimals } = meta(type);
      const price = priceOf(prices, assetKey(type));
      const value = Number(deposit.collateral_value ?? 0);
      const amount = ariesAmount(Number(deposit.collateral_coins ?? 0), value, decimals, price);
      const rates = ariesRates(aries?.reserves.get(type));
      legs.push(
        legOf({
          id: `aries:${name}:supply:${type}`,
          side: "supply",
          symbol,
          amount,
          price: price ?? (amount > 0 && value > 0 ? value / amount : undefined),
          apy: rates.supply,
          liquidationThreshold: rates.threshold,
        }),
      );
    }
    for (const [type, loan] of Object.entries(profile.borrows ?? {})) {
      const { symbol, decimals } = meta(type);
      const price = priceOf(prices, assetKey(type));
      const value = Number(loan.borrowed_value ?? 0);
      const amount = ariesAmount(Number(loan.borrowed_coins ?? 0), value, decimals, price);
      legs.push(
        legOf({
          id: `aries:${name}:borrow:${type}`,
          side: "borrow",
          symbol,
          amount,
          price: price ?? (amount > 0 && value > 0 ? value / amount : undefined),
          apy: ariesRates(aries?.reserves.get(type)).borrow,
        }),
      );
    }
    const risk = Number(profile.riskFactor ?? 0);
    const label = profile.profileName ?? name;
    push(
      positionOf({
        protocol: "aptos",
        app: "Aries Markets",
        category: "lending",
        chain: CHAIN,
        wallet: owner,
        key: name,
        label: `Aries Markets · ${label}`,
        legs,
        healthFactor: Number(profile.loanValue ?? 0) > 0 && risk > 0 ? 1 / risk : null,
      }),
    );
  }

  if (echelon) {
    const legs: Leg[] = [];
    for (const market of echelon.markets) {
      const known = info[market.type];
      const symbol = known?.symbol ?? market.name ?? fallbackSymbol(market.type);
      const decimals = known?.decimals ?? market.decimals ?? 8;
      const price = priceOf(prices, market.type);
      legs.push(
        legOf({
          id: `echelon:supply:${market.market}`,
          side: "supply",
          symbol,
          amount: amountOf(market.supplied, decimals),
          price,
          apy: market.supplyApr,
          liquidationThreshold: market.threshold,
        }),
        legOf({
          id: `echelon:borrow:${market.market}`,
          side: "borrow",
          symbol,
          amount: amountOf(market.borrowed, decimals),
          price,
          apy: market.borrowApr,
        }),
      );
    }
    push(
      positionOf({ protocol: "aptos", app: "Echelon", category: "lending", chain: CHAIN, wallet: owner, legs, healthFactor: echelon.health }),
    );
  }

  return { positions, spot, notes } satisfies ChainRead;
};
