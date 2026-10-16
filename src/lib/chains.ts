/**
 * Chains the ledger tracks. `live` means Uniswap V3/V4 position reading is
 * wired up; the rest show as coming soon until an official deployment and a
 * public RPC are confirmed (Step 4 of the plan).
 */
export type ChainKey =
  | "ethereum"
  | "base"
  | "arbitrum"
  | "bnb"
  | "robinhood"
  | "arc";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  shortName: string;
  chainId: number | null;
  nativeSymbol: string;
  explorer: string | null;
  live: boolean;
}

export const CHAINS: ChainInfo[] = [
  {
    key: "ethereum",
    name: "Ethereum",
    shortName: "ETH",
    chainId: 1,
    nativeSymbol: "ETH",
    explorer: "https://etherscan.io",
    live: false,
  },
  {
    key: "base",
    name: "Base",
    shortName: "BASE",
    chainId: 8453,
    nativeSymbol: "ETH",
    explorer: "https://basescan.org",
    live: false,
  },
  {
    key: "arbitrum",
    name: "Arbitrum",
    shortName: "ARB",
    chainId: 42161,
    nativeSymbol: "ETH",
    explorer: "https://arbiscan.io",
    live: false,
  },
  {
    key: "bnb",
    name: "BNB Chain",
    shortName: "BNB",
    chainId: 56,
    nativeSymbol: "BNB",
    explorer: "https://bscscan.com",
    live: false,
  },
  {
    key: "robinhood",
    name: "Robinhood Chain",
    shortName: "RH",
    chainId: null,
    nativeSymbol: "ETH",
    explorer: null,
    live: false,
  },
  {
    key: "arc",
    name: "Arc",
    shortName: "ARC",
    chainId: null,
    nativeSymbol: "USDC",
    explorer: null,
    live: false,
  },
];
