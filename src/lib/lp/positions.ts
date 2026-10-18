import type { Address } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "./chains";
import { applyPrices, fetchPrices } from "./prices";
import { usingAlchemy } from "./rpc";
import type { LpChainResult, LpPosition } from "./types";
import { fetchV3Positions } from "./uniswap/v3";
import { fetchV4Positions } from "./uniswap/v4";

function message(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0] : String(e);
}

/** Every open Uniswap V3 and V4 position `owner` holds on one chain, priced in USD. */
export async function fetchChainPositions(chain: ChainKey, owner: Address): Promise<LpChainResult> {
  const info = CHAIN_BY_KEY[chain];
  const warnings: string[] = [];
  const failed: LpChainResult["failed"] = [];
  const positions: LpPosition[] = [];
  let closedCount = 0;

  const [v3, v4] = await Promise.allSettled([
    fetchV3Positions(chain, owner),
    fetchV4Positions(chain, owner),
  ]);

  if (v3.status === "fulfilled") {
    positions.push(...v3.value.positions);
    closedCount += v3.value.closedCount;
  } else if (info.v3) {
    failed.push("v3");
    warnings.push(`V3 read failed: ${message(v3.reason)}`);
  }
  if (v4.status === "fulfilled") {
    positions.push(...v4.value.positions);
    closedCount += v4.value.closedCount;
  } else if (info.v4) {
    failed.push("v4");
    const hint = usingAlchemy(chain) ? "" : " (V4 discovery needs an RPC that allows wide log queries, such as Alchemy)";
    warnings.push(`V4 read failed: ${message(v4.reason)}${hint}`);
  }

  if (v3.status === "rejected" && v4.status === "rejected") {
    return { chain, positions: [], closedCount: 0, warnings, failed, error: "Could not reach this chain." };
  }

  const tokens = new Map(positions.flatMap((p) => [p.token0, p.token1]).map((t) => [t.address.toLowerCase(), t]));
  const prices = await fetchPrices(chain, [...tokens.values()]);
  for (const p of positions) applyPrices(p, prices);

  positions.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  return { chain, positions, closedCount, warnings, failed };
}
