import { encodeAbiParameters, keccak256, numberToHex, parseAbiItem, type Address, type Hex } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "../chains";
import { getClient } from "../rpc";
import { getToken } from "../tokens";
import type { Position } from "../types";
import { v4PositionManagerAbi, v4StateViewAbi } from "./abis";
import {
  formatUnitsNumber,
  getAmountsForLiquidity,
  getFeeGrowthInside,
  getUncollectedFees,
  sqrtPriceToPrice,
  tickToPrice,
} from "./math";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed id)",
);

/** Decode the packed PositionInfo word (v4-periphery PositionInfoLibrary). */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number; hasSubscriber: boolean } {
  const toInt24 = (v: bigint) => {
    const n = Number(v & 0xffffffn);
    return n >= 0x800000 ? n - 0x1000000 : n;
  };
  return {
    hasSubscriber: (info & 0xffn) === 1n,
    tickLower: toInt24(info >> 8n),
    tickUpper: toInt24(info >> 32n),
  };
}

type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/**
 * V4's PositionManager is a plain ERC-721 (not enumerable), so ownership is
 * discovered from Transfer logs into the wallet, then confirmed with ownerOf.
 * Needs an RPC that allows wide eth_getLogs ranges (Alchemy does).
 */
async function discoverTokenIds(chain: ChainKey, owner: Address): Promise<bigint[]> {
  const info = CHAIN_BY_KEY[chain];
  const client = getClient(chain);
  const logs = await client.getLogs({
    address: info.v4!.positionManager,
    event: transferEvent,
    args: { to: owner },
    fromBlock: 0n,
    toBlock: "latest",
  });
  const ids = [...new Set(logs.map((l) => l.args.id!))];
  const owners = await Promise.all(
    ids.map((id) =>
      client
        .readContract({ address: info.v4!.positionManager, abi: v4PositionManagerAbi, functionName: "ownerOf", args: [id] })
        .catch(() => null),
    ),
  );
  return ids.filter((_, i) => owners[i]?.toLowerCase() === owner.toLowerCase());
}

export async function fetchV4Positions(
  chain: ChainKey,
  owner: Address,
): Promise<{ positions: Position[]; closedCount: number }> {
  const info = CHAIN_BY_KEY[chain];
  if (!info.v4) return { positions: [], closedCount: 0 };
  const client = getClient(chain);
  const pm = info.v4.positionManager;
  const sv = info.v4.stateView;

  const tokenIds = await discoverTokenIds(chain, owner);

  const raw = await Promise.all(
    tokenIds.map(async (id) => {
      const [[key, packed], liquidity] = await Promise.all([
        client.readContract({ address: pm, abi: v4PositionManagerAbi, functionName: "getPoolAndPositionInfo", args: [id] }),
        client.readContract({ address: pm, abi: v4PositionManagerAbi, functionName: "getPositionLiquidity", args: [id] }),
      ]);
      return { id, key: key as PoolKey, ...decodePositionInfo(packed), liquidity };
    }),
  );

  let closedCount = 0;
  const open = raw.filter((r) => {
    if (r.liquidity === 0n) closedCount++;
    return r.liquidity > 0n;
  });

  const positions = await Promise.all(
    open.map(async (r) => {
      const pid = poolId(r.key);
      const salt = numberToHex(r.id, { size: 32 });
      const [t0, t1, slot0, globals, lower, upper, posInfo] = await Promise.all([
        getToken(client, chain, r.key.currency0),
        getToken(client, chain, r.key.currency1),
        client.readContract({ address: sv, abi: v4StateViewAbi, functionName: "getSlot0", args: [pid] }),
        client.readContract({ address: sv, abi: v4StateViewAbi, functionName: "getFeeGrowthGlobals", args: [pid] }),
        client.readContract({ address: sv, abi: v4StateViewAbi, functionName: "getTickFeeGrowthOutside", args: [pid, r.tickLower] }),
        client.readContract({ address: sv, abi: v4StateViewAbi, functionName: "getTickFeeGrowthOutside", args: [pid, r.tickUpper] }),
        client.readContract({ address: sv, abi: v4StateViewAbi, functionName: "getPositionInfo", args: [pid, pm, r.tickLower, r.tickUpper, salt] }),
      ]);
      const [sqrtPriceX96, tick, , lpFee] = slot0;
      const [fg0, fg1] = globals;
      const [, fgIn0Last, fgIn1Last] = posInfo;
      const { amount0, amount1 } = getAmountsForLiquidity(sqrtPriceX96, r.tickLower, r.tickUpper, r.liquidity);
      const fgInside0 = getFeeGrowthInside(fg0, lower[0], upper[0], r.tickLower, r.tickUpper, tick);
      const fgInside1 = getFeeGrowthInside(fg1, lower[1], upper[1], r.tickLower, r.tickUpper, tick);
      const fees0 = getUncollectedFees(r.liquidity, fgInside0, fgIn0Last);
      const fees1 = getUncollectedFees(r.liquidity, fgInside1, fgIn1Last);
      const isDynamic = r.key.fee === 0x800000;

      const position: Position = {
        id: `${chain}-v4-${r.id}`,
        chain,
        protocol: "v4",
        tokenId: r.id.toString(),
        pool: pid,
        token0: { ...t0, priceUsd: null },
        token1: { ...t1, priceUsd: null },
        fee: isDynamic ? lpFee : r.key.fee,
        tickSpacing: r.key.tickSpacing,
        hooks: r.key.hooks.toLowerCase() === "0x0000000000000000000000000000000000000000" ? null : r.key.hooks,
        tickLower: r.tickLower,
        tickUpper: r.tickUpper,
        currentTick: tick,
        sqrtPriceX96: sqrtPriceX96.toString(),
        liquidity: r.liquidity.toString(),
        inRange: tick >= r.tickLower && tick < r.tickUpper,
        price: {
          current: sqrtPriceToPrice(sqrtPriceX96, t0.decimals, t1.decimals),
          lower: tickToPrice(r.tickLower, t0.decimals, t1.decimals),
          upper: tickToPrice(r.tickUpper, t0.decimals, t1.decimals),
        },
        amount0: formatUnitsNumber(amount0, t0.decimals),
        amount1: formatUnitsNumber(amount1, t1.decimals),
        fees0: formatUnitsNumber(fees0, t0.decimals),
        fees1: formatUnitsNumber(fees1, t1.decimals),
        valueUsd: null,
        feesUsd: null,
        explorerUrl: `${info.explorer}/nft/${pm}/${r.id}`,
      };
      return position;
    }),
  );

  return { positions, closedCount };
}
