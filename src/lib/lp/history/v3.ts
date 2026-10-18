import { parseAbiItem, type Address } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "../chains";
import { getClient } from "../rpc";
import type { LpPosition } from "../types";
import { formatUnitsNumber } from "../uniswap/math";
import { blockTimestamp, txGas } from "./chain-data";
import { historicalNativePrice, historicalPrice } from "./historical-prices";
import { summarizeFlows } from "./pnl";
import type { Flow, PositionHistory } from "./types";

const increaseEvent = parseAbiItem(
  "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const decreaseEvent = parseAbiItem(
  "event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
);
const collectEvent = parseAbiItem(
  "event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)",
);

/**
 * Full lifecycle of a V3 position from the NonfungiblePositionManager's
 * events, which are indexed by tokenId so a single filtered log query per
 * event type covers the whole chain history.
 *
 * Collect events pay out both principal (queued by DecreaseLiquidity) and
 * fees, so fees collected = collected - decreased, applied in order.
 */
export async function fetchV3History(chain: ChainKey, position: LpPosition, owner: Address): Promise<PositionHistory> {
  const info = CHAIN_BY_KEY[chain];
  if (!info.v3) throw new Error("No V3 on this chain");
  const client = getClient(chain);
  const pm = info.v3.positionManager;
  const tokenId = BigInt(position.tokenId);
  const warnings: string[] = [];

  const [inc, dec, col] = await Promise.all([
    client.getLogs({ address: pm, event: increaseEvent, args: { tokenId }, fromBlock: 0n, toBlock: "latest" }),
    client.getLogs({ address: pm, event: decreaseEvent, args: { tokenId }, fromBlock: 0n, toBlock: "latest" }),
    client.getLogs({ address: pm, event: collectEvent, args: { tokenId }, fromBlock: 0n, toBlock: "latest" }),
  ]);

  type Raw = { kind: Flow["kind"]; blockNumber: bigint; logIndex: number; txHash: `0x${string}`; a0: bigint; a1: bigint };
  const raws: Raw[] = [
    ...inc.map((l) => ({ kind: "deposit" as const, blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, a0: l.args.amount0!, a1: l.args.amount1! })),
    ...dec.map((l) => ({ kind: "withdraw" as const, blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, a0: l.args.amount0!, a1: l.args.amount1! })),
    ...col.map((l) => ({ kind: "collect" as const, blockNumber: l.blockNumber, logIndex: l.logIndex, txHash: l.transactionHash, a0: l.args.amount0!, a1: l.args.amount1! })),
  ].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));

  // Split collects into fees by netting out principal queued by prior decreases.
  let pending0 = 0n;
  let pending1 = 0n;
  const split: (Raw & { fee0: bigint; fee1: bigint })[] = raws.map((r) => {
    if (r.kind === "withdraw") {
      pending0 += r.a0;
      pending1 += r.a1;
      return { ...r, fee0: 0n, fee1: 0n };
    }
    if (r.kind === "collect") {
      const principal0 = r.a0 < pending0 ? r.a0 : pending0;
      const principal1 = r.a1 < pending1 ? r.a1 : pending1;
      pending0 -= principal0;
      pending1 -= principal1;
      return { ...r, fee0: r.a0 - principal0, fee1: r.a1 - principal1 };
    }
    return { ...r, fee0: 0n, fee1: 0n };
  });

  const d0 = position.token0.decimals;
  const d1 = position.token1.decimals;

  const flows = await Promise.all(
    split
      .filter((r) => !(r.kind === "collect" && r.fee0 === 0n && r.fee1 === 0n))
      .map(async (r) => {
        const [timestamp, gas] = await Promise.all([blockTimestamp(client, chain, r.blockNumber), txGas(client, chain, r.txHash)]);
        const [price0Usd, price1Usd, nativeUsd] = await Promise.all([
          historicalPrice(chain, position.token0, timestamp),
          historicalPrice(chain, position.token1, timestamp),
          historicalNativePrice(chain, timestamp),
        ]);
        const amount0 = formatUnitsNumber(r.kind === "collect" ? r.fee0 : r.a0, d0);
        const amount1 = formatUnitsNumber(r.kind === "collect" ? r.fee1 : r.a1, d1);
        const flow: Flow = {
          kind: r.kind,
          txHash: r.txHash,
          blockNumber: r.blockNumber.toString(),
          timestamp,
          amount0,
          amount1,
          price0Usd,
          price1Usd,
          valueUsd: price0Usd != null && price1Usd != null ? amount0 * price0Usd + amount1 * price1Usd : null,
          gasNative: gas.gasNative,
          gasUsd: nativeUsd != null ? gas.gasNative * nativeUsd : null,
        };
        return flow;
      }),
  );

  if (flows.some((f) => f.valueUsd == null)) warnings.push("Some historical prices were unavailable; USD totals are partial.");
  void owner;
  return summarizeFlows(position.id, flows, warnings);
}
