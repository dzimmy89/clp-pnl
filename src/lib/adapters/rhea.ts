import { isNearAccount } from "@/lib/addresses";
import { assetKind, assumedLiquidationThreshold, underlyingOf } from "@/lib/assets";
import { fetchJson } from "@/lib/http";
import { nearView } from "@/lib/adapters/near";
import { fetchPriceBook, priceForSymbol, symbolToLlamaKey, type PriceBook } from "@/lib/adapters/prices";
import { protocolMeta, type Leg, type Position, type ProtocolFetch } from "@/lib/types";

interface BurrowPosition {
  apr?: string;
  balance?: string;
  token_id?: string;
}

interface BurrowAccount {
  code?: string;
  data?: {
    supplied?: BurrowPosition[];
    collateral?: BurrowPosition[];
    borrowed?: BurrowPosition[];
  };
  message?: string;
}

interface FtMetadata {
  symbol?: string;
  decimals?: number;
}

const BURROW_CONTRACT = "contract.main.burrow.near";

const metadataCache = new Map<string, FtMetadata>();
const extraDecimalsCache = new Map<string, number>();

interface BurrowAsset {
  config?: { extra_decimals?: number };
}

/**
 * Burrow keeps every balance in the token's own decimals plus the asset's `extra_decimals`
 * (12 for a 6-decimal stable, 0 for 24-decimal NEAR), so the account API's figures are that
 * much larger than the token amount. Read from the contract; when that fails, pad to 18.
 */
async function extraDecimals(tokenId: string, decimals: number): Promise<number> {
  const cached = extraDecimalsCache.get(tokenId);
  if (cached != null) return cached;
  let extra = decimals < 18 ? 18 - decimals : 0;
  try {
    const asset = await nearView<BurrowAsset>(BURROW_CONTRACT, "get_asset", { token_id: tokenId });
    if (typeof asset.config?.extra_decimals === "number") extra = asset.config.extra_decimals;
  } catch {}
  extraDecimalsCache.set(tokenId, extra);
  return extra;
}

async function tokenMeta(tokenId: string): Promise<FtMetadata> {
  const cached = metadataCache.get(tokenId);
  if (cached) return cached;
  try {
    const meta = await nearView<FtMetadata>(tokenId, "ft_metadata", {});
    const stored = { symbol: meta.symbol, decimals: meta.decimals };
    metadataCache.set(tokenId, stored);
    return stored;
  } catch {
    const fallback = { symbol: tokenId.split(".")[0]?.toUpperCase(), decimals: 18 };
    metadataCache.set(tokenId, fallback);
    return fallback;
  }
}

export function burrowUnits(balance: string | undefined, decimals: number): number {
  if (!balance) return 0;
  try {
    const raw = BigInt(balance.split(".")[0] || "0");
    const base = 10n ** BigInt(decimals);
    const scale = 1_000_000n;
    return Number(raw / base) + Number(((raw % base) * scale) / base) / 1e6;
  } catch {
    return 0;
  }
}

/** Bridged tokens (USDT.e, USDC.e) price as the token they wrap. */
export function priceSymbol(symbol: string): string {
  return symbol.replace(/\.e$/i, "");
}

function priceOf(prices: PriceBook, symbol: string): number {
  const stripped = priceSymbol(symbol);
  return priceForSymbol(prices, symbol) ?? priceForSymbol(prices, stripped) ?? priceForSymbol(prices, underlyingOf(stripped)) ?? 0;
}

export async function fetchRhea(account: string): Promise<ProtocolFetch> {
  const meta = protocolMeta("rhea");
  const base = { id: meta.id, name: meta.name, chain: meta.chain, positions: [] as Position[], spot: [] };
  const wallet = account.trim().toLowerCase();
  if (!wallet) return { ...base, status: "skipped", message: "No NEAR account saved." };
  if (!isNearAccount(wallet)) {
    return { ...base, status: "error", message: "That does not look like a NEAR account." };
  }
  try {
    const body = await fetchJson<BurrowAccount>(
      `https://api.burrow.finance/get_account/${encodeURIComponent(wallet)}`,
    );
    if (body.code && body.code !== "0") {
      throw new Error(body.message || `Burrow API code ${body.code}`);
    }
    const supplied = body.data?.supplied ?? [];
    const collateral = body.data?.collateral ?? [];
    const borrowed = body.data?.borrowed ?? [];
    const tokenIds = [
      ...new Set(
        [...supplied, ...collateral, ...borrowed]
          .map((row) => row.token_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const metas = await Promise.all(
      tokenIds.map(async (id) => {
        const meta = await tokenMeta(id);
        const decimals = meta.decimals ?? 18;
        return [id, { ...meta, decimals: decimals + (await extraDecimals(id, decimals)) }] as const;
      }),
    );
    const metaById = new Map(metas);
    // Tokens the default price book lacks (stNEAR, say) are fetched by their CoinGecko id.
    const extraKeys = [...metaById.values()]
      .map((meta) => (meta.symbol ? symbolToLlamaKey(priceSymbol(meta.symbol)) : null))
      .filter((key): key is string => key != null);
    const prices = await fetchPriceBook(extraKeys);
    const legs: Leg[] = [];
    const pushSupply = (row: BurrowPosition, bucket: string) => {
      if (!row.token_id) return;
      const token = metaById.get(row.token_id);
      const symbol = token?.symbol || row.token_id;
      const decimals = token?.decimals ?? 18;
      const amount = burrowUnits(row.balance, decimals);
      if (!(amount > 0)) return;
      const kind = assetKind(symbol);
      const price = priceOf(prices, symbol);
      legs.push({
        id: `${bucket}-${row.token_id}`,
        side: "supply",
        symbol,
        underlying: underlyingOf(symbol),
        kind,
        amount,
        usd: amount * price,
        apy: Number(row.apr ?? 0) || 0,
        priceUsd: price > 0 ? price : undefined,
        isCollateral: true,
        liquidationThreshold: assumedLiquidationThreshold(kind),
        liquidationThresholdSource: "assumed",
      });
    };
    for (const row of supplied) pushSupply(row, "supplied");
    for (const row of collateral) pushSupply(row, "collateral");
    for (const row of borrowed) {
      if (!row.token_id) continue;
      const token = metaById.get(row.token_id);
      const symbol = token?.symbol || row.token_id;
      const decimals = token?.decimals ?? 18;
      const amount = burrowUnits(row.balance, decimals);
      if (!(amount > 0)) continue;
      const kind = assetKind(symbol);
      const price = priceOf(prices, symbol);
      legs.push({
        id: `borrow-${row.token_id}`,
        side: "borrow",
        symbol,
        underlying: underlyingOf(symbol),
        kind,
        amount,
        usd: amount * price,
        apy: Number(row.apr ?? 0) || 0,
        priceUsd: price > 0 ? price : undefined,
      });
    }
    if (legs.length === 0) {
      return { ...base, status: "ok", message: "No Rhea (Burrow) supply or borrow for this account." };
    }
    const position: Position = {
      id: `rhea:${wallet}`,
      protocol: "rhea",
      chain: meta.chain,
      wallet,
      label: "Rhea Finance",
      source: "live",
      legs,
      healthFactor: null,
      healthFactorSource: "estimated",
      fetchedAt: new Date().toISOString(),
      note: "Balances from the Burrow account API, which Rhea still serves. The published APR is used as the annual rate and is not compounded. Health factor uses an assumed liquidation threshold because this endpoint does not return one. Supplied and collateral buckets are both included; Burrow keeps them separate.",
    };
    return { ...base, status: "ok", positions: [position] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rhea request failed";
    return { ...base, status: "error", message: `Rhea could not be loaded. ${message}` };
  }
}
