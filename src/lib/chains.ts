/**
 * Chains the ledger tracks, with the Uniswap contracts we read positions from.
 *
 * Addresses come from the official Uniswap deployment pages
 * (developers.uniswap.org/docs/protocols/v3/deployments and /v4/deployments),
 * fetched 2026-10-16. Uniswap warns that addresses differ across chains, so
 * each one is listed per chain rather than assumed.
 *
 * `live` means position reading is wired up for that chain.
 */
import type { Address } from "viem";

export type ChainKey =
  | "ethereum"
  | "base"
  | "arbitrum"
  | "bnb"
  | "robinhood"
  | "arc";

export interface UniswapV3Contracts {
  factory: Address;
  positionManager: Address;
  quoterV2: Address;
}

export interface UniswapV4Contracts {
  poolManager: Address;
  positionManager: Address;
  stateView: Address;
}

export interface ChainInfo {
  key: ChainKey;
  name: string;
  shortName: string;
  chainId: number;
  nativeSymbol: string;
  /** Native token decimals. Arc uses USDC as gas but exposes it with 18 decimals natively. */
  nativeDecimals: number;
  explorer: string;
  /** Public fallback RPC; the app prefers an Alchemy URL from env when set. */
  publicRpc: string;
  v3: UniswapV3Contracts | null;
  v4: UniswapV4Contracts | null;
  live: boolean;
}

export const CHAINS: ChainInfo[] = [
  {
    key: "ethereum",
    name: "Ethereum",
    shortName: "ETH",
    chainId: 1,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorer: "https://etherscan.io",
    publicRpc: "https://eth.llamarpc.com",
    v3: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    v4: {
      poolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
      positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",
      stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
    },
    live: false,
  },
  {
    key: "base",
    name: "Base",
    shortName: "BASE",
    chainId: 8453,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorer: "https://basescan.org",
    publicRpc: "https://mainnet.base.org",
    v3: {
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
      quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    },
    v4: {
      poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
      positionManager: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
      stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
    },
    live: false,
  },
  {
    key: "arbitrum",
    name: "Arbitrum",
    shortName: "ARB",
    chainId: 42161,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorer: "https://arbiscan.io",
    publicRpc: "https://arb1.arbitrum.io/rpc",
    v3: {
      factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
      quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    },
    v4: {
      poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
      positionManager: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869",
      stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
    },
    live: false,
  },
  {
    key: "bnb",
    name: "BNB Chain",
    shortName: "BNB",
    chainId: 56,
    nativeSymbol: "BNB",
    nativeDecimals: 18,
    explorer: "https://bscscan.com",
    publicRpc: "https://bsc-dataseed.binance.org",
    v3: {
      factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
      positionManager: "0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613",
      quoterV2: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    },
    v4: {
      poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
      positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b",
      stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
    },
    live: false,
  },
  {
    key: "robinhood",
    name: "Robinhood Chain",
    shortName: "RH",
    chainId: 4663,
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    explorer: "https://robinhoodchain.blockscout.com",
    publicRpc: "https://rpc.mainnet.chain.robinhood.com",
    v3: {
      factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
      positionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
      quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
    },
    v4: {
      poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
      stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    },
    live: false,
  },
  {
    key: "arc",
    name: "Arc",
    shortName: "ARC",
    chainId: 5042,
    nativeSymbol: "USDC",
    nativeDecimals: 18,
    explorer: "https://explorer.arc.io",
    publicRpc: "https://rpc.mainnet.arc.io",
    // Uniswap's v3 deployment index does not list Arc; only v4 is confirmed.
    v3: null,
    v4: {
      poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
      positionManager: "0x6049c9a0e26405C0985f9E3685C87d0aE917f82B",
      stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
    },
    live: false,
  },
];

export const CHAIN_BY_KEY = Object.fromEntries(
  CHAINS.map((c) => [c.key, c]),
) as Record<ChainKey, ChainInfo>;
