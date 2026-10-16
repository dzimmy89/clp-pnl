import { hexToString, zeroAddress, type Address, type PublicClient } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "./chains";
import type { TokenInfo } from "./types";
import { erc20Abi, erc20Bytes32Abi } from "./uniswap/abis";

const cache = new Map<string, Promise<Omit<TokenInfo, "priceUsd">>>();

export async function getToken(
  client: PublicClient,
  chain: ChainKey,
  address: Address,
): Promise<Omit<TokenInfo, "priceUsd">> {
  const info = CHAIN_BY_KEY[chain];
  if (address.toLowerCase() === zeroAddress) {
    return { address, symbol: info.nativeSymbol, decimals: info.nativeDecimals, isNative: true };
  }
  const k = `${chain}:${address.toLowerCase()}`;
  let p = cache.get(k);
  if (!p) {
    p = (async () => {
      const [symbol, decimals] = await Promise.all([
        client
          .readContract({ address, abi: erc20Abi, functionName: "symbol" })
          .catch(() =>
            client
              .readContract({ address, abi: erc20Bytes32Abi, functionName: "symbol" })
              .then((b) => hexToString(b, { size: 32 }))
              .catch(() => `${address.slice(0, 6)}…`),
          ),
        client.readContract({ address, abi: erc20Abi, functionName: "decimals" }).catch(() => 18),
      ]);
      return { address, symbol: String(symbol), decimals: Number(decimals), isNative: false };
    })();
    cache.set(k, p);
  }
  return p;
}
