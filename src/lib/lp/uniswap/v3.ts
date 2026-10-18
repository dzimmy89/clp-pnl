import type { Address } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "../chains";
import { getClient } from "../rpc";
import { getToken } from "../tokens";
import type { LpPosition } from "../types";
import { v3FactoryAbi, v3PoolAbi, v3PositionManagerAbi } from "./abis";
import {
  formatUnitsNumber,
  getAmountsForLiquidity,
  getFeeGrowthInside,
  getUncollectedFees,
  sqrtPriceToPrice,
  tickToPrice,
} from "./math";

export async function fetchV3Positions(
  chain: ChainKey,
  owner: Address,
): Promise<{ positions: LpPosition[]; closedCount: number }> {
  const info = CHAIN_BY_KEY[chain];
  if (!info.v3) return { positions: [], closedCount: 0 };
  const client = getClient(chain);
  const pm = info.v3.positionManager;

  const balance = await client.readContract({
    address: pm,
    abi: v3PositionManagerAbi,
    functionName: "balanceOf",
    args: [owner],
  });

  const tokenIds = await Promise.all(
    Array.from({ length: Number(balance) }, (_, i) =>
      client.readContract({
        address: pm,
        abi: v3PositionManagerAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [owner, BigInt(i)],
      }),
    ),
  );

  const raw = await Promise.all(
    tokenIds.map((id) =>
      client.readContract({ address: pm, abi: v3PositionManagerAbi, functionName: "positions", args: [id] }),
    ),
  );

  let closedCount = 0;
  const open = raw
    .map((r, i) => ({ id: tokenIds[i], r }))
    .filter(({ r }) => {
      const [, , , , , , , liquidity, , , owed0, owed1] = r;
      const isOpen = liquidity > 0n || owed0 > 0n || owed1 > 0n;
      if (!isOpen) closedCount++;
      return isOpen;
    });

  const positions = await Promise.all(
    open.map(async ({ id, r }) => {
      const [, , token0Addr, token1Addr, fee, tickLower, tickUpper, liquidity, fgIn0Last, fgIn1Last, owed0, owed1] = r;
      const pool = await client.readContract({
        address: info.v3!.factory,
        abi: v3FactoryAbi,
        functionName: "getPool",
        args: [token0Addr, token1Addr, fee],
      });
      const [t0, t1, slot0, fg0, fg1, lower, upper, spacing] = await Promise.all([
        getToken(client, chain, token0Addr),
        getToken(client, chain, token1Addr),
        client.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" }),
        client.readContract({ address: pool, abi: v3PoolAbi, functionName: "feeGrowthGlobal0X128" }),
        client.readContract({ address: pool, abi: v3PoolAbi, functionName: "feeGrowthGlobal1X128" }),
        client.readContract({ address: pool, abi: v3PoolAbi, functionName: "ticks", args: [tickLower] }),
        client.readContract({ address: pool, abi: v3PoolAbi, functionName: "ticks", args: [tickUpper] }),
        client.readContract({ address: pool, abi: v3PoolAbi, functionName: "tickSpacing" }),
      ]);
      const [sqrtPriceX96, tick] = slot0;
      const { amount0, amount1 } = getAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity);
      const fgInside0 = getFeeGrowthInside(fg0, lower[2], upper[2], tickLower, tickUpper, tick);
      const fgInside1 = getFeeGrowthInside(fg1, lower[3], upper[3], tickLower, tickUpper, tick);
      const fees0 = owed0 + getUncollectedFees(liquidity, fgInside0, fgIn0Last);
      const fees1 = owed1 + getUncollectedFees(liquidity, fgInside1, fgIn1Last);

      const position: LpPosition = {
        id: `${chain}-v3-${id}`,
        chain,
        protocol: "v3",
        tokenId: id.toString(),
        pool,
        token0: { ...t0, priceUsd: null },
        token1: { ...t1, priceUsd: null },
        fee,
        tickSpacing: spacing,
        hooks: null,
        tickLower,
        tickUpper,
        currentTick: tick,
        sqrtPriceX96: sqrtPriceX96.toString(),
        liquidity: liquidity.toString(),
        inRange: tick >= tickLower && tick < tickUpper,
        price: {
          current: sqrtPriceToPrice(sqrtPriceX96, t0.decimals, t1.decimals),
          lower: tickToPrice(tickLower, t0.decimals, t1.decimals),
          upper: tickToPrice(tickUpper, t0.decimals, t1.decimals),
        },
        amount0: formatUnitsNumber(amount0, t0.decimals),
        amount1: formatUnitsNumber(amount1, t1.decimals),
        fees0: formatUnitsNumber(fees0, t0.decimals),
        fees1: formatUnitsNumber(fees1, t1.decimals),
        valueUsd: null,
        feesUsd: null,
        explorerUrl: `${info.explorer}/nft/${pm}/${id}`,
      };
      return position;
    }),
  );

  return { positions, closedCount };
}
