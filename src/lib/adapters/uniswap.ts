import { getAddress, isAddress } from "viem";
import { assetKind, underlyingOf } from "@/lib/assets";
import { CHAINS, CHAIN_BY_KEY } from "@/lib/lp/chains";
import { fmtFee } from "@/lib/lp/format";
import { fetchChainPositions } from "@/lib/lp/positions";
import type { LpChainResult, LpPosition } from "@/lib/lp/types";
import type { Leg, Position, ProtocolFetch } from "@/lib/types";

/**
 * Uniswap V3 and V4 concentrated-liquidity positions, read straight from the chain for every
 * EVM wallet (the LP Ledger reader under `src/lib/lp`). Each position becomes one liquidity
 * row in the book, with the full LP detail (range, fees, pool price) kept on `position.lp`
 * so the Liquidity tab can show PnL, impermanent loss, fees and gas without a second read.
 */

export const UNISWAP_ID = "uniswap" as const;
const META = {
  id: UNISWAP_ID,
  name: "Uniswap V3 & V4 liquidity",
  chain: "Ethereum, Base, Arbitrum, BNB Chain, Robinhood Chain, Arc",
};

/** `${chain name}|${protocol}` for every protocol read cleanly, so Zerion's copy of those rows can be dropped. */
export type CoveredKey = `${string}|${"v3" | "v4"}`;

export function coveredKey(chain: string, protocol: "v3" | "v4"): CoveredKey {
  return `${chain}|${protocol}`;
}

export const UNISWAP_APP: Record<LpPosition["protocol"], string> = { v3: "Uniswap V3", v4: "Uniswap V4" };

function leg(id: string, token: LpPosition["token0"], amount: number): Leg {
  const price = token.priceUsd ?? undefined;
  return {
    id,
    side: "supply",
    symbol: token.symbol,
    underlying: underlyingOf(token.symbol),
    kind: assetKind(token.symbol),
    amount,
    usd: price != null ? amount * price : 0,
    apy: 0,
    // Fee yield is worked out from the position's history on the Liquidity tab, not a quoted rate.
    apyUnknown: true,
    priceUsd: price,
    isCollateral: false,
  };
}

/** One LP position as a book row: principal plus uncollected fees, one supply leg per token. */
export function lpToPosition(lp: LpPosition, wallet: string, fetchedAt: string): Position {
  const chain = CHAIN_BY_KEY[lp.chain];
  const pair = `${lp.token0.symbol}/${lp.token1.symbol}`;
  const unpriced = lp.token0.priceUsd == null || lp.token1.priceUsd == null;
  const note = [
    `${lp.inRange ? "In range" : "Out of range"} at ${lp.price.current.toPrecision(5)} ${lp.token1.symbol} per ${lp.token0.symbol} (range ${lp.price.lower.toPrecision(5)} to ${lp.price.upper.toPrecision(5)}).`,
    "Amounts include uncollected fees.",
    unpriced ? "No USD price was found for one side of the pool, so its value is partial." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id: `uniswap:${wallet}:${lp.id}`,
    protocol: UNISWAP_ID,
    app: UNISWAP_APP[lp.protocol],
    category: "liquidity",
    chain: chain.name,
    wallet,
    label: `${UNISWAP_APP[lp.protocol]} ${pair} ${fmtFee(lp.fee)} · ${chain.name}`,
    source: "live",
    legs: [leg("token0", lp.token0, lp.amount0 + lp.fees0), leg("token1", lp.token1, lp.amount1 + lp.fees1)],
    healthFactor: null,
    note,
    fetchedAt,
    lp,
  };
}

export interface UniswapRead {
  fetch: ProtocolFetch;
  covered: Set<CoveredKey>;
}

function chainNote(result: LpChainResult): string[] {
  const name = CHAIN_BY_KEY[result.chain].name;
  if (result.error) return [`${name}: ${result.error}`];
  return result.warnings.map((warning) => `${name}: ${warning}`);
}

/** Every chain for one wallet. A chain that fails becomes a note; the rest still loads. */
export async function fetchUniswap(address: string): Promise<UniswapRead> {
  const covered = new Set<CoveredKey>();
  if (!address) {
    return { fetch: { ...META, status: "skipped", message: "Add an EVM wallet.", positions: [], spot: [] }, covered };
  }
  if (!isAddress(address)) {
    return { fetch: { ...META, status: "error", message: "Not an EVM address.", positions: [], spot: [] }, covered };
  }
  const owner = getAddress(address);
  const fetchedAt = new Date().toISOString();
  const results = await Promise.all(
    CHAINS.filter((chain) => chain.live).map((chain) =>
      fetchChainPositions(chain.key, owner).catch(
        (error): LpChainResult => ({
          chain: chain.key,
          positions: [],
          closedCount: 0,
          warnings: [],
          failed: (["v3", "v4"] as const).filter((protocol) => chain[protocol]),
          error: error instanceof Error ? error.message.split("\n")[0] : "Request failed",
        }),
      ),
    ),
  );
  for (const result of results) {
    const info = CHAIN_BY_KEY[result.chain];
    if (result.error) continue;
    for (const protocol of ["v3", "v4"] as const) {
      if (info[protocol] && !result.failed.includes(protocol)) covered.add(coveredKey(info.name, protocol));
    }
  }
  const positions = results.flatMap((result) => result.positions.map((lp) => lpToPosition(lp, address, fetchedAt)));
  const notes = results.flatMap(chainNote);
  const reachable = results.filter((result) => !result.error);
  const closed = results.reduce((sum, result) => sum + result.closedCount, 0);
  const status: ProtocolFetch["status"] = reachable.length ? "ok" : "error";
  const summary =
    status === "ok" && !notes.length
      ? `${positions.length} open position${positions.length === 1 ? "" : "s"}${closed ? `, ${closed} closed not shown` : ""}.`
      : undefined;
  return {
    fetch: { ...META, status, message: notes.length ? notes.join(" · ") : summary, positions, spot: [] },
    covered,
  };
}

/** Zerion's own copy of a Uniswap V3/V4 pool on a chain the direct reader covered, which would count twice. */
export function readDirectly(position: Pick<Position, "app" | "category" | "chain">, covered: Set<CoveredKey>): boolean {
  if (position.category !== "liquidity" || !covered.size) return false;
  const app = position.app ?? "";
  if (!/uniswap/i.test(app) || /v2/i.test(app)) return false;
  const version = /v4/i.test(app) ? "v4" : /v3/i.test(app) ? "v3" : null;
  if (version) return covered.has(coveredKey(position.chain, version));
  return covered.has(coveredKey(position.chain, "v3")) || covered.has(coveredKey(position.chain, "v4"));
}
