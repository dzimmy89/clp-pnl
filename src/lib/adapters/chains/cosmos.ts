import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import {
  emptyRead,
  getJson,
  legOf,
  llamaPrices,
  positionOf,
  shortError,
  spotRow,
  units,
  type ChainDeps,
  type ChainRead,
  type ChainReader,
} from "@/lib/adapters/chains/common";
import type { Leg, Position, SpotHolding } from "@/lib/types";

/**
 * Cosmos reader. One bech32 address is re-encoded for every coin-type-118 chain below and each
 * chain is read through the public cosmos.directory REST proxy (https://rest.cosmos.directory/<chain>):
 * bank balances, staking delegations, unbonding delegations and distribution rewards. Prices come
 * from DefiLlama by CoinGecko id. Unknown native denoms and unknown IBC denoms are skipped.
 */

const REST = "https://rest.cosmos.directory";
const CONCURRENCY = 7;
const TIMEOUT_MS = 7_000;

/** symbol → [decimals, CoinGecko id] */
const ASSETS: Record<string, [number, string]> = {
  ATOM: [6, "cosmos"],
  OSMO: [6, "osmosis"],
  ION: [6, "ion"],
  TIA: [6, "celestia"],
  DYDX: [18, "dydx-chain"],
  STRD: [6, "stride"],
  AKT: [6, "akash-network"],
  JUNO: [6, "juno-network"],
  STARS: [6, "stargaze"],
  NTRN: [6, "neutron-3"],
  USDC: [6, "usd-coin"],
  KUJI: [6, "kujira"],
  AXL: [6, "axelar"],
  XPRT: [6, "persistence"],
  stATOM: [6, "stride-staked-atom"],
  stTIA: [6, "stride-staked-tia"],
  stOSMO: [6, "stride-staked-osmo"],
};

/** The `ibc/…` denom of a token that arrived over `transfer/<channel>/<base denom>`. */
export function ibcDenom(path: string): string {
  return `ibc/${Buffer.from(sha256(new TextEncoder().encode(`transfer/${path}`))).toString("hex").toUpperCase()}`;
}

interface CosmosChain {
  id: string;
  name: string;
  prefix: string;
  /** denom → symbol in ASSETS. */
  denoms: Record<string, string>;
  /** IBC path (`channel-N/base`) → symbol, for the few well-known IBC tokens. */
  ibc?: Record<string, string>;
  staking?: boolean;
}

export const COSMOS_CHAINS: CosmosChain[] = [
  { id: "cosmoshub", name: "Cosmos Hub", prefix: "cosmos", denoms: { uatom: "ATOM" }, ibc: { "channel-536/uusdc": "USDC", "channel-141/uosmo": "OSMO" } },
  {
    id: "osmosis",
    name: "Osmosis",
    prefix: "osmo",
    denoms: { uosmo: "OSMO", uion: "ION" },
    ibc: {
      "channel-750/uusdc": "USDC",
      "channel-0/uatom": "ATOM",
      "channel-6994/utia": "TIA",
      "channel-874/untrn": "NTRN",
      "channel-1/uakt": "AKT",
      "channel-326/stuatom": "stATOM",
      "channel-326/stutia": "stTIA",
    },
  },
  { id: "celestia", name: "Celestia", prefix: "celestia", denoms: { utia: "TIA" } },
  { id: "dydx", name: "dYdX", prefix: "dydx", denoms: { adydx: "DYDX" }, ibc: { "channel-0/uusdc": "USDC" } },
  {
    id: "stride",
    name: "Stride",
    prefix: "stride",
    denoms: { ustrd: "STRD", stuatom: "stATOM", stutia: "stTIA", stuosmo: "stOSMO" },
    ibc: { "channel-0/uatom": "ATOM" },
  },
  { id: "akash", name: "Akash", prefix: "akash", denoms: { uakt: "AKT" } },
  { id: "juno", name: "Juno", prefix: "juno", denoms: { ujuno: "JUNO" } },
  { id: "stargaze", name: "Stargaze", prefix: "stars", denoms: { ustars: "STARS" } },
  {
    id: "neutron",
    name: "Neutron",
    prefix: "neutron",
    denoms: { untrn: "NTRN" },
    ibc: { "channel-30/uusdc": "USDC", "channel-1/uatom": "ATOM", "channel-35/utia": "TIA", "channel-10/uosmo": "OSMO" },
  },
  { id: "noble", name: "Noble", prefix: "noble", denoms: { uusdc: "USDC" }, staking: false },
  { id: "kujira", name: "Kujira", prefix: "kujira", denoms: { ukuji: "KUJI" }, ibc: { "channel-62/uusdc": "USDC" } },
  { id: "axelar", name: "Axelar", prefix: "axelar", denoms: { uaxl: "AXL" } },
  { id: "persistence", name: "Persistence", prefix: "persistence", denoms: { uxprt: "XPRT" } },
];

const DENOMS = new Map(
  COSMOS_CHAINS.map((chain) => [
    chain.id,
    {
      ...chain.denoms,
      ...Object.fromEntries(Object.entries(chain.ibc ?? {}).map(([path, symbol]) => [ibcDenom(path), symbol])),
    } as Record<string, string>,
  ]),
);

/** Prefixes of chains whose accounts derive from a different key, so re-encoding would point elsewhere. */
const OTHER_KEY_PREFIXES = new Set(["inj", "evmos", "terra", "secret", "cro", "kava", "band", "dym", "thor", "zeta"]);

/** The 20- or 32-byte account behind a bech32 address. Throws on anything else. */
export function cosmosAccountBytes(address: string): Uint8Array {
  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(address.trim().toLowerCase() as `${string}1${string}`);
  } catch {
    throw new Error("Not a Cosmos bech32 address");
  }
  if (OTHER_KEY_PREFIXES.has(decoded.prefix)) {
    throw new Error(`${decoded.prefix}1… addresses use a different key; add a cosmos1… address instead`);
  }
  const bytes = bech32.fromWords(decoded.words);
  if (bytes.length !== 20 && bytes.length !== 32) throw new Error("Not a Cosmos account address");
  return bytes;
}

interface Coin {
  denom: string;
  amount: string;
}
interface BalancesResponse {
  balances?: Coin[];
}
interface DelegationsResponse {
  delegation_responses?: { delegation?: { validator_address?: string }; balance?: Coin }[];
}
interface UnbondingResponse {
  unbonding_responses?: { entries?: { completion_time?: string; balance?: string }[] }[];
}
interface RewardsResponse {
  total?: Coin[];
}

interface ChainData {
  chain: CosmosChain;
  address: string;
  balances: Coin[];
  delegations: NonNullable<DelegationsResponse["delegation_responses"]>;
  unbonding: NonNullable<UnbondingResponse["unbonding_responses"]>;
  rewards: Coin[];
}

/** Staking queries on chains without the module return 404/501; that just means nothing staked. */
async function optional<T>(task: Promise<T>, empty: T): Promise<T> {
  try {
    return await task;
  } catch (error) {
    if (/returned (404|501)\b/.test(shortError(error))) return empty;
    throw error;
  }
}

async function readChain(chain: CosmosChain, address: string, notes: string[], deps: ChainDeps): Promise<ChainData | null> {
  const get = <T>(path: string) => getJson<T>(`${REST}/${chain.id}${path}`, { timeoutMs: TIMEOUT_MS }, deps);
  const staking = chain.staking !== false;
  const [bank, delegations, unbonding, rewards] = await Promise.allSettled([
    get<BalancesResponse>(`/cosmos/bank/v1beta1/balances/${address}?pagination.limit=500`),
    staking ? optional(get<DelegationsResponse>(`/cosmos/staking/v1beta1/delegations/${address}`), {}) : {},
    staking ? optional(get<UnbondingResponse>(`/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations`), {}) : {},
    staking ? optional(get<RewardsResponse>(`/cosmos/distribution/v1beta1/delegators/${address}/rewards`), {}) : {},
  ]);
  if (bank.status === "rejected") {
    notes.push(`${chain.name}: ${shortError(bank.reason)}`);
    return null;
  }
  const failed = [delegations, unbonding, rewards].find((result) => result.status === "rejected");
  if (failed?.status === "rejected") notes.push(`${chain.name} staking: ${shortError(failed.reason)}`);
  const value = <T>(result: PromiseSettledResult<T>): T | Record<string, never> =>
    result.status === "fulfilled" ? result.value : {};
  return {
    chain,
    address,
    balances: bank.value.balances ?? [],
    delegations: (value(delegations) as DelegationsResponse).delegation_responses ?? [],
    unbonding: (value(unbonding) as UnbondingResponse).unbonding_responses ?? [],
    rewards: (value(rewards) as RewardsResponse).total ?? [],
  };
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Sums coins by known symbol; unknown denoms are dropped. */
function sumKnown(chainId: string, coins: Coin[]): Map<string, number> {
  const denoms = DENOMS.get(chainId) ?? {};
  const out = new Map<string, number>();
  for (const coin of coins) {
    const symbol = denoms[coin.denom];
    if (!symbol) continue;
    const amount = units(coin.amount, ASSETS[symbol][0]);
    if (amount > 0) out.set(symbol, (out.get(symbol) ?? 0) + amount);
  }
  return out;
}

export const readCosmos: ChainReader = async (address, deps = {}) => {
  const bytes = cosmosAccountBytes(address);
  const wallet = address.trim();
  const out: ChainRead = emptyRead();

  const results = await mapLimit(COSMOS_CHAINS, CONCURRENCY, (chain) =>
    readChain(chain, bech32.encode(chain.prefix, bech32.toWords(bytes)), out.notes, deps),
  );
  const chains = results.filter((item): item is ChainData => item !== null);
  if (!chains.length) throw new Error(`Cosmos REST unreachable (${out.notes[0] ?? "no chains"})`);

  const prices = await llamaPrices(
    Object.values(ASSETS).map(([, id]) => `coingecko:${id}`),
    deps,
  );
  const priceOf = (symbol: string) => prices[`coingecko:${ASSETS[symbol][1]}`] ?? null;

  const spot: SpotHolding[] = [];
  const positions: Position[] = [];
  for (const data of chains) {
    const { chain } = data;
    const legs = (kind: string, amounts: Map<string, number>): Leg[] =>
      [...amounts].map(([symbol, amount]) =>
        legOf({ id: `${chain.id}:${kind}:${symbol}`, side: "supply", symbol, amount, price: priceOf(symbol), isCollateral: false }),
      );

    for (const [symbol, amount] of sumKnown(chain.id, data.balances)) {
      const row = spotRow({ protocol: "cosmos", wallet, chain: chain.name, symbol, amount, price: priceOf(symbol), tokenId: `${chain.id}:${symbol}` });
      if (row) spot.push(row);
    }

    const app = `${chain.name} staking`;
    const validators = new Set(data.delegations.map((item) => item.delegation?.validator_address).filter(Boolean)).size;
    const staked = positionOf({
      protocol: "cosmos",
      app,
      category: "staking",
      chain: chain.name,
      wallet,
      label: app,
      legs: legs("staked", sumKnown(chain.id, data.delegations.flatMap((item) => (item.balance ? [item.balance] : [])))),
      note: validators ? `${validators} validator${validators === 1 ? "" : "s"}` : undefined,
    });

    const nativeDenom = Object.keys(chain.denoms)[0];
    const entries = data.unbonding.flatMap((item) => item.entries ?? []);
    const nextUnlock = entries
      .map((entry) => entry.completion_time)
      .filter((time): time is string => Boolean(time))
      .sort()[0];
    const unbonding = positionOf({
      protocol: "cosmos",
      app,
      category: "locked",
      chain: chain.name,
      wallet,
      label: `${chain.name} unbonding`,
      legs: legs("unbonding", sumKnown(chain.id, entries.map((entry) => ({ denom: nativeDenom, amount: entry.balance ?? "0" })))),
      note: nextUnlock ? `Next unlock ${nextUnlock.slice(0, 10)}` : undefined,
    });

    const rewards = positionOf({
      protocol: "cosmos",
      app,
      category: "rewards",
      chain: chain.name,
      wallet,
      label: `${chain.name} staking rewards`,
      legs: legs("rewards", sumKnown(chain.id, data.rewards)),
    });

    for (const position of [staked, unbonding, rewards]) if (position) positions.push(position);
  }

  out.spot = spot.sort((a, b) => b.usd - a.usd).slice(0, 100);
  out.positions = positions;
  return out;
};
