import { createPublicClient, http, type PublicClient } from "viem";
import { arbitrum, arc, base, bsc, mainnet, robinhood } from "viem/chains";
import { CHAIN_BY_KEY, type ChainKey } from "./chains";

const VIEM_CHAINS = {
  ethereum: mainnet,
  base,
  arbitrum,
  bnb: bsc,
  robinhood,
  arc,
} as const;

/** Alchemy network slugs for the chains Alchemy serves. */
const ALCHEMY_SLUGS: Partial<Record<ChainKey, string>> = {
  ethereum: "eth-mainnet",
  base: "base-mainnet",
  arbitrum: "arb-mainnet",
  bnb: "bnb-mainnet",
};

/**
 * RPC URL resolution, most specific first:
 *   1. RPC_URL_<CHAIN> (e.g. RPC_URL_ETHEREUM) for a full override,
 *   2. ALCHEMY_API_KEY for chains Alchemy serves,
 *   3. the chain's public RPC.
 */
export function rpcUrl(key: ChainKey): string {
  const override = process.env[`RPC_URL_${key.toUpperCase()}`];
  if (override) return override;
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const slug = ALCHEMY_SLUGS[key];
  if (alchemyKey && slug) return `https://${slug}.g.alchemy.com/v2/${alchemyKey}`;
  return CHAIN_BY_KEY[key].publicRpc;
}

export function usingAlchemy(key: ChainKey): boolean {
  return !process.env[`RPC_URL_${key.toUpperCase()}`] && !!process.env.ALCHEMY_API_KEY && !!ALCHEMY_SLUGS[key];
}

const clients = new Map<ChainKey, PublicClient>();

export function getClient(key: ChainKey): PublicClient {
  let client = clients.get(key);
  if (!client) {
    client = createPublicClient({
      chain: VIEM_CHAINS[key],
      transport: http(rpcUrl(key), { batch: true, timeout: 20_000 }),
      batch: { multicall: { wait: 16 } },
    }) as PublicClient;
    clients.set(key, client);
  }
  return client;
}
