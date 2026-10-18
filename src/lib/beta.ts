import type { BookRow } from "@/lib/metrics";
import { netsFromLegs } from "@/lib/metrics";
import type { AssetKind, Position, SpotHolding } from "@/lib/types";

/**
 * BTC beta: how much an asset tends to move for a 1% move in BTC, from daily returns.
 * Beta-weighting turns every position into "BTC-equivalent" exposure, so a book of ETH,
 * SOL and SUI can be compared with, and hedged against, BTC alone.
 */

export interface AssetBeta {
  beta: number;
  /** Correlation of daily returns with BTC, -1 to 1. Null when not measured. */
  correlation: number | null;
  /** Daily returns the estimate used. 0 for fixed or assumed values. */
  days: number;
  /** history: measured; fixed: by definition (BTC, stables) or the example book; assumed: no data, beta 1. */
  source: "history" | "fixed" | "assumed";
}

export type BetaBook = Record<string, AssetBeta>;

/** Lookback for the estimate, in days. */
export const BETA_WINDOW_DAYS = 90;

/** CoinGecko ids DefiLlama prices by. Keys are underlyings as `underlyingOf` returns them. */
export const BETA_COINGECKO: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  HYPE: "hyperliquid",
  NEAR: "near",
  SUI: "sui",
  APT: "aptos",
  TON: "the-open-network",
  TRX: "tron",
  ATOM: "cosmos",
  OSMO: "osmosis",
  TIA: "celestia",
  DYDX: "dydx-chain",
  NTRN: "neutron-3",
  AKT: "akash-network",
  STRK: "starknet",
  ADA: "cardano",
  KAS: "kaspa",
  AVAX: "avalanche-2",
  POL: "polygon-ecosystem-token",
  MATIC: "polygon-ecosystem-token",
  ARB: "arbitrum",
  OP: "optimism",
  LINK: "chainlink",
  UNI: "uniswap",
  AAVE: "aave",
  MKR: "maker",
  LDO: "lido-dao",
  CRV: "curve-dao-token",
  PENDLE: "pendle",
  ENA: "ethena",
  JUP: "jupiter-exchange-solana",
  JTO: "jito-governance-token",
  PYTH: "pyth-network",
  RAY: "raydium",
  BONK: "bonk",
  WIF: "dogwifcoin",
  DOGE: "dogecoin",
  XRP: "ripple",
  LTC: "litecoin",
  DOT: "polkadot",
  INJ: "injective-protocol",
  SEI: "sei-network",
  MNT: "mantle",
  S: "sonic-3",
  BERA: "berachain-bera",
  CAKE: "pancakeswap-token",
  XVS: "venus",
  JST: "just",
  SUN: "sun-token",
  NAVX: "navi",
  SCA: "scallop-2",
  CETUS: "cetus-protocol",
  DEEP: "deep",
  EVAA: "evaa-protocol",
  STON: "ston-2",
  EKUBO: "ekubo-protocol",
  MIN: "minswap",
  SNEK: "snek",
};

/** Staked and wrapped tokens that track a base asset closely enough to share its beta. */
const TRACKS: Record<string, string> = {
  STETH: "ETH",
  WSTETH: "ETH",
  RETH: "ETH",
  CBETH: "ETH",
  WEETH: "ETH",
  EZETH: "ETH",
  RSETH: "ETH",
  METH: "ETH",
  JITOSOL: "SOL",
  MSOL: "SOL",
  JUPSOL: "SOL",
  BSOL: "SOL",
  INF: "SOL",
  BNSOL: "SOL",
  HASUI: "SUI",
  AFSUI: "SUI",
  VSUI: "SUI",
  SPRINGSUI: "SUI",
  STAPT: "APT",
  THAPT: "APT",
  AMAPT: "APT",
  TSTON: "TON",
  STTON: "TON",
  HTON: "TON",
  STRX: "TRX",
  STATOM: "ATOM",
  STTIA: "TIA",
  STOSMO: "OSMO",
  XSTRK: "STRK",
  SSTRK: "STRK",
  NSTSTRK: "STRK",
  STNEAR: "NEAR",
  LINEAR: "NEAR",
  KHYPE: "HYPE",
  STHYPE: "HYPE",
  WAVAX: "AVAX",
  SAVAX: "AVAX",
  WTRX: "TRX",
  WAPT: "APT",
};

/** The asset whose price history decides this underlying's beta. */
export function betaBase(underlying: string): string {
  return TRACKS[underlying] ?? underlying;
}

/** Fixed betas for the example book, so it reads the same online and off. */
export const EXAMPLE_BETAS: BetaBook = {
  ETH: { beta: 1.18, correlation: 0.84, days: BETA_WINDOW_DAYS, source: "fixed" },
  SOL: { beta: 1.42, correlation: 0.78, days: BETA_WINDOW_DAYS, source: "fixed" },
  HYPE: { beta: 1.65, correlation: 0.55, days: BETA_WINDOW_DAYS, source: "fixed" },
  BNB: { beta: 0.72, correlation: 0.71, days: BETA_WINDOW_DAYS, source: "fixed" },
  NEAR: { beta: 1.35, correlation: 0.76, days: BETA_WINDOW_DAYS, source: "fixed" },
};

/**
 * Beta for one underlying. BTC-like assets are 1 and stables 0 by definition; anything
 * without a measured value is assumed to move one-for-one with BTC.
 */
export function betaOf(underlying: string, kind: AssetKind, betas: BetaBook): AssetBeta {
  if (kind === "btc" || underlying === "BTC") return { beta: 1, correlation: 1, days: 0, source: "fixed" };
  if (kind === "stable") return { beta: 0, correlation: null, days: 0, source: "fixed" };
  return betas[underlying] ?? betas[betaBase(underlying)] ?? { beta: 1, correlation: null, days: 0, source: "assumed" };
}

/** Beta and correlation of `asset` against `btc` from two aligned daily price series. */
export function betaFromPrices(asset: number[], btc: number[]): { beta: number; correlation: number; days: number } | null {
  const n = Math.min(asset.length, btc.length);
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < n; i++) {
    if (!(asset[i - 1] > 0 && asset[i] > 0 && btc[i - 1] > 0 && btc[i] > 0)) continue;
    ra.push(Math.log(asset[i] / asset[i - 1]));
    rb.push(Math.log(btc[i] / btc[i - 1]));
  }
  // Under a month of returns is too noisy to call a beta.
  if (ra.length < 30) return null;
  const mean = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const ma = mean(ra);
  const mb = mean(rb);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  if (!(vb > 0)) return null;
  return { beta: cov / vb, correlation: va > 0 ? cov / Math.sqrt(va * vb) : 0, days: ra.length };
}

export interface BetaExposure {
  /** Σ net USD × beta: the BTC-equivalent dollars this book moves with. */
  betaUsd: number;
  /** betaUsd in BTC units. */
  betaBtc: number;
  /** betaUsd ÷ equity: how many % the equity moves for a 1% BTC move. Null without positive equity. */
  beta: number | null;
  /** Share of |net| exposure whose beta is assumed rather than measured. */
  assumedShare: number;
  /** Net USD the beta is measured against. */
  equity: number;
}

function exposure(lines: { underlying: string; kind: AssetKind; netUsd: number }[], equity: number, betas: BetaBook, btcPrice: number): BetaExposure {
  let betaUsd = 0;
  let gross = 0;
  let assumed = 0;
  for (const line of lines) {
    const b = betaOf(line.underlying, line.kind, betas);
    betaUsd += line.netUsd * b.beta;
    if (line.kind !== "stable") {
      gross += Math.abs(line.netUsd);
      if (b.source === "assumed") assumed += Math.abs(line.netUsd);
    }
  }
  return {
    betaUsd,
    betaBtc: btcPrice > 0 ? betaUsd / btcPrice : 0,
    beta: equity > 0 ? betaUsd / equity : null,
    assumedShare: gross > 0 ? assumed / gross : 0,
    equity,
  };
}

export function positionBeta(position: Position, betas: BetaBook, btcPrice: number): BetaExposure {
  const nets = netsFromLegs(position.legs);
  const equity = nets.reduce((sum, net) => sum + net.netUsd, 0);
  return exposure(nets, equity, betas, btcPrice);
}

export function spotBeta(spot: SpotHolding[], betas: BetaBook, btcPrice: number): BetaExposure {
  const lines = spot.filter((holding) => !holding.unpriced).map((holding) => ({ underlying: holding.underlying, kind: holding.kind, netUsd: holding.usd }));
  return exposure(lines, lines.reduce((sum, line) => sum + line.netUsd, 0), betas, btcPrice);
}

/** The whole book: every position plus wallet balances, against total net worth. */
export function bookBeta(rows: BookRow[], spot: SpotHolding[], betas: BetaBook, btcPrice: number): BetaExposure {
  const lines = [
    ...rows.flatMap((row) => netsFromLegs(row.position.legs)),
    ...spot.filter((holding) => !holding.unpriced).map((holding) => ({ underlying: holding.underlying, kind: holding.kind, netUsd: holding.usd })),
  ];
  const equity = lines.reduce((sum, line) => sum + line.netUsd, 0);
  return exposure(lines, equity, betas, btcPrice);
}

/** Underlyings worth measuring: non-stable, not BTC, deduplicated to their base asset. */
export function betaTargets(positions: Position[], spot: SpotHolding[]): string[] {
  const out = new Set<string>();
  const add = (underlying: string, kind: AssetKind) => {
    if (kind === "stable" || kind === "btc") return;
    const base = betaBase(underlying);
    if (BETA_COINGECKO[base]) out.add(base);
  };
  for (const position of positions) for (const leg of position.legs) add(leg.underlying, leg.kind);
  for (const holding of spot) add(holding.underlying, holding.kind);
  return [...out].sort();
}
