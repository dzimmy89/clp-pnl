import type { LpPosition } from "@/lib/lp/types";

export const PROTOCOL_IDS = [
  "aave",
  "kamino",
  "hyperlend",
  "venus",
  "rhea",
  "alpend",
  "zerion",
  "gmx",
  "solana-apps",
  "sui",
  "aptos",
  "ton",
  "tron",
  "cosmos",
  "starknet",
  "cardano",
  "kaspa",
  "uniswap",
] as const;

/** Every kind of address the book can read. Wallets on these chains are queried. */
export const WALLET_KINDS = [
  "evm",
  "solana",
  "near",
  "canton",
  "sui",
  "aptos",
  "ton",
  "tron",
  "cosmos",
  "starknet",
  "cardano",
  "kaspa",
] as const;

export type WalletKind = (typeof WALLET_KINDS)[number];

export type ProtocolId = (typeof PROTOCOL_IDS)[number];

export type BookMode = "example" | "live";

export type AssetKind = "volatile" | "stable" | "btc";

export type DataSource = "example" | "live" | "manual";

export type HealthSource = "protocol" | "estimated";

export interface ProtocolMeta {
  id: ProtocolId;
  name: string;
  chain: string;
  addressKind: WalletKind;
  /** Public read of positions is implemented. Alpend is manual. */
  readsLive: boolean;
  /** Reads a whole chain or many apps at once, so it isn't offered for manual entry. */
  aggregate?: boolean;
}

export const PROTOCOLS: readonly ProtocolMeta[] = [
  {
    id: "aave",
    name: "Aave",
    chain: "Ethereum",
    addressKind: "evm",
    readsLive: true,
  },
  {
    id: "kamino",
    name: "Kamino Finance",
    chain: "Solana",
    addressKind: "solana",
    readsLive: true,
  },
  {
    id: "hyperlend",
    name: "Hyperlend",
    chain: "HyperEVM",
    addressKind: "evm",
    readsLive: true,
  },
  {
    id: "venus",
    name: "Venus Protocol",
    chain: "BNB Chain",
    addressKind: "evm",
    readsLive: true,
  },
  {
    id: "rhea",
    name: "Rhea Finance",
    chain: "NEAR",
    addressKind: "near",
    readsLive: true,
  },
  {
    id: "alpend",
    name: "Alpend",
    chain: "Canton",
    addressKind: "canton",
    readsLive: false,
  },
  {
    id: "zerion",
    name: "Every EVM protocol",
    chain: "All EVM chains, via Zerion",
    addressKind: "evm",
    readsLive: true,
    aggregate: true,
  },
  { id: "gmx", name: "GMX perpetuals", chain: "Arbitrum", addressKind: "evm", readsLive: true, aggregate: true },
  { id: "solana-apps", name: "More Solana apps", chain: "Solana", addressKind: "solana", readsLive: true, aggregate: true },
  { id: "sui", name: "Sui wallet and apps", chain: "Sui", addressKind: "sui", readsLive: true, aggregate: true },
  { id: "aptos", name: "Aptos wallet and apps", chain: "Aptos", addressKind: "aptos", readsLive: true, aggregate: true },
  { id: "ton", name: "TON wallet and apps", chain: "TON", addressKind: "ton", readsLive: true, aggregate: true },
  { id: "tron", name: "Tron wallet and apps", chain: "Tron", addressKind: "tron", readsLive: true, aggregate: true },
  { id: "cosmos", name: "Cosmos wallets and staking", chain: "Cosmos Hub, Osmosis and more", addressKind: "cosmos", readsLive: true, aggregate: true },
  { id: "starknet", name: "Starknet wallet and apps", chain: "Starknet", addressKind: "starknet", readsLive: true, aggregate: true },
  { id: "cardano", name: "Cardano wallet and staking", chain: "Cardano", addressKind: "cardano", readsLive: true, aggregate: true },
  { id: "kaspa", name: "Kaspa wallet", chain: "Kaspa", addressKind: "kaspa", readsLive: true, aggregate: true },
  {
    id: "uniswap",
    name: "Uniswap V3 & V4 liquidity",
    chain: "Ethereum, Base, Arbitrum, BNB Chain, Robinhood Chain, Arc",
    addressKind: "evm",
    readsLive: true,
    aggregate: true,
  },
];

/** Protocols a person can add a position for by hand. Whole-chain readers are read only. */
export const MANUAL_PROTOCOLS: readonly ProtocolMeta[] = PROTOCOLS.filter((meta) => !meta.aggregate);

/** Display name of the app holding a position: the app itself when known, else its source. */
export function positionAppName(position: Pick<Position, "protocol" | "app">): string {
  return position.app ?? protocolMeta(position.protocol).name;
}

export function protocolMeta(id: ProtocolId): ProtocolMeta {
  const found = PROTOCOLS.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown protocol: ${String(id)}`);
  return found;
}

export interface Leg {
  id: string;
  side: "supply" | "borrow";
  symbol: string;
  /** Hedge and shock group. WBTC and cbBTC share BTC. */
  underlying: string;
  kind: AssetKind;
  /** Token units, not USD. */
  amount: number;
  usd: number;
  /** Decimal rate. 0.05 is 5%. Supply APY on supply legs, borrow APY on borrow legs. */
  apy: number;
  /** The source reports no rate. `apy` is 0 and the UI shows "—" instead. */
  apyUnknown?: boolean;
  priceUsd?: number;
  /** Manual books only: true when the typed price stays put instead of following the market. */
  fixedPrice?: boolean;
  /** Manual books only: when the live price was last applied (ms). */
  pricedAt?: number;
  /** Manual books only: the coin the ticker was priced as. */
  priceName?: string;
  /** Decimal liquidation threshold. 0.80 is 80%. Supply legs. */
  liquidationThreshold?: number;
  /** Where the threshold came from. Assumed values are labeled in the UI. */
  liquidationThresholdSource?: "protocol" | "assumed";
  isCollateral?: boolean;
}

/** What kind of position this is. Lending positions carry borrows and a health factor. */
export type PositionCategory = "lending" | "staking" | "liquidity" | "yield" | "locked" | "rewards" | "other";

export interface Position {
  id: string;
  protocol: ProtocolId;
  /** The app the position lives in, when the source covers many (e.g. "Aave V3" from Zerion). */
  app?: string;
  category?: PositionCategory;
  chain: string;
  wallet: string;
  label: string;
  source: DataSource;
  legs: Leg[];
  /** Protocol-reported health factor, when the adapter has one. */
  healthFactor?: number | null;
  healthFactorSource?: HealthSource;
  /** Per-position hedge target. Decimal ratio, 0.30 means borrow 30% of supplied units. */
  targetHedgeRatio?: number;
  note?: string;
  fetchedAt?: string;
  /** Uniswap positions only: the concentrated-liquidity detail behind the legs (range, fees, pool price). */
  lp?: LpPosition;
}

export interface SpotHolding {
  id: string;
  wallet: string;
  chain: string;
  symbol: string;
  underlying: string;
  kind: AssetKind;
  amount: number;
  usd: number;
  priceUsd: number;
  source: DataSource;
  unpriced?: boolean;
  /** Entered by hand only: true when the typed price stays put instead of following the market. */
  fixedPrice?: boolean;
  /** Entered by hand only: when the live price was last applied (ms). */
  pricedAt?: number;
  /** Entered by hand only: the coin the ticker was priced as, e.g. "Canton Coin". */
  priceName?: string;
}

export interface Addresses {
  evm: string;
  solana: string;
  near: string;
  canton: string;
}

/** An address pasted on this device and tracked without linking it to an account. */
export interface PastedWallet {
  kind: WalletKind;
  address: string;
  label?: string;
}

/** Every wallet the book reads, grouped by address kind. */
export type WalletSet = Record<WalletKind, string[]>;

export function emptyWalletSet(): WalletSet {
  return Object.fromEntries(WALLET_KINDS.map((kind) => [kind, []])) as unknown as WalletSet;
}

export const EMPTY_WALLET_SET: WalletSet = emptyWalletSet();

export interface Thresholds {
  healthWarning: number;
  healthCritical: number;
  /** Decimal net APY floor. 0 means flag negative carry. */
  minNetApy: number;
  maxLeverage: number;
  /** Absolute hedge-ratio drift. 0.05 means 5 percentage points. */
  hedgeTolerance: number;
  /** Fraction. 0.15 means alert when spot is within 15% of liquidation. */
  liquidationProximity: number;
  defaultTargetHedge: number;
}

export type ProtocolStatus = "ok" | "error" | "skipped" | "manual" | "loading";

export interface ProtocolFetch {
  id: ProtocolId;
  name: string;
  chain: string;
  status: Exclude<ProtocolStatus, "loading">;
  message?: string;
  positions: Position[];
  spot: SpotHolding[];
}

export interface BookResponse {
  fetchedAt: string;
  btcPrice: number | null;
  priceTimestamp: number | null;
  priceError?: string;
  protocols: ProtocolFetch[];
  spot: SpotHolding[];
  spotNotes: string[];
}
