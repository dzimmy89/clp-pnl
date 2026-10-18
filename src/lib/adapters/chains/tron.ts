import { sha256 } from "@noble/hashes/sha2.js";
import { createBase58check } from "@scure/base";
import {
  getJson,
  legOf,
  llamaPrices,
  positionOf,
  readApp,
  spotRow,
  units,
  type ChainDeps,
  type ChainReader,
} from "@/lib/adapters/chains/common";
import type { Leg, Position } from "@/lib/types";

/**
 * Tron wallet reader.
 * - Balances: TRX and TRC20 tokens from TronGrid `GET /v1/accounts/{address}`, priced through DefiLlama
 *   (`coingecko:tron`, `tron:<contract>`). Unknown tokens DefiLlama can't price are treated as spam.
 * - Staking: Stake 2.0 frozen TRX (including resources delegated to others), leftover Stake 1.0 freezes,
 *   TRX waiting out the unstake period, and unclaimed voting rewards (`/wallet/getReward`).
 * - JustLend DAO: supply and borrow per market, read from the Comptroller and jToken contracts with
 *   `/wallet/triggerconstantcontract` (Compound v2 layout: getAssetsIn, getAllMarkets, getAccountSnapshot,
 *   markets, supply/borrowRatePerBlock).
 *
 * Env (optional): TRONGRID_API_KEY (sent as TRON-PRO-API-KEY), TRONGRID_API_URL (defaults to api.trongrid.io).
 */

const CHAIN = "Tron";
const PROTOCOL = "tron" as const;
const TRX_PRICE_KEY = "coingecko:tron";
const MAX_SPOT = 100;
const MAX_UNKNOWN_TOKENS = 20;

/** JustLend DAO Comptroller (Unitroller). */
export const JUSTLEND_COMPTROLLER = "TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7";
/** JustLend's 3-second blocks. */
const BLOCKS_PER_YEAR = 10_512_000;

/** Well-known TRC20s: symbol and decimals, so most wallets need no metadata calls. */
export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: { symbol: "USDT", decimals: 6 },
  TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: { symbol: "USDC", decimals: 6 },
  TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz: { symbol: "USDD", decimals: 18 },
  TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn: { symbol: "USDD", decimals: 18 },
  TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4: { symbol: "TUSD", decimals: 18 },
  TMwFHYXLJaRUPeW6421aqXL4ZEzPRFGkGT: { symbol: "USDJ", decimals: 18 },
  TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4: { symbol: "BTT", decimals: 18 },
  TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9: { symbol: "JST", decimals: 18 },
  TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S: { symbol: "SUN", decimals: 18 },
  TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7: { symbol: "WIN", decimals: 6 },
  TFczxzPhnThNSqr5by8tvxsdCFRRz6cPNq: { symbol: "NFT", decimals: 6 },
  TXpw8XeWYeTUd4quDskoUqeQPowRh4jY65: { symbol: "WBTC", decimals: 8 },
  TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9: { symbol: "BTC", decimals: 8 },
  THb4CqiFdwNHsWsQCs4JhzwjMWys4aqCbF: { symbol: "ETH", decimals: 18 },
  TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR: { symbol: "WTRX", decimals: 6 },
  TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5: { symbol: "sTRX", decimals: 18 },
  TThzxNRLrW2Brp9DcTQU8i4Wd9udCWEdZ3: { symbol: "stUSDT", decimals: 18 },
  TUPM7K8REVzD2UdV4R5fe5M8XbnR2DdoJ6: { symbol: "HTX", decimals: 18 },
};

const base58check = createBase58check(sha256);

/** The 20-byte account id (hex, no 0x41 prefix) of a base58 Tron address. Throws on anything else. */
export function tronHex(address: string): string {
  let bytes: Uint8Array;
  try {
    bytes = base58check.decode(address.trim());
  } catch {
    throw new Error(`Not a Tron address: ${address}`);
  }
  if (bytes.length !== 21 || bytes[0] !== 0x41) throw new Error(`Not a Tron address: ${address}`);
  return Buffer.from(bytes.subarray(1)).toString("hex");
}

/** Base58 address from an ABI word or 20-byte hex. */
export function tronBase58(hex: string): string {
  return base58check.encode(Uint8Array.from(Buffer.from(`41${hex.slice(-40)}`, "hex")));
}

interface TronApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

function tronApi(deps: ChainDeps): TronApi {
  const base = (process.env.TRONGRID_API_URL || "https://api.trongrid.io").replace(/\/+$/, "");
  const key = process.env.TRONGRID_API_KEY;
  const headers: Record<string, string> = key ? { "TRON-PRO-API-KEY": key } : {};
  return {
    get: (path) => getJson(`${base}${path}`, { headers }, deps),
    post: (path, body) => getJson(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }, deps),
  };
}

// ---------- Contract calls ----------

interface ConstantResult {
  result?: { result?: boolean; message?: string };
  constant_result?: string[];
  Error?: string;
}

type Call = (contract: string, selector: string, parameter?: string) => Promise<string | null>;

/** A read-only contract call. Null when the contract reverts; throws when the node is unreachable. */
function caller(api: TronApi, owner: string): Call {
  return async (contract, selector, parameter = "") => {
    const body = await api.post<ConstantResult>("/wallet/triggerconstantcontract", {
      owner_address: owner,
      contract_address: contract,
      function_selector: selector,
      parameter,
      visible: true,
    });
    const out = body.constant_result?.[0] ?? "";
    if (body.Error || body.result?.message || body.result?.result === false || !out || out.length % 64 === 8) return null;
    return out;
  };
}

const addressParam = (address: string) => tronHex(address).padStart(64, "0");
const word = (hex: string, index: number) => BigInt(`0x${hex.slice(index * 64, index * 64 + 64) || "0"}`);

function addressList(hex: string | null): string[] | null {
  if (!hex) return null;
  const start = Number(word(hex, 0)) / 32;
  const length = Number(word(hex, start));
  return Array.from({ length }, (_, i) => tronBase58(hex.slice((start + 1 + i) * 64, (start + 2 + i) * 64)));
}

function abiString(hex: string | null): string | null {
  if (!hex) return null;
  if (hex.length === 64) return Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/, "") || null;
  const start = Number(word(hex, 0)) / 32;
  const length = Number(word(hex, start));
  return Buffer.from(hex.slice((start + 1) * 64, (start + 1) * 64 + length * 2), "hex").toString("utf8") || null;
}

async function tokenMeta(call: Call, contract: string) {
  const known = KNOWN_TOKENS[contract];
  if (known) return known;
  const [decimals, symbol] = await Promise.all([call(contract, "decimals()"), call(contract, "symbol()")]);
  if (!decimals) return null;
  return { symbol: abiString(symbol) ?? contract.slice(0, 6), decimals: Number(word(decimals, 0)) };
}

// ---------- Account ----------

interface TronAccount {
  balance?: number;
  trc20?: Record<string, string>[];
  frozenV2?: { type?: string; amount?: number }[];
  unfrozenV2?: { type?: string; unfreeze_amount?: number; unfreeze_expire_time?: number }[];
  delegated_frozenV2_balance_for_bandwidth?: number;
  frozen?: { frozen_balance?: number }[];
  delegated_frozen_balance_for_bandwidth?: number;
  account_resource?: {
    delegated_frozenV2_balance_for_energy?: number;
    frozen_balance_for_energy?: { frozen_balance?: number };
    delegated_frozen_balance_for_energy?: number;
  };
}

function stakedSun(account: TronAccount) {
  const resource = account.account_resource ?? {};
  const staked =
    (account.frozenV2 ?? []).reduce((sum, entry) => sum + (entry.amount ?? 0), 0) +
    (account.delegated_frozenV2_balance_for_bandwidth ?? 0) +
    (resource.delegated_frozenV2_balance_for_energy ?? 0) +
    (account.frozen ?? []).reduce((sum, entry) => sum + (entry.frozen_balance ?? 0), 0) +
    (account.delegated_frozen_balance_for_bandwidth ?? 0) +
    (resource.frozen_balance_for_energy?.frozen_balance ?? 0) +
    (resource.delegated_frozen_balance_for_energy ?? 0);
  const unstaking = (account.unfrozenV2 ?? []).reduce((sum, entry) => sum + (entry.unfreeze_amount ?? 0), 0);
  return { staked, unstaking };
}

// ---------- JustLend ----------

const mantissa = (value: bigint) => Number(value) / 1e18;

async function readJustLend(
  user: string,
  holdings: Map<string, string>,
  call: Call,
  deps: ChainDeps,
): Promise<{ position: Position | null; markets: Set<string> }> {
  const param = addressParam(user);
  const [assetsIn, allMarkets] = await Promise.all([
    call(JUSTLEND_COMPTROLLER, "getAssetsIn(address)", param).then(addressList),
    call(JUSTLEND_COMPTROLLER, "getAllMarkets()").then(addressList),
  ]);
  if (!assetsIn && !allMarkets) throw new Error("Comptroller read failed");
  const markets = new Set(allMarkets ?? []);
  const entered = new Set(assetsIn ?? []);
  const candidates = [...new Set([...entered, ...[...markets].filter((m) => holdings.has(m))])];

  const rows = await Promise.all(
    candidates.map(async (jToken) => {
      const snapshot = await call(jToken, "getAccountSnapshot(address)", param);
      if (!snapshot || word(snapshot, 0) !== BigInt(0)) return null;
      const jBalance = word(snapshot, 1);
      const borrowed = word(snapshot, 2);
      const exchangeRate = word(snapshot, 3);
      if (jBalance === BigInt(0) && borrowed === BigInt(0)) return null;
      const underlyingWord = await call(jToken, "underlying()");
      // jTRX has no underlying() and reverts.
      const underlying = underlyingWord ? tronBase58(underlyingWord) : null;
      const meta = underlying ? await tokenMeta(call, underlying) : { symbol: "TRX", decimals: 6 };
      if (!meta) return null;
      const supplied = (jBalance * exchangeRate) / BigInt(10) ** BigInt(18);
      const [market, supplyRate, borrowRate] = await Promise.all([
        supplied > BigInt(0) ? call(JUSTLEND_COMPTROLLER, "markets(address)", addressParam(jToken)) : null,
        supplied > BigInt(0) ? call(jToken, "supplyRatePerBlock()") : null,
        borrowed > BigInt(0) ? call(jToken, "borrowRatePerBlock()") : null,
      ]);
      return { jToken, underlying, meta, supplied, borrowed, market, supplyRate, borrowRate };
    }),
  );
  const held = rows.filter((row) => row != null);
  if (!held.length) return { position: null, markets };

  const prices = await llamaPrices(
    held.map((row) => (row.underlying ? `tron:${row.underlying}` : TRX_PRICE_KEY)),
    deps,
  );
  const legs: Leg[] = [];
  for (const row of held) {
    const price = prices[row.underlying ? `tron:${row.underlying}` : TRX_PRICE_KEY];
    const yearly = (rate: string | null) => (rate ? mantissa(word(rate, 0)) * BLOCKS_PER_YEAR : 0);
    const collateral = entered.has(row.jToken);
    const factor = row.market ? mantissa(word(row.market, 1)) : undefined;
    legs.push(
      legOf({
        id: `${row.jToken}:supply`,
        side: "supply",
        symbol: row.meta.symbol,
        amount: units(row.supplied, row.meta.decimals),
        price,
        apy: yearly(row.supplyRate),
        isCollateral: collateral,
        liquidationThreshold: collateral && factor ? factor : undefined,
      }),
      legOf({
        id: `${row.jToken}:borrow`,
        side: "borrow",
        symbol: row.meta.symbol,
        amount: units(row.borrowed, row.meta.decimals),
        price,
        apy: yearly(row.borrowRate),
      }),
    );
  }
  const position = positionOf({ protocol: PROTOCOL, app: "JustLend DAO", category: "lending", chain: CHAIN, wallet: user, legs });
  return { position, markets };
}

// ---------- Reader ----------

export const readTron: ChainReader = async (address, deps = {}) => {
  const wallet = address.trim();
  tronHex(wallet);
  const api = tronApi(deps);
  const call = caller(api, wallet);
  const notes: string[] = [];

  const { data = [] } = await api.get<{ data?: TronAccount[] }>(`/v1/accounts/${wallet}`);
  const account = data[0] ?? {};
  const holdings = new Map<string, string>();
  for (const entry of account.trc20 ?? []) {
    for (const [contract, raw] of Object.entries(entry)) if (BigInt(raw || "0") > BigInt(0)) holdings.set(contract, raw);
  }

  const [justLend, reward, priced] = await Promise.all([
    readApp("JustLend DAO", notes, () => readJustLend(wallet, holdings, call, deps)),
    readApp("TRON voting rewards", notes, () =>
      api.post<{ reward?: number }>("/wallet/getReward", { address: wallet, visible: true }),
    ),
    llamaPrices([TRX_PRICE_KEY, ...[...holdings.keys()].map((c) => `tron:${c}`)], deps),
  ]);
  const trxPrice = priced[TRX_PRICE_KEY];

  // Unknown tokens only count when DefiLlama prices them; that drops airdropped spam without metadata calls.
  let unknown = 0;
  const tokenRows = await Promise.all(
    [...holdings]
      .filter(([contract]) => !justLend?.markets.has(contract))
      .filter(([contract]) => KNOWN_TOKENS[contract] || (priced[`tron:${contract}`] && unknown++ < MAX_UNKNOWN_TOKENS))
      .map(async ([contract, raw]) => {
        const meta = await tokenMeta(call, contract).catch(() => null);
        if (!meta) return null;
        return spotRow({
          protocol: PROTOCOL,
          wallet,
          chain: CHAIN,
          symbol: meta.symbol,
          amount: units(raw, meta.decimals),
          price: priced[`tron:${contract}`],
          tokenId: contract,
        });
      }),
  );
  const spot = [spotRow({ protocol: PROTOCOL, wallet, chain: CHAIN, symbol: "TRX", amount: units(String(account.balance ?? 0), 6), price: trxPrice, tokenId: "TRX" }), ...tokenRows]
    .filter((row) => row != null)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, MAX_SPOT);

  const positions: Position[] = [];
  const { staked, unstaking } = stakedSun(account);
  const staking = positionOf({
    protocol: PROTOCOL,
    app: "TRON Staking",
    category: "staking",
    chain: CHAIN,
    wallet,
    legs: [
      legOf({ id: "trx:staked", side: "supply", symbol: "TRX", amount: units(String(staked), 6), price: trxPrice, isCollateral: false }),
      legOf({ id: "trx:unstaking", side: "supply", symbol: "TRX", amount: units(String(unstaking), 6), price: trxPrice, isCollateral: false }),
    ],
  });
  if (staking) positions.push(staking);
  const rewards = positionOf({
    protocol: PROTOCOL,
    app: "TRON Staking",
    category: "rewards",
    chain: CHAIN,
    wallet,
    legs: [legOf({ id: "trx:reward", side: "supply", symbol: "TRX", amount: units(String(reward?.reward ?? 0), 6), price: trxPrice, isCollateral: false })],
  });
  if (rewards) positions.push(rewards);
  if (justLend?.position) positions.push(justLend.position);

  return { spot, positions, notes };
};
