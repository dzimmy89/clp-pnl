import type { Hex, PublicClient } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "../chains";
import { rpcLimit } from "../limit";

/** Small per-process caches so repeated lookups within a request are free. */
const blockTimes = new Map<string, Promise<number>>();
const receipts = new Map<string, Promise<{ gasNative: number }>>();

export function blockTimestamp(client: PublicClient, chain: ChainKey, blockNumber: bigint): Promise<number> {
  const k = `${chain}:${blockNumber}`;
  let p = blockTimes.get(k);
  if (!p) {
    p = rpcLimit(() => client.getBlock({ blockNumber })).then((b) => Number(b.timestamp));
    blockTimes.set(k, p);
  }
  return p;
}

/**
 * Gas paid for a transaction in native units. On OP-stack chains (Base) the
 * receipt carries an extra L1 data fee; Arbitrum folds it into gasUsed.
 */
export function txGas(client: PublicClient, chain: ChainKey, txHash: Hex): Promise<{ gasNative: number }> {
  const k = `${chain}:${txHash}`;
  let p = receipts.get(k);
  if (!p) {
    p = rpcLimit(() => client.getTransactionReceipt({ hash: txHash })).then((r) => {
      const base = r.gasUsed * (r.effectiveGasPrice ?? 0n);
      const l1 = (r as unknown as { l1Fee?: bigint }).l1Fee ?? 0n;
      const decimals = CHAIN_BY_KEY[chain].nativeDecimals;
      return { gasNative: Number(base + l1) / 10 ** decimals };
    });
    receipts.set(k, p);
  }
  return p;
}
