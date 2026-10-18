import { isSolanaAddress } from "@/lib/addresses";
import { assetKind, assumedLiquidationThreshold, underlyingOf } from "@/lib/assets";
import { fetchJson } from "@/lib/http";
import { protocolMeta, type Leg, type Position, type ProtocolFetch } from "@/lib/types";

const MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const SF = 2n ** 60n;

interface ReserveMetric {
  reserve: string;
  liquidityToken: string;
  borrowApy: string | number;
  supplyApy: string | number;
  totalSupply: string | number;
  totalSupplyUsd: string | number;
  totalBorrow: string | number;
  totalBorrowUsd: string | number;
}

interface ObligationDeposit {
  depositReserve: string;
  depositedAmount: string;
  marketValueSf: string;
}

interface ObligationBorrow {
  borrowReserve: string;
  borrowedAmountSf: string;
  marketValueSf: string;
}

interface Obligation {
  obligationAddress: string;
  state?: {
    deposits?: ObligationDeposit[];
    borrows?: ObligationBorrow[];
  };
  refreshedStats?: {
    userTotalBorrow?: string | number;
    borrowLiquidationLimit?: string | number;
    liquidationLtv?: string | number;
    userTotalDeposit?: string | number;
  };
}

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sfToNumber(value: string | number): number {
  const whole = String(value).split(".")[0] || "0";
  let raw: bigint;
  try {
    raw = BigInt(whole);
  } catch {
    return 0;
  }
  if (raw === 0n) return 0;
  const negative = raw < 0n;
  const magnitude = negative ? -raw : raw;
  const scaled = (magnitude * 1_000_000_000_000n) / SF;
  const result = Number(scaled) / 1e12;
  return negative ? -result : result;
}

export function amountFromRaw(raw: number, usdHint: number, price: number): number {
  if (!(raw > 0)) return 0;
  if (price > 0 && usdHint > 0) {
    const humanGuess = usdHint / price;
    if (humanGuess > 0) {
      const decimals = Math.round(Math.log10(raw / humanGuess));
      if (decimals >= 0 && decimals <= 18) {
        const amount = raw / 10 ** decimals;
        const marked = amount * price;
        if (Math.abs(marked - usdHint) / usdHint < 0.35) return amount;
      }
    }
    return usdHint / price;
  }
  return 0;
}

function reservePrice(reserve: ReserveMetric | undefined): number {
  if (!reserve) return 0;
  const supply = num(reserve.totalSupply);
  const supplyUsd = num(reserve.totalSupplyUsd);
  if (supply > 0 && supplyUsd > 0) return supplyUsd / supply;
  const borrowed = num(reserve.totalBorrow);
  const borrowedUsd = num(reserve.totalBorrowUsd);
  if (borrowed > 0 && borrowedUsd > 0) return borrowedUsd / borrowed;
  return 0;
}

export function legsFromObligation(
  obligation: Obligation,
  reserves: Map<string, ReserveMetric>,
): Leg[] {
  const statsLt = num(obligation.refreshedStats?.liquidationLtv);
  const positionLt = statsLt > 0 && statsLt <= 1 ? statsLt : null;
  const legs: Leg[] = [];
  for (const deposit of obligation.state?.deposits ?? []) {
    const raw = num(deposit.depositedAmount);
    if (raw <= 0) continue;
    const reserve = reserves.get(deposit.depositReserve);
    if (!reserve) continue;
    const symbol = reserve.liquidityToken;
    const kind = assetKind(symbol);
    const price = reservePrice(reserve);
    const staleUsd = sfToNumber(deposit.marketValueSf);
    const amount = amountFromRaw(raw, staleUsd, price);
    if (!(amount > 0)) continue;
    const usd = price > 0 ? amount * price : staleUsd;
    const threshold = positionLt ?? assumedLiquidationThreshold(kind);
    legs.push({
      id: `supply-${deposit.depositReserve}`,
      side: "supply",
      symbol,
      underlying: underlyingOf(symbol),
      kind,
      amount,
      usd,
      apy: num(reserve.supplyApy),
      priceUsd: price > 0 ? price : undefined,
      isCollateral: true,
      liquidationThreshold: threshold,
      liquidationThresholdSource: positionLt != null ? "protocol" : "assumed",
    });
  }
  for (const borrow of obligation.state?.borrows ?? []) {
    const raw = sfToNumber(borrow.borrowedAmountSf);
    if (raw <= 0) continue;
    const reserve = reserves.get(borrow.borrowReserve);
    if (!reserve) continue;
    const symbol = reserve.liquidityToken;
    const kind = assetKind(symbol);
    const price = reservePrice(reserve);
    const staleUsd = sfToNumber(borrow.marketValueSf);
    const amount = amountFromRaw(raw, staleUsd, price);
    if (!(amount > 0)) continue;
    const usd = price > 0 ? amount * price : staleUsd;
    legs.push({
      id: `borrow-${borrow.borrowReserve}`,
      side: "borrow",
      symbol,
      underlying: underlyingOf(symbol),
      kind,
      amount,
      usd,
      apy: num(reserve.borrowApy),
      priceUsd: price > 0 ? price : undefined,
    });
  }
  return legs;
}

function healthFactor(obligation: Obligation): number | null {
  const debt = num(obligation.refreshedStats?.userTotalBorrow);
  const limit = num(obligation.refreshedStats?.borrowLiquidationLimit);
  if (!(debt > 0) || !(limit > 0)) return null;
  const hf = limit / debt;
  if (!Number.isFinite(hf) || hf > 100) return null;
  return hf;
}

export async function fetchKamino(address: string): Promise<ProtocolFetch> {
  const meta = protocolMeta("kamino");
  const base = { id: meta.id, name: meta.name, chain: meta.chain, positions: [] as Position[], spot: [] };
  const wallet = address.trim();
  if (!wallet) return { ...base, status: "skipped", message: "No Solana address saved." };
  if (!isSolanaAddress(wallet)) {
    return { ...base, status: "error", message: "That does not look like a Solana address." };
  }
  try {
    const [obligations, reserveList] = await Promise.all([
      fetchJson<Obligation[]>(
        `https://api.kamino.finance/kamino-market/${MAIN_MARKET}/users/${wallet}/obligations`,
      ),
      fetchJson<ReserveMetric[]>(
        `https://api.kamino.finance/kamino-market/${MAIN_MARKET}/reserves/metrics`,
      ),
    ]);
    const reserves = new Map(reserveList.map((reserve) => [reserve.reserve, reserve]));
    const positions: Position[] = [];
    for (const obligation of obligations) {
      const legs = legsFromObligation(obligation, reserves);
      if (legs.length === 0) continue;
      const hf = healthFactor(obligation);
      positions.push({
        id: `kamino:${obligation.obligationAddress}`,
        protocol: "kamino",
        chain: meta.chain,
        wallet,
        label: "Kamino main market",
        source: "live",
        legs,
        healthFactor: hf,
        healthFactorSource: hf != null ? "protocol" : "estimated",
        fetchedAt: new Date().toISOString(),
        note: "Main Kamino Lend market. Health factor is liquidation limit divided by debt from Kamino's refreshed stats. Other Kamino markets are not queried.",
      });
    }
    if (positions.length === 0) {
      return {
        ...base,
        status: "ok",
        message: "No obligation in the main Kamino Lend market for this address.",
      };
    }
    return { ...base, status: "ok", positions };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kamino request failed";
    return { ...base, status: "error", message: `Kamino could not be loaded. ${message}` };
  }
}
