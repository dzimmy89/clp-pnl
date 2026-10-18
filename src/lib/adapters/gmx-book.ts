import { assetKind, underlyingOf } from "@/lib/assets";
import type { Leg } from "@/lib/types";

/**
 * Turns one GMX V2 perp into book legs. Kept free of chain code so the mapping and the
 * health factor can be tested on their own.
 *
 * GMX liquidates when collateral + PnL < size × minCollateralFactor (fees, funding and
 * price impact aside). With P the index price, S the size in tokens, E the entry notional
 * (sizeInUsd), C the collateral and f the factor: a long needs P·S·(1 − f) + C ≥ E, which the
 * index leg's threshold (1 − f) expresses directly, so the estimated health factor is GMX's
 * line; a short needs C + E ≥ P·S·(1 + f), so the reported health factor (C + E) / (P·S·(1 + f))
 * puts the thresholds on the protocol's scale. Either way the joint liquidation solve lands
 * on the price where GMX would liquidate.
 */

export interface GmxPosition {
  key: string;
  market: string;
  collateralToken: string;
  isLong: boolean;
  /** USD, from the 1e30-scaled sizeInUsd. */
  sizeUsd: number;
  /** Index token units. */
  sizeInTokens: number;
  /** Collateral token units. */
  collateralAmount: number;
}

export interface GmxMarket {
  market: string;
  indexToken: string;
  indexSymbol: string;
  indexDecimals: number;
  /** Decimal fraction of size the position must keep as collateral, e.g. 0.005. */
  minCollateralFactor: number;
}

export interface GmxTokenInfo {
  symbol: string;
  decimals: number;
}

export interface GmxBookInput {
  position: GmxPosition;
  market: GmxMarket;
  collateral: GmxTokenInfo;
  indexPrice: number;
  collateralPrice: number;
}

export interface GmxBook {
  legs: Leg[];
  healthFactor: number | null;
  entryPrice: number;
  /** Size over collateral, the leverage GMX shows. */
  leverage: number | null;
  /** Unrealised PnL in USD at the index price. */
  pnlUsd: number;
}

export function gmxPositionBook(input: GmxBookInput): GmxBook {
  const { position, market, collateral, indexPrice, collateralPrice } = input;
  const size = position.sizeInTokens;
  const entryPrice = size > 0 ? position.sizeUsd / size : 0;
  const f = Math.min(Math.max(market.minCollateralFactor, 0), 0.5);
  const indexSymbol = market.indexSymbol;
  const collateralUsd = position.collateralAmount * collateralPrice;
  const notional = size * indexPrice;
  const unrated = { apy: 0, apyUnknown: true as const };
  const collateralLeg: Leg = {
    id: `collateral-${position.key}`,
    side: "supply",
    symbol: collateral.symbol,
    underlying: underlyingOf(collateral.symbol),
    kind: assetKind(collateral.symbol),
    amount: position.collateralAmount,
    usd: collateralUsd,
    ...unrated,
    priceUsd: collateralPrice > 0 ? collateralPrice : undefined,
    isCollateral: true,
    liquidationThreshold: 1,
    liquidationThresholdSource: "protocol",
  };
  const indexLeg: Leg = {
    id: `size-${position.key}`,
    side: position.isLong ? "supply" : "borrow",
    symbol: indexSymbol,
    underlying: underlyingOf(indexSymbol),
    kind: assetKind(indexSymbol),
    amount: size,
    usd: notional,
    ...unrated,
    priceUsd: indexPrice > 0 ? indexPrice : undefined,
    ...(position.isLong ? { isCollateral: true, liquidationThreshold: 1 - f, liquidationThresholdSource: "protocol" as const } : {}),
  };
  const entryLeg: Leg = {
    id: `entry-${position.key}`,
    side: position.isLong ? "borrow" : "supply",
    symbol: "USD",
    underlying: "USD",
    kind: "stable",
    amount: position.sizeUsd,
    usd: position.sizeUsd,
    ...unrated,
    priceUsd: 1,
    ...(position.isLong ? {} : { isCollateral: true, liquidationThreshold: 1, liquidationThresholdSource: "protocol" as const }),
  };
  let healthFactor: number | null = null;
  if (notional > 0 && position.sizeUsd > 0) {
    healthFactor = position.isLong
      ? (notional * (1 - f) + collateralUsd) / position.sizeUsd
      : (collateralUsd + position.sizeUsd) / (notional * (1 + f));
  }
  const pnlUsd = position.isLong ? notional - position.sizeUsd : position.sizeUsd - notional;
  return {
    legs: [collateralLeg, indexLeg, entryLeg],
    healthFactor,
    entryPrice,
    leverage: collateralUsd > 0 ? position.sizeUsd / collateralUsd : null,
    pnlUsd,
  };
}
