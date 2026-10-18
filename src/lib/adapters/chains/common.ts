import { assetKind, underlyingOf } from "@/lib/assets";
import type { Leg, Position, PositionCategory, ProtocolId, SpotHolding } from "@/lib/types";

/**
 * Shared pieces for the whole-chain readers (Sui, Aptos, TON, Tron, Cosmos, Starknet,
 * Cardano, Kaspa and the extra Solana apps). Each reader turns one wallet into balances
 * and app positions. A failing app becomes a note; it never hides the rest of the wallet.
 */

export interface ChainRead {
  positions: Position[];
  spot: SpotHolding[];
  /** One short line per app or call that failed, e.g. "NAVI: timed out". */
  notes: string[];
}

export interface ChainDeps {
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export type ChainReader = (address: string, deps?: ChainDeps) => Promise<ChainRead>;

export function emptyRead(): ChainRead {
  return { positions: [], spot: [], notes: [] };
}

/** Runs one app's read and turns a failure into a note instead of an exception. */
export async function readApp<T>(name: string, notes: string[], task: () => Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch (error) {
    notes.push(`${name}: ${shortError(error)}`);
    return null;
  }
}

export function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "request failed");
  return message.split("\n")[0].slice(0, 160);
}

/** GET or POST JSON with a timeout. Throws on non-2xx with the status in the message. */
export async function getJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  deps: ChainDeps = {},
): Promise<T> {
  const doFetch = deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    const response = await doFetch(url, {
      ...init,
      signal: controller.signal,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    if (!response.ok) throw new Error(`${new URL(url).host} returned ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`${new URL(url).host} timed out`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** JSON-RPC 2.0 call. Throws the node's error message when it returns one. */
export async function rpc<T>(url: string, method: string, params: unknown, deps: ChainDeps = {}): Promise<T> {
  const body = await getJson<{ result?: T; error?: { message?: string } }>(
    url,
    { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
    deps,
  );
  if (body.error) throw new Error(body.error.message ?? `${method} failed`);
  return body.result as T;
}

const priceCache = new Map<string, { at: number; price: number | null }>();
const PRICE_TTL_MS = 60_000;

/**
 * USD prices from DefiLlama, keyed the way DefiLlama keys coins: `coingecko:kaspa`,
 * `sui:0x2::sui::SUI`, `aptos:0x1::aptos_coin::AptosCoin`, `tron:T…`, `ton:EQ…`,
 * `starknet:0x…`. Unknown coins are left out of the result. Never throws: no prices
 * means unpriced rows, not a failed wallet.
 */
export async function llamaPrices(keys: string[], deps: ChainDeps = {}): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const now = Date.now();
  const missing: string[] = [];
  for (const key of new Set(keys)) {
    const hit = priceCache.get(key);
    if (hit && now - hit.at < PRICE_TTL_MS) {
      if (hit.price != null) out[key] = hit.price;
    } else missing.push(key);
  }
  for (let i = 0; i < missing.length; i += 60) {
    const chunk = missing.slice(i, i + 60);
    try {
      const body = await getJson<{ coins?: Record<string, { price?: number }> }>(
        `https://coins.llama.fi/prices/current/${chunk.map(encodeURIComponent).join(",")}`,
        {},
        deps,
      );
      for (const key of chunk) {
        const price = body.coins?.[key]?.price;
        const ok = typeof price === "number" && price > 0;
        priceCache.set(key, { at: now, price: ok ? price : null });
        if (ok) out[key] = price;
      }
    } catch {
      // Leave this chunk unpriced.
    }
  }
  return out;
}

/** Token units from an integer string and decimals, without losing precision on big balances. */
export function units(raw: string | number | bigint, decimals: number): number {
  const value = typeof raw === "bigint" ? raw : BigInt(String(raw).split(".")[0] || "0");
  if (decimals <= 0) return Number(value);
  const base = BigInt(10) ** BigInt(decimals);
  return Number(value / base) + Number(value % base) / Number(base);
}

/** A wallet balance row. Rows with no amount are dropped by returning null. */
export function spotRow(input: {
  protocol: ProtocolId;
  wallet: string;
  chain: string;
  symbol: string;
  amount: number;
  price?: number | null;
  /** Distinguishes two tokens with the same symbol, e.g. the coin type or mint. */
  tokenId?: string;
}): SpotHolding | null {
  if (!(input.amount > 0)) return null;
  const price = input.price && input.price > 0 ? input.price : 0;
  return {
    id: `${input.protocol}:${input.wallet}:${input.tokenId ?? input.symbol}`,
    wallet: input.wallet,
    chain: input.chain,
    symbol: input.symbol,
    underlying: underlyingOf(input.symbol),
    kind: assetKind(input.symbol),
    amount: input.amount,
    usd: input.amount * price,
    priceUsd: price,
    source: "live",
    unpriced: !price,
  };
}

/** One supply or borrow line of a position. `apy` is a decimal (0.05 is 5%); leave it out when unknown. */
export function legOf(input: {
  id: string;
  side: Leg["side"];
  symbol: string;
  amount: number;
  price?: number | null;
  usd?: number;
  apy?: number;
  liquidationThreshold?: number;
  isCollateral?: boolean;
}): Leg {
  const price = input.price && input.price > 0 ? input.price : undefined;
  return {
    id: input.id,
    side: input.side,
    symbol: input.symbol,
    underlying: underlyingOf(input.symbol),
    kind: assetKind(input.symbol),
    amount: input.amount,
    usd: input.usd ?? (price ? input.amount * price : 0),
    apy: input.apy ?? 0,
    apyUnknown: input.apy == null ? true : undefined,
    priceUsd: price,
    liquidationThreshold: input.liquidationThreshold,
    liquidationThresholdSource: input.liquidationThreshold != null ? "protocol" : undefined,
    isCollateral: input.isCollateral ?? input.side === "supply",
  };
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

/** A position in one app. Empty positions (no legs with an amount) are dropped by returning null. */
export function positionOf(input: {
  protocol: ProtocolId;
  app: string;
  category: PositionCategory;
  chain: string;
  wallet: string;
  legs: Leg[];
  /** Protocol-reported health factor, when the app publishes one. */
  healthFactor?: number | null;
  /** Extra id part when one wallet has several positions in the same app and category. */
  key?: string;
  label?: string;
  note?: string;
}): Position | null {
  // Only lending supplies back a loan; staked or pooled tokens never count as collateral.
  const legs = input.legs
    .filter((leg) => leg.amount > 0)
    .map((leg) => (input.category === "lending" ? leg : { ...leg, isCollateral: false }));
  if (!legs.length) return null;
  const hasDebt = legs.some((leg) => leg.side === "borrow");
  return {
    id: `${input.protocol}:${input.wallet}:${input.app}:${input.category}${input.key ? `:${input.key}` : ""}`,
    protocol: input.protocol,
    app: input.app,
    category: input.category,
    chain: input.chain,
    wallet: input.wallet,
    label: input.label ?? `${input.app} ${CATEGORY_LABEL[input.category]} · ${input.chain}`,
    source: "live",
    legs,
    healthFactor: input.healthFactor ?? null,
    healthFactorSource: input.healthFactor != null ? "protocol" : hasDebt ? "estimated" : undefined,
    note: input.note,
    fetchedAt: new Date().toISOString(),
  };
}
