import { bsc } from "viem/chains";
import { createPublicClient, formatUnits, http, parseAbi } from "viem";
import { isEvmAddress } from "@/lib/addresses";
import { assetKind, assumedLiquidationThreshold, underlyingOf } from "@/lib/assets";
import { fetchJson } from "@/lib/http";
import { priceForSymbol, fetchPriceBook } from "@/lib/adapters/prices";
import { protocolMeta, type Leg, type Position, type ProtocolFetch } from "@/lib/types";

const vTokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function borrowBalanceStored(address) view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
]);

interface VenusMarket {
  address: string;
  symbol: string | null;
  underlyingSymbol: string | null;
  underlyingDecimal: number | null;
  underlyingAddress: string | null;
  supplyApyDecimal: string | null;
  borrowApyDecimal: string | null;
  totalSupplyApyDecimal: string | null;
  totalBorrowApyDecimal: string | null;
  tokenPriceCents: number | string | null;
  collateralFactorMantissa: string | null;
  liquidationThresholdMantissa: string | null;
  isListed: boolean;
}

interface VenusPage {
  result?: VenusMarket[];
  total?: number;
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratioFromMantissa(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  if (parsed > 10) return parsed / 1e18;
  return parsed;
}

function marketPrice(market: VenusMarket): number {
  const cents = num(market.tokenPriceCents);
  if (cents <= 0) return 0;
  return cents / 100;
}

async function listedMarkets(): Promise<VenusMarket[]> {
  const markets: VenusMarket[] = [];
  for (let page = 0; page < 5; page += 1) {
    const body = await fetchJson<VenusPage>(
      `https://api.venus.io/markets?chainId=56&limit=100&page=${page}`,
    );
    const batch = body.result ?? [];
    markets.push(...batch.filter((market) => market.isListed && market.address));
    if (batch.length < 100) break;
  }
  return markets;
}

export async function fetchVenus(address: string): Promise<ProtocolFetch> {
  const meta = protocolMeta("venus");
  const base = { id: meta.id, name: meta.name, chain: meta.chain, positions: [] as Position[], spot: [] };
  const wallet = address.trim();
  if (!wallet) return { ...base, status: "skipped", message: "No EVM address saved." };
  if (!isEvmAddress(wallet)) {
    return { ...base, status: "error", message: "That does not look like an EVM address." };
  }
  try {
    const markets = await listedMarkets();
    if (markets.length === 0) {
      return { ...base, status: "error", message: "Venus returned no listed BNB Chain markets." };
    }
    const client = createPublicClient({ chain: bsc, transport: http("https://bsc-rpc.publicnode.com") });
    const user = wallet as `0x${string}`;
    const calls = markets.flatMap((market) => {
      const vToken = market.address as `0x${string}`;
      return [
        { address: vToken, abi: vTokenAbi, functionName: "balanceOf" as const, args: [user] as const },
        { address: vToken, abi: vTokenAbi, functionName: "borrowBalanceStored" as const, args: [user] as const },
        { address: vToken, abi: vTokenAbi, functionName: "exchangeRateStored" as const },
      ];
    });
    type Call = { status: "success"; result: bigint } | { status: "failure"; error: Error };
    const results: Call[] = [];
    for (let offset = 0; offset < calls.length; offset += 60) {
      const part = (await client.multicall({
        allowFailure: true,
        contracts: calls.slice(offset, offset + 60),
      })) as Call[];
      results.push(...part);
    }
    const prices = await fetchPriceBook();
    const legs: Leg[] = [];
    markets.forEach((market, index) => {
      const balance = results[index * 3];
      const debt = results[index * 3 + 1];
      const rate = results[index * 3 + 2];
      if (!balance || balance.status !== "success" || !debt || debt.status !== "success") return;
      const symbol = market.underlyingSymbol || (market.symbol?.replace(/^v/, "") ?? "UNKNOWN");
      const kind = assetKind(symbol);
      const decimals = market.underlyingDecimal ?? 18;
      const price = marketPrice(market) || priceForSymbol(prices, symbol) || 0;
      const supplyApy = num(market.totalSupplyApyDecimal || market.supplyApyDecimal);
      const borrowApy = num(market.totalBorrowApyDecimal || market.borrowApyDecimal);
      const threshold =
        ratioFromMantissa(market.liquidationThresholdMantissa) ??
        ratioFromMantissa(market.collateralFactorMantissa);
      if (balance.result > 0n && rate?.status === "success" && rate.result > 0n) {
        const underlyingRaw = (balance.result * rate.result) / 10n ** 18n;
        const amount = Number(formatUnits(underlyingRaw, decimals));
        if (amount > 0) {
          legs.push({
            id: `supply-${market.address}`,
            side: "supply",
            symbol,
            underlying: underlyingOf(symbol),
            kind,
            amount,
            usd: amount * price,
            apy: supplyApy,
            priceUsd: price > 0 ? price : undefined,
            isCollateral: true,
            liquidationThreshold: threshold ?? assumedLiquidationThreshold(kind),
            liquidationThresholdSource: threshold != null ? "protocol" : "assumed",
          });
        }
      }
      if (debt.result > 0n) {
        const amount = Number(formatUnits(debt.result, decimals));
        if (amount > 0) {
          legs.push({
            id: `borrow-${market.address}`,
            side: "borrow",
            symbol,
            underlying: underlyingOf(symbol),
            kind,
            amount,
            usd: amount * price,
            apy: borrowApy,
            priceUsd: price > 0 ? price : undefined,
          });
        }
      }
    });
    if (legs.length === 0) {
      return { ...base, status: "ok", message: "No Venus BNB Chain supply or borrow for this address." };
    }
    const position: Position = {
      id: `venus:${wallet.toLowerCase()}`,
      protocol: "venus",
      chain: meta.chain,
      wallet,
      label: "Venus BNB Chain",
      source: "live",
      legs,
      healthFactor: null,
      healthFactorSource: "estimated",
      fetchedAt: new Date().toISOString(),
      note: "Balances are on-chain. APY and prices come from the Venus API. Health factor is estimated from the liquidation threshold, or the collateral factor when Venus does not publish a threshold.",
    };
    return { ...base, status: "ok", positions: [position] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Venus request failed";
    return { ...base, status: "error", message: `Venus could not be loaded. ${message}` };
  }
}
