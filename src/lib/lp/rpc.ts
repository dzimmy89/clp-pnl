import { createPublicClient, defineChain, http, type Chain, type PublicClient } from "viem";
import { arbitrum, base, bsc, mainnet } from "viem/chains";
import { CHAIN_BY_KEY, type ChainKey } from "./chains";

/** Chains viem may not ship a definition for yet, built from our own chain table. */
function custom(key: ChainKey): Chain {
  const info = CHAIN_BY_KEY[key];
  return defineChain({
    id: info.chainId,
    name: info.name,
    nativeCurrency: { name: info.nativeSymbol, symbol: info.nativeSymbol, decimals: info.nativeDecimals },
    rpcUrls: { default: { http: [info.publicRpc] } },
    blockExplorers: { default: { name: "Explorer", url: info.explorer } },
  });
}

const VIEM_CHAINS: Record<ChainKey, Chain> = {
  ethereum: mainnet,
  base,
  arbitrum,
  bnb: bsc,
  robinhood: custom("robinhood"),
  arc: custom("arc"),
};

/** Alchemy network slugs for the chains Alchemy serves. */
const ALCHEMY_SLUGS: Partial<Record<ChainKey, string>> = {
  ethereum: "eth-mainnet",
  base: "base-mainnet",
  arbitrum: "arb-mainnet",
  bnb: "bnb-mainnet",
};

function override(key: ChainKey): string | undefined {
  // RPC_URL_ARBITRUM wins; ARBITRUM_RPC_URL is the name the GMX reader already uses.
  return process.env[`RPC_URL_${key.toUpperCase()}`] || process.env[`${key.toUpperCase()}_RPC_URL`] || undefined;
}

/**
 * RPC URL resolution, most specific first:
 *   1. RPC_URL_<CHAIN> or <CHAIN>_RPC_URL (e.g. RPC_URL_ETHEREUM) for a full override,
 *   2. ALCHEMY_API_KEY for chains Alchemy serves,
 *   3. the chain's public RPC.
 */
export function rpcUrl(key: ChainKey): string {
  const pinned = override(key);
  if (pinned) return pinned;
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const slug = ALCHEMY_SLUGS[key];
  if (alchemyKey && slug) return `https://${slug}.g.alchemy.com/v2/${alchemyKey}`;
  return CHAIN_BY_KEY[key].publicRpc;
}

export function usingAlchemy(key: ChainKey): boolean {
  return !override(key) && !!process.env.ALCHEMY_API_KEY && !!ALCHEMY_SLUGS[key];
}

const clients = new Map<ChainKey, PublicClient>();

export function getClient(key: ChainKey): PublicClient {
  let client = clients.get(key);
  if (!client) {
    const chain = VIEM_CHAINS[key];
    client = createPublicClient({
      chain,
      transport: http(rpcUrl(key), { batch: false, timeout: 20_000, retryCount: 3 }),
      // Reads are folded into Multicall3 where the chain is known to have it deployed.
      batch: chain.contracts?.multicall3 ? { multicall: { wait: 16, batchSize: 512 } } : undefined,
    }) as PublicClient;
    clients.set(key, client);
  }
  return client;
}
