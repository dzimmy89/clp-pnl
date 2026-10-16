import type { Address } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "./chains";
import { applyPrices, fetchPrices } from "./prices";
import { usingAlchemy } from "./rpc";
import type { ChainPositionsResult, Position } from "./types";
import { fetchV3Positions } from "./uniswap/v3";
import { fetchV4Positions } from "./uniswap/v4";

function message(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}

export async function fetchChainPositions(chain: ChainKey, owner: Address): Promise<ChainPositionsResult> {
  const info = CHAIN_BY_KEY[chain];
  const warnings: string[] = [];
  const positions: Position[] = [];
  let closedCount = 0;

  const [v3, v4] = await Promise.allSettled([
    fetchV3Positions(chain, owner),
    fetchV4Positions(chain, owner),
  ]);

  if (v3.status === "fulfilled") {
    positions.push(...v3.value.positions);
    closedCount += v3.value.closedCount;
  } else if (info.v3) {
    warnings.push(`V3 read failed: ${message(v3.reason)}`);
  }
  if (v4.status === "fulfilled") {
    positions.push(...v4.value.positions);
    closedCount += v4.value.closedCount;
  } else if (info.v4) {
    const hint = usingAlchemy(chain) ? "" : " (V4 discovery needs an RPC that allows wide log queries, such as Alchemy)";
    warnings.push(`V4 read failed: ${message(v4.reason)}${hint}`);
  }

  if (v3.status === "rejected" && v4.status === "rejected") {
    return { chain, positions: [], closedCount: 0, warnings, error: "Could not reach this chain." };
  }

  const tokens = new Map(positions.flatMap((p) => [p.token0, p.token1]).map((t) => [t.address.toLowerCase(), t]));
  const prices = await fetchPrices(chain, [...tokens.values()]);
  for (const p of positions) applyPrices(p, prices);

  positions.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  return { chain, positions, closedCount, warnings };
}
