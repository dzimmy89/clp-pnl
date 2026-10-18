import { isEvmAddress, isSolanaAddress } from "@/lib/addresses";
import { assetKind, underlyingOf } from "@/lib/assets";
import type { Leg, Position, PositionCategory, ProtocolFetch, SpotHolding } from "@/lib/types";

/**
 * Zerion wallet positions: every token and every DeFi position (lending, staking, LP,
 * vaults, rewards) across the EVM chains Zerion indexes, in one call per wallet. Solana
 * addresses only return wallet balances; Zerion has no Solana protocol positions yet.
 * https://developers.zerion.io/reference/listwalletpositions
 */

const CACHE_MS = 60_000;

export function zerionConfigured(): boolean {
  return Boolean(process.env.ZERION_API_KEY);
}

export interface ZerionPosition {
  id: string;
  attributes: {
    name?: string;
    quantity?: { float?: number | null } | null;
    value?: number | null;
    price?: number | null;
    position_type?: string | null;
    protocol?: string | null;
    protocol_module?: string | null;
    group_id?: string | null;
    pool_address?: string | null;
    fungible_info?: { symbol?: string | null; name?: string | null } | null;
    flags?: { displayable?: boolean | null; is_trash?: boolean | null } | null;
    application_metadata?: { name?: string | null; url?: string | null } | null;
  };
  relationships?: {
    chain?: { data?: { id?: string } };
    dapp?: { data?: { id?: string } };
  };
}

const CHAIN_LABEL: Record<string, string> = {
  ethereum: "Ethereum",
  arbitrum: "Arbitrum",
  base: "Base",
  optimism: "Optimism",
  polygon: "Polygon",
  "binance-smart-chain": "BNB Chain",
  avalanche: "Avalanche",
  xdai: "Gnosis",
  "zksync-era": "zkSync Era",
  linea: "Linea",
  scroll: "Scroll",
  blast: "Blast",
  mantle: "Mantle",
  sonic: "Sonic",
  berachain: "Berachain",
  unichain: "Unichain",
  "polygon-zkevm": "Polygon zkEVM",
  celo: "Celo",
  fantom: "Fantom",
  aurora: "Aurora",
  zora: "Zora",
  mode: "Mode",
  ink: "Ink",
  abstract: "Abstract",
  hyperevm: "HyperEVM",
  solana: "Solana",
};

export function chainLabel(id: string): string {
  return CHAIN_LABEL[id] ?? id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

/**
 * Apps the desk already reads directly, with health factors and liquidation thresholds
 * Zerion doesn't give. Zerion's copy of these is dropped so nothing counts twice.
 */
const READ_DIRECTLY: { chain: string; app: RegExp }[] = [
  { chain: "ethereum", app: /^aave/i },
  { chain: "binance-smart-chain", app: /^venus/i },
  { chain: "hyperevm", app: /^hyperlend/i },
];

function categoryOf(item: ZerionPosition): PositionCategory {
  const { position_type: type, protocol_module: module } = item.attributes;
  if (type === "loan" || module === "lending") return "lending";
  if (module === "liquidity_pool") return "liquidity";
  if (type === "staked" || module === "staked" || module === "nft_staked") return "staking";
  if (type === "locked" || module === "locked" || module === "vesting") return "locked";
  if (type === "reward" || module === "rewards") return "rewards";
  if (module === "yield" || module === "farming" || module === "leveraged_farming" || module === "deposit" || module === "investment" || type === "investment") {
    return "yield";
  }
  return type === "deposit" ? "yield" : "other";
}

const CATEGORY_LABEL: Record<PositionCategory, string> = {
  lending: "Lending",
  staking: "Staking",
  liquidity: "Liquidity",
  yield: "Yield",
  locked: "Locked",
  rewards: "Rewards",
  other: "Position",
};

function appOf(item: ZerionPosition): string {
  return item.attributes.application_metadata?.name || item.attributes.protocol || item.relationships?.dapp?.data?.id || "Unknown app";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Folds Zerion's flat position list into wallet balances and one Position per app, pool or market. */
export function zerionToBook(items: ZerionPosition[], wallet: string, fetchedAt = new Date().toISOString()) {
  const spot: SpotHolding[] = [];
  const groups = new Map<string, { app: string; chain: string; category: PositionCategory; name: string; items: ZerionPosition[] }>();

  for (const item of items) {
    const a = item.attributes;
    if (a.flags?.is_trash) continue;
    const amount = num(a.quantity?.float);
    if (!(amount > 0)) continue;
    const chainId = item.relationships?.chain?.data?.id ?? "unknown";
    const symbol = a.fungible_info?.symbol || a.name || "?";

    if (a.position_type === "wallet") {
      spot.push({
        id: `zerion:${chainId}:${wallet}:${item.id}`,
        wallet,
        chain: chainLabel(chainId),
        symbol,
        underlying: underlyingOf(symbol),
        kind: assetKind(symbol),
        amount,
        usd: num(a.value),
        priceUsd: num(a.price),
        source: "live",
        unpriced: a.value == null,
      });
      continue;
    }

    const app = appOf(item);
    if (READ_DIRECTLY.some((rule) => rule.chain === chainId && rule.app.test(app))) continue;
    const category = categoryOf(item);
    // A pool is one row however many tokens it holds; everything else groups by app and kind.
    const key =
      category === "liquidity"
        ? `${chainId}|pool|${a.group_id || a.pool_address || item.id}`
        : `${chainId}|${app}|${category === "lending" ? "lending" : category}`;
    const group = groups.get(key) ?? { app, chain: chainLabel(chainId), category, name: a.name ?? "", items: [] };
    group.items.push(item);
    groups.set(key, group);
  }

  const positions: Position[] = [];
  for (const [key, group] of groups) {
    const legs: Leg[] = group.items.map((item) => {
      const a = item.attributes;
      const symbol = a.fungible_info?.symbol || a.name || "?";
      const borrow = a.position_type === "loan";
      return {
        id: item.id,
        side: borrow ? "borrow" : "supply",
        symbol,
        underlying: underlyingOf(symbol),
        kind: assetKind(symbol),
        amount: num(a.quantity?.float),
        usd: num(a.value),
        apy: 0,
        apyUnknown: true,
        priceUsd: a.price ?? undefined,
        isCollateral: group.category === "lending" ? !borrow : false,
      };
    });
    const hasDebt = legs.some((leg) => leg.side === "borrow");
    const pool = group.category === "liquidity" ? legs.map((leg) => leg.symbol).join("/") : "";
    positions.push({
      id: `zerion:${wallet}:${key}`,
      protocol: "zerion",
      app: group.app,
      category: group.category,
      chain: group.chain,
      wallet,
      label: `${group.app} ${pool || CATEGORY_LABEL[group.category]} · ${group.chain}`,
      source: "live",
      legs,
      healthFactor: null,
      healthFactorSource: hasDebt ? "estimated" : undefined,
      note: hasDebt
        ? "Read via Zerion, which reports balances but not rates or liquidation thresholds, so health is estimated."
        : "Read via Zerion. APY isn't reported.",
      fetchedAt,
    });
  }
  positions.sort((x, y) => sumUsd(y) - sumUsd(x));
  return { positions, spot };
}

function sumUsd(position: Position): number {
  return position.legs.reduce((sum, leg) => sum + (leg.side === "supply" ? leg.usd : -leg.usd), 0);
}

const globalForZerion = globalThis as unknown as {
  omnifolioZerion?: Map<string, { at: number; items: ZerionPosition[] }>;
  omnifolioZerionQueue?: Promise<unknown>;
};
const cache = (globalForZerion.omnifolioZerion ??= new Map());

/** Free keys allow only a few requests a second, so wallets are read one after another with a short gap. */
const REQUEST_GAP_MS = 350;

function queued<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalForZerion.omnifolioZerionQueue ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  globalForZerion.omnifolioZerionQueue = run.catch(() => undefined).then(() => new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS)));
  return run;
}

async function zerionPositions(address: string, solana: boolean): Promise<ZerionPosition[]> {
  const key = process.env.ZERION_API_KEY;
  if (!key) throw new Error("ZERION_API_KEY is not set");
  const cacheKey = `${solana ? "sol" : "evm"}:${address.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items;
  return queued(() => zerionRequest(address, solana, cacheKey, key));
}

async function zerionRequest(address: string, solana: boolean, cacheKey: string, key: string): Promise<ZerionPosition[]> {
  // EVM gets every protocol position; Solana only has wallet balances, which use the cheaper quota.
  const params = new URLSearchParams({
    "filter[positions]": solana ? "only_simple" : "no_filter",
    "filter[trash]": "only_non_trash",
    currency: "usd",
    sort: "value",
  });
  const api = process.env.ZERION_API_URL || "https://api.zerion.io/v1";
  const url = `${api}/wallets/${encodeURIComponent(address)}/positions/?${params}`;
  const headers = { accept: "application/json", authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` };

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: controller.signal });
    } catch (error) {
      throw new Error(error instanceof Error && error.name === "AbortError" ? "Zerion timed out" : "Could not reach Zerion");
    } finally {
      clearTimeout(timer);
    }
    // 503 means Zerion is still indexing a wallet it hasn't seen; it says when to come back.
    // 429 is the per-second quota; one short wait usually clears it.
    if ((response.status === 503 || response.status === 429) && attempt < 2) {
      const wait = Math.min(Number(response.headers.get("retry-after")) || 2, 4);
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new Error("Zerion rejected the API key");
    if (response.status === 429) throw new Error("Zerion rate limit reached. Try again in a minute.");
    if (!response.ok) throw new Error(`Zerion returned ${response.status}`);
    const body = (await response.json()) as { data?: ZerionPosition[] };
    const items = body.data ?? [];
    cache.set(cacheKey, { at: Date.now(), items });
    return items;
  }
  throw new Error("Zerion is still indexing this wallet. Refresh in a minute.");
}

export async function fetchZerion(address: string): Promise<ProtocolFetch> {
  const base = { id: "zerion" as const, name: "Every EVM protocol", chain: "All EVM chains, via Zerion" };
  if (!address) return { ...base, status: "skipped", message: "Add an EVM or Solana wallet.", positions: [], spot: [] };
  if (!zerionConfigured()) {
    return { ...base, status: "skipped", message: "Set ZERION_API_KEY to read every EVM chain and protocol.", positions: [], spot: [] };
  }
  const solana = !isEvmAddress(address);
  if (solana && !isSolanaAddress(address)) {
    return { ...base, status: "error", message: "Not an EVM or Solana address.", positions: [], spot: [] };
  }
  const items = await zerionPositions(address, solana);
  const { positions, spot } = zerionToBook(items, address);
  return { ...base, status: "ok", positions, spot };
}
