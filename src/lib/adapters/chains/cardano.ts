import { bech32 } from "@scure/base";
import {
  emptyRead,
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
import { cardanoAddressToBech32 } from "@/lib/auth/chains/cardano";
import type { SpotHolding } from "@/lib/types";

/**
 * Cardano reader over Koios (https://api.koios.rest/api/v1, optional env KOIOS_API_KEY sent as a
 * Bearer token). A base `addr1…` address is reduced to its stake address so the whole account is
 * read: ADA (account_info), native tokens (account_assets + asset_info for tickers/decimals) and the
 * pool delegation with unclaimed rewards (pool_info for the ticker). Addresses without a stake part
 * fall back to address_info/address_assets. ADA is priced as coingecko:cardano, tokens as
 * `cardano:<policy id><asset name hex>` on DefiLlama.
 */

const KOIOS = "https://api.koios.rest/api/v1";
const CHAIN = "Cardano";
const APP = "Cardano staking";
const BECH32_LIMIT = 1023;
const MAX_TOKENS = 150;
const CIP68_FT_PREFIX = "0014df10";

/** Well-known fungible tokens kept even when Koios has no metadata. unit → [symbol, decimals, CoinGecko id]. */
const KNOWN: Record<string, [string, number, string?]> = {
  "29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c64d494e": ["MIN", 6, "minswap"],
  "279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e454b": ["SNEK", 0, "snek"],
  "8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61446a65644d6963726f555344": ["DJED", 6, "djed"],
  "f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b6988069555344": ["iUSD", 6],
  "a0028f350aaabe0545fdcb56b039bfb08e4bb4d8c4d7c3c7d481c235484f534b59": ["HOSKY", 0],
  "533bb94a8850ee3ccbe483106489399112b74c905342cb1792a797a0494e4459": ["INDY", 6],
};

/** The stake address behind a mainnet address (null for enterprise/pointer addresses) and the payment address, if any. */
export function cardanoAccount(address: string): { stake: string | null; payment: string | null } {
  let hrp: string;
  let bytes: Uint8Array;
  try {
    const decoded = bech32.decode(address.trim().toLowerCase() as `${string}1${string}`, BECH32_LIMIT);
    hrp = decoded.prefix;
    bytes = bech32.fromWords(decoded.words);
  } catch {
    throw new Error("Not a Cardano bech32 address (addr1… or stake1…)");
  }
  if ((hrp !== "addr" && hrp !== "stake") || !bytes.length || (bytes[0] & 0x0f) !== 1) {
    throw new Error("Only Cardano mainnet addresses are supported");
  }
  const type = bytes[0] >> 4;
  if (hrp === "stake") {
    if ((type !== 14 && type !== 15) || bytes.length !== 29) throw new Error("Not a Cardano stake address");
    return { stake: cardanoAddressToBech32(bytes), payment: null };
  }
  if (type > 7) throw new Error("Not a Cardano payment address");
  const payment = cardanoAddressToBech32(bytes);
  if (type <= 3 && bytes.length === 57) {
    const header = (type === 0 || type === 1 ? 0xe0 : 0xf0) | 1;
    return { stake: cardanoAddressToBech32(Uint8Array.from([header, ...bytes.slice(29)])), payment };
  }
  return { stake: null, payment };
}

function koios<T>(path: string, body: unknown, deps: ChainDeps): Promise<T> {
  const key = process.env.KOIOS_API_KEY;
  return getJson<T>(
    `${KOIOS}${path}`,
    { method: "POST", body: JSON.stringify(body), headers: key ? { authorization: `Bearer ${key}` } : {} },
    deps,
  );
}

interface AccountInfo {
  stake_address: string;
  status?: string;
  delegated_pool?: string | null;
  total_balance?: string;
  utxo?: string;
  rewards_available?: string;
}
interface AddressInfo {
  address: string;
  balance?: string;
}
interface AssetRow {
  policy_id: string;
  asset_name: string | null;
  fingerprint?: string;
  decimals?: number | null;
  quantity: string;
}
interface AssetInfo {
  policy_id: string;
  asset_name: string | null;
  asset_name_ascii?: string | null;
  token_registry_metadata?: { ticker?: string | null; decimals?: number | null; name?: string | null } | null;
  cip68_metadata?: Record<string, unknown> | null;
}
interface PoolInfo {
  pool_id_bech32: string;
  meta_json?: { ticker?: string | null; name?: string | null } | null;
}

function asciiName(hex: string): string | null {
  const body = hex.startsWith(CIP68_FT_PREFIX) ? hex.slice(CIP68_FT_PREFIX.length) : hex;
  const text = Buffer.from(body, "hex").toString("utf8");
  return /^[\x20-\x7e]{1,24}$/.test(text) ? text.trim() || null : null;
}

interface Token {
  unit: string;
  symbol: string;
  decimals: number;
  raw: string;
  coingecko?: string;
  /** No registry/CIP-68 metadata and not a known token: dropped unless priced. */
  spam: boolean;
}

async function readTokens(rows: AssetRow[], deps: ChainDeps): Promise<Token[]> {
  const fungible = rows.filter((row) => BigInt(row.quantity || "0") > BigInt(1) || (row.decimals ?? 0) > 0 || KNOWN[row.policy_id + (row.asset_name ?? "")]);
  const picked = fungible.slice(0, MAX_TOKENS);
  if (!picked.length) return [];
  const info = await koios<AssetInfo[]>("/asset_info", { _asset_list: picked.map((row) => [row.policy_id, row.asset_name ?? ""]) }, deps);
  const byUnit = new Map(info.map((item) => [item.policy_id + (item.asset_name ?? ""), item]));
  const tokens: Token[] = [];
  for (const row of picked) {
    const unit = row.policy_id + (row.asset_name ?? "");
    const known = KNOWN[unit];
    const meta = byUnit.get(unit);
    const registry = meta?.token_registry_metadata;
    const hasMetadata = Boolean(registry || meta?.cip68_metadata || (row.decimals ?? 0) > 0);
    const decimals = known?.[1] ?? registry?.decimals ?? row.decimals ?? 0;
    const symbol = known?.[0] ?? registry?.ticker ?? asciiName(row.asset_name ?? "") ?? row.fingerprint?.slice(0, 12) ?? unit.slice(0, 12);
    tokens.push({ unit, symbol, decimals, raw: row.quantity, coingecko: known?.[2], spam: !hasMetadata && !known });
  }
  return tokens;
}

export const readCardano: ChainReader = async (address, deps = {}) => {
  const { stake, payment } = cardanoAccount(address);
  const wallet = address.trim();
  const out = emptyRead();

  let account: AccountInfo | undefined;
  let lovelace = "0";
  if (stake) {
    [account] = await koios<AccountInfo[]>("/account_info", { _stake_addresses: [stake] }, deps);
    if (account) {
      lovelace = account.utxo ?? String(BigInt(account.total_balance ?? "0") - BigInt(account.rewards_available ?? "0"));
    }
  }
  const byAddress = !account && payment;
  if (byAddress) {
    const [info] = await koios<AddressInfo[]>("/address_info", { _addresses: [payment] }, deps);
    lovelace = info?.balance ?? "0";
  }

  const pool = account?.delegated_pool ?? null;
  const [tokens, poolInfo] = await Promise.all([
    readApp("Cardano tokens", out.notes, async () => {
      const rows = byAddress
        ? await koios<AssetRow[]>("/address_assets", { _addresses: [payment] }, deps)
        : stake
          ? await koios<AssetRow[]>("/account_assets", { _stake_addresses: [stake] }, deps)
          : [];
      return readTokens(rows, deps);
    }),
    pool ? koios<PoolInfo[]>("/pool_info", { _pool_bech32_ids: [pool] }, deps).catch(() => []) : Promise.resolve([]),
  ]);

  const tokenKeys = (tokens ?? []).flatMap((token) => [`cardano:${token.unit}`, ...(token.coingecko ? [`coingecko:${token.coingecko}`] : [])]);
  const prices = await llamaPrices(["coingecko:cardano", ...tokenKeys], deps);
  const adaPrice = prices["coingecko:cardano"] ?? null;

  const ada = units(lovelace, 6);
  const rewards = units(account?.rewards_available ?? "0", 6);
  const spot: SpotHolding[] = [];

  if (pool) {
    const ticker = poolInfo[0]?.meta_json?.ticker;
    const position = positionOf({
      protocol: "cardano",
      app: APP,
      category: "staking",
      chain: CHAIN,
      wallet,
      label: ticker ? `${APP} · ${ticker}` : APP,
      legs: [
        legOf({ id: "cardano:delegated", side: "supply", symbol: "ADA", amount: ada, price: adaPrice, isCollateral: false }),
        legOf({ id: "cardano:rewards", side: "supply", symbol: "ADA", amount: rewards, price: adaPrice, isCollateral: false }),
      ],
      note: `Delegated to ${ticker ?? pool.slice(0, 16) + "…"}; ADA stays in the wallet, rewards are unclaimed`,
    });
    if (position) out.positions.push(position);
  } else {
    const row = spotRow({ protocol: "cardano", wallet, chain: CHAIN, symbol: "ADA", amount: ada, price: adaPrice, tokenId: "lovelace" });
    if (row) spot.push(row);
    const position = positionOf({
      protocol: "cardano",
      app: APP,
      category: "rewards",
      chain: CHAIN,
      wallet,
      label: `${APP} rewards`,
      legs: [legOf({ id: "cardano:rewards", side: "supply", symbol: "ADA", amount: rewards, price: adaPrice, isCollateral: false })],
    });
    if (position) out.positions.push(position);
  }

  for (const token of tokens ?? []) {
    const price = prices[`cardano:${token.unit}`] ?? (token.coingecko ? prices[`coingecko:${token.coingecko}`] : undefined) ?? null;
    if (!price && token.spam) continue;
    const row = spotRow({ protocol: "cardano", wallet, chain: CHAIN, symbol: token.symbol, amount: units(token.raw, token.decimals), price, tokenId: token.unit });
    if (row) spot.push(row);
  }

  out.spot = spot.sort((a, b) => b.usd - a.usd).slice(0, 100);
  return out;
};
