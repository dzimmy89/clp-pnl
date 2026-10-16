import { decodeEventLog, numberToHex, parseAbiItem, zeroAddress, type Address, type Hex } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "../chains";
import { rpcLimit } from "../limit";
import { getClient } from "../rpc";
import type { Position } from "../types";
import { v4StateViewAbi } from "../uniswap/abis";
import { formatUnitsNumber, getAmountsForLiquidity } from "../uniswap/math";
import { blockTimestamp, txGas } from "./chain-data";
import { historicalNativePrice, historicalPrice } from "./historical-prices";
import { summarizeFlows } from "./pnl";
import type { Flow, PositionHistory } from "./types";

const modifyLiquidityEvent = parseAbiItem(
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
);
const erc20Transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/**
 * V4 history comes from the PoolManager's ModifyLiquidity events (the
 * PositionManager is the sender and the salt is the tokenId). Those events
 * carry liquidity deltas, not token amounts, so amounts are recomputed from
 * the pool price at that block via StateView (an archive read).
 *
 * Fees are paid out alongside principal on every decrease, and on a
 * zero-delta modify (a pure collect). They are measured from the ERC-20
 * Transfer logs out of the PoolManager in the same transaction; the native
 * side of a pool has no such log, so native fees are estimated using the
 * pool price in that block.
 */
export async function fetchV4History(chain: ChainKey, position: Position, owner: Address): Promise<PositionHistory> {
  const info = CHAIN_BY_KEY[chain];
  if (!info.v4) throw new Error("No V4 on this chain");
  const client = getClient(chain);
  const { poolManager, positionManager, stateView } = info.v4;
  const poolId = position.pool as Hex;
  const salt = numberToHex(BigInt(position.tokenId), { size: 32 }).toLowerCase();
  const warnings: string[] = [];

  const logs = (
    await client.getLogs({
      address: poolManager,
      event: modifyLiquidityEvent,
      args: { id: poolId, sender: positionManager },
      fromBlock: 0n,
      toBlock: "latest",
    })
  ).filter((l) => l.args.salt?.toLowerCase() === salt);

  const d0 = position.token0.decimals;
  const d1 = position.token1.decimals;
  const native0 = position.token0.isNative || position.token0.address.toLowerCase() === zeroAddress;
  const native1 = position.token1.isNative || position.token1.address.toLowerCase() === zeroAddress;

  const flows: Flow[] = [];
  await Promise.all(
    logs.map(async (l) => {
      const delta = l.args.liquidityDelta!;
      const [timestamp, gas, slot0, receipt] = await Promise.all([
        blockTimestamp(client, chain, l.blockNumber),
        txGas(client, chain, l.transactionHash),
        rpcLimit(() => client.readContract({ address: stateView, abi: v4StateViewAbi, functionName: "getSlot0", args: [poolId], blockNumber: l.blockNumber })),
        rpcLimit(() => client.getTransactionReceipt({ hash: l.transactionHash })),
      ]);
      const [price0Usd, price1Usd, nativeUsd] = await Promise.all([
        historicalPrice(chain, position.token0, timestamp),
        historicalPrice(chain, position.token1, timestamp),
        historicalNativePrice(chain, timestamp),
      ]);
      const sqrtPriceX96 = slot0[0];
      const absDelta = delta < 0n ? -delta : delta;
      const { amount0, amount1 } = getAmountsForLiquidity(sqrtPriceX96, position.tickLower, position.tickUpper, absDelta);
      const base = {
        txHash: l.transactionHash,
        blockNumber: l.blockNumber.toString(),
        timestamp,
        price0Usd,
        price1Usd,
        gasNative: gas.gasNative,
        gasUsd: nativeUsd != null ? gas.gasNative * nativeUsd : null,
      };
      const value = (a0: number, a1: number) => (price0Usd != null && price1Usd != null ? a0 * price0Usd + a1 * price1Usd : null);

      if (delta > 0n) {
        const a0 = formatUnitsNumber(amount0, d0);
        const a1 = formatUnitsNumber(amount1, d1);
        flows.push({ ...base, kind: "deposit", amount0: a0, amount1: a1, valueUsd: value(a0, a1) });
        return;
      }

      // Decrease or pure collect: what left the PoolManager for the owner in this tx.
      const paid = (token: Address) =>
        receipt.logs
          .filter((x) => x.address.toLowerCase() === token.toLowerCase())
          .map((x) => {
            try {
              const d = decodeEventLog({ abi: [erc20Transfer], data: x.data, topics: x.topics });
              return d.args.from.toLowerCase() === poolManager.toLowerCase() ? d.args.value : 0n;
            } catch {
              return 0n;
            }
          })
          .reduce((s, v) => s + v, 0n);

      const principal0 = delta < 0n ? amount0 : 0n;
      const principal1 = delta < 0n ? amount1 : 0n;
      let fee0: bigint | null = native0 ? null : paid(position.token0.address) - principal0;
      let fee1: bigint | null = native1 ? null : paid(position.token1.address) - principal1;
      let estimated = false;
      // Native side: assume fees accrue in proportion to the pool price (rough).
      if (fee0 == null && fee1 != null) {
        fee0 = sqrtPriceX96 > 0n ? (fee1 << 192n) / (sqrtPriceX96 * sqrtPriceX96) : 0n;
        estimated = true;
      } else if (fee1 == null && fee0 != null) {
        fee1 = (fee0 * sqrtPriceX96 * sqrtPriceX96) >> 192n;
        estimated = true;
      } else if (fee0 == null && fee1 == null) {
        fee0 = 0n;
        fee1 = 0n;
        estimated = true;
      }
      if (fee0! < 0n) fee0 = 0n;
      if (fee1! < 0n) fee1 = 0n;

      if (delta < 0n) {
        const a0 = formatUnitsNumber(principal0, d0);
        const a1 = formatUnitsNumber(principal1, d1);
        flows.push({ ...base, kind: "withdraw", amount0: a0, amount1: a1, valueUsd: value(a0, a1) });
      }
      if (fee0! > 0n || fee1! > 0n) {
        const f0 = formatUnitsNumber(fee0!, d0);
        const f1 = formatUnitsNumber(fee1!, d1);
        flows.push({ ...base, kind: "collect", amount0: f0, amount1: f1, valueUsd: value(f0, f1), estimated });
      }
    }),
  );

  if (flows.some((f) => f.estimated)) warnings.push("Fees collected on the native-token side are estimated from the pool price.");
  if (flows.some((f) => f.valueUsd == null)) warnings.push("Some historical prices were unavailable; USD totals are partial.");
  void owner;
  return summarizeFlows(position.id, flows, warnings);
}
