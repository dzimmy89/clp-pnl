import { isEvmAddress } from "@/lib/addresses";
import { assetKind, assumedLiquidationThreshold, underlyingOf } from "@/lib/assets";
import { fetchJson } from "@/lib/http";
import { protocolMeta, type Leg, type Position, type ProtocolFetch } from "@/lib/types";

const ENDPOINT = "https://api.v3.aave.com/graphql";
const ETHEREUM_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

const POSITIONS_QUERY = `
query Positions($user: EvmAddress!, $market: EvmAddress!) {
  userSupplies(request: { user: $user, collateralsOnly: false, markets: [{ chainId: 1, address: $market }], orderBy: { balance: DESC } }) {
    currency { symbol address }
    balance { amount { value } usd usdPerToken }
    apy { value }
    isCollateral
  }
  userBorrows(request: { user: $user, markets: [{ chainId: 1, address: $market }], orderBy: { debt: DESC } }) {
    currency { symbol address }
    debt { amount { value } usd usdPerToken }
    apy { value }
  }
}`;

const STATE_QUERY = `
query State($user: EvmAddress!, $market: EvmAddress!) {
  userMarketState(request: { user: $user, market: $market, chainId: 1 }) {
    healthFactor
    currentLiquidationThreshold { value }
  }
}`;

const RESERVES_QUERY = `
query Reserves {
  markets(request: { chainIds: [1] }) {
    address
    reserves {
      underlyingToken { address symbol }
      supplyInfo { liquidationThreshold { value } }
    }
  }
}`;

interface AmountNode {
  amount?: { value?: string | number | null } | null;
  usd?: string | number | null;
  usdPerToken?: string | number | null;
}

interface SupplyNode {
  currency?: { symbol?: string | null; address?: string | null } | null;
  balance?: AmountNode | null;
  apy?: { value?: string | number | null } | null;
  isCollateral?: boolean | null;
}

interface BorrowNode {
  currency?: { symbol?: string | null; address?: string | null } | null;
  debt?: AmountNode | null;
  apy?: { value?: string | number | null } | null;
}

interface GraphError {
  message?: string;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeHealthFactor(value: unknown): number | null {
  if (value == null || value === "") return null;
  let parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (parsed > 1e15) parsed = parsed / 1e18;
  if (parsed > 100) return null;
  return parsed;
}

function thresholdRatio(value: unknown): number | null {
  const parsed = num(value);
  if (parsed <= 0) return null;
  if (parsed > 1.5 && parsed <= 100) return parsed / 100;
  if (parsed > 100) return null;
  return parsed;
}

let reserveCache: { at: number; byAddress: Map<string, number> } | null = null;

async function liquidationThresholds(): Promise<Map<string, number>> {
  const now = Date.now();
  if (reserveCache && now - reserveCache.at < 120_000) return reserveCache.byAddress;
  const body = await fetchJson<{
    data?: {
      markets?: Array<{
        address?: string;
        reserves?: Array<{
          underlyingToken?: { address?: string };
          supplyInfo?: { liquidationThreshold?: { value?: string | number } };
        }>;
      }>;
    };
    errors?: GraphError[];
  }>(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: RESERVES_QUERY }),
  });
  if (body.errors?.length && !body.data?.markets) {
    throw new Error(body.errors.map((error) => error.message).filter(Boolean).join("; "));
  }
  const byAddress = new Map<string, number>();
  for (const market of body.data?.markets ?? []) {
    if (market.address?.toLowerCase() !== ETHEREUM_POOL.toLowerCase()) continue;
    for (const reserve of market.reserves ?? []) {
      const address = reserve.underlyingToken?.address?.toLowerCase();
      const threshold = thresholdRatio(reserve.supplyInfo?.liquidationThreshold?.value);
      if (address && threshold != null) byAddress.set(address, threshold);
    }
  }
  reserveCache = { at: now, byAddress };
  return byAddress;
}

function legFromAmount(
  side: "supply" | "borrow",
  symbol: string,
  tokenAddress: string | undefined,
  node: AmountNode | null | undefined,
  apy: number,
  isCollateral: boolean | undefined,
  thresholds: Map<string, number>,
): Leg | null {
  const amount = num(node?.amount?.value);
  const usd = num(node?.usd);
  if (amount <= 0 && usd <= 0) return null;
  const kind = assetKind(symbol);
  const underlying = underlyingOf(symbol);
  const protocolThreshold = tokenAddress ? thresholds.get(tokenAddress.toLowerCase()) : undefined;
  const price = num(node?.usdPerToken) || (amount > 0 ? usd / amount : undefined);
  return {
    id: `${side}-${symbol}-${tokenAddress ?? underlying}`,
    side,
    symbol,
    underlying,
    kind,
    amount,
    usd,
    apy,
    priceUsd: price && price > 0 ? price : undefined,
    isCollateral: side === "supply" ? isCollateral !== false : undefined,
    liquidationThreshold:
      side === "supply"
        ? (protocolThreshold ?? assumedLiquidationThreshold(kind))
        : undefined,
    liquidationThresholdSource:
      side === "supply" ? (protocolThreshold != null ? "protocol" : "assumed") : undefined,
  };
}

export function mapAaveLegs(
  supplies: SupplyNode[],
  borrows: BorrowNode[],
  thresholds: Map<string, number>,
): Leg[] {
  const legs: Leg[] = [];
  for (const supply of supplies) {
    const symbol = supply.currency?.symbol?.trim();
    if (!symbol) continue;
    const leg = legFromAmount(
      "supply",
      symbol,
      supply.currency?.address ?? undefined,
      supply.balance,
      num(supply.apy?.value),
      supply.isCollateral ?? undefined,
      thresholds,
    );
    if (leg) legs.push(leg);
  }
  for (const borrow of borrows) {
    const symbol = borrow.currency?.symbol?.trim();
    if (!symbol) continue;
    const leg = legFromAmount(
      "borrow",
      symbol,
      borrow.currency?.address ?? undefined,
      borrow.debt,
      num(borrow.apy?.value),
      undefined,
      thresholds,
    );
    if (leg) legs.push(leg);
  }
  return legs;
}

async function graphql<T>(query: string, variables: Record<string, string>): Promise<T> {
  const body = await fetchJson<{ data?: T; errors?: GraphError[] }>(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (body.errors?.length && !body.data) {
    throw new Error(body.errors.map((error) => error.message).filter(Boolean).join("; ") || "Aave query failed");
  }
  if (!body.data) throw new Error("Aave returned an empty payload");
  return body.data;
}

export async function fetchAave(address: string): Promise<ProtocolFetch> {
  const meta = protocolMeta("aave");
  const base = { id: meta.id, name: meta.name, chain: meta.chain, positions: [] as Position[], spot: [] };
  const wallet = address.trim();
  if (!wallet) return { ...base, status: "skipped", message: "No EVM address saved." };
  if (!isEvmAddress(wallet)) {
    return { ...base, status: "error", message: "That does not look like an EVM address." };
  }
  try {
    const [positions, state, thresholds] = await Promise.all([
      graphql<{ userSupplies?: SupplyNode[]; userBorrows?: BorrowNode[] }>(POSITIONS_QUERY, {
        user: wallet,
        market: ETHEREUM_POOL,
      }),
      graphql<{ userMarketState?: { healthFactor?: string | number | null } }>(STATE_QUERY, {
        user: wallet,
        market: ETHEREUM_POOL,
      }).catch(() => ({ userMarketState: undefined })),
      liquidationThresholds(),
    ]);
    const legs = mapAaveLegs(positions.userSupplies ?? [], positions.userBorrows ?? [], thresholds);
    if (legs.length === 0) {
      return { ...base, status: "ok", message: "No Aave v3 Ethereum supply or borrow for this address." };
    }
    const health = normalizeHealthFactor(state.userMarketState?.healthFactor);
    const position: Position = {
      id: `aave:${wallet.toLowerCase()}`,
      protocol: "aave",
      chain: meta.chain,
      wallet,
      label: "Aave v3 Ethereum",
      source: "live",
      legs,
      healthFactor: health,
      healthFactorSource: health != null ? "protocol" : "estimated",
      fetchedAt: new Date().toISOString(),
      note: "Supply and borrow APY from the Aave v3 GraphQL API. Health factor is the protocol figure when it is present.",
    };
    return { ...base, status: "ok", positions: [position] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Aave request failed";
    return { ...base, status: "error", message: `Aave Ethereum could not be loaded. ${message}` };
  }
}
