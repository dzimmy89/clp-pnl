import { positionAppName, type Position, type PositionCategory, type SpotHolding } from "@/lib/types";

/**
 * Narrows the book to one chain, one app and/or one kind of position. Wallet balances
 * belong to no app, so picking an app or a position type hides them; "wallet" shows only them.
 */
export interface ViewFilter {
  chain: string | null;
  app: string | null;
  type: PositionCategory | "wallet" | null;
}

export const NO_FILTER: ViewFilter = { chain: null, app: null, type: null };

export const TYPE_LABEL: Record<PositionCategory | "wallet", string> = {
  lending: "Lending",
  staking: "Staking",
  liquidity: "Liquidity",
  yield: "Yield",
  locked: "Locked",
  rewards: "Rewards",
  other: "Other",
  wallet: "Wallet balances",
};

/** Positions from the older single-app readers carry no category; they are all lending. */
export function categoryOf(position: Pick<Position, "category">): PositionCategory {
  return position.category ?? "lending";
}

export function isLending(position: Pick<Position, "category">): boolean {
  return categoryOf(position) === "lending";
}

export function positionNetUsd(position: Position): number {
  return position.legs.reduce((sum, leg) => sum + (leg.side === "supply" ? leg.usd : -leg.usd), 0);
}

export function applyViewFilter(
  positions: Position[],
  spot: SpotHolding[],
  filter: ViewFilter,
): { positions: Position[]; spot: SpotHolding[] } {
  const chainOk = (chain: string) => !filter.chain || chain === filter.chain;
  return {
    positions:
      filter.type === "wallet"
        ? []
        : positions.filter(
            (position) =>
              chainOk(position.chain) &&
              (!filter.app || positionAppName(position) === filter.app) &&
              (!filter.type || categoryOf(position) === filter.type),
          ),
    spot: filter.app || (filter.type && filter.type !== "wallet") ? [] : spot.filter((holding) => chainOk(holding.chain)),
  };
}

/** Choices for each filter, largest value first, drawn from the unfiltered book. */
export function filterOptions(positions: Position[], spot: SpotHolding[]) {
  const chains = new Map<string, number>();
  const apps = new Map<string, number>();
  const types = new Set<PositionCategory | "wallet">();
  for (const position of positions) {
    const usd = Math.abs(positionNetUsd(position));
    chains.set(position.chain, (chains.get(position.chain) ?? 0) + usd);
    const app = positionAppName(position);
    apps.set(app, (apps.get(app) ?? 0) + usd);
    types.add(categoryOf(position));
  }
  for (const holding of spot) {
    chains.set(holding.chain, (chains.get(holding.chain) ?? 0) + holding.usd);
    types.add("wallet");
  }
  const byValue = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const order = Object.keys(TYPE_LABEL) as (PositionCategory | "wallet")[];
  return { chains: byValue(chains), apps: byValue(apps), types: order.filter((type) => types.has(type)) };
}

/** Keeps only the parts of a filter that still match something in the book. */
export function validFilter(filter: ViewFilter, options: ReturnType<typeof filterOptions>): ViewFilter {
  return {
    chain: filter.chain && options.chains.includes(filter.chain) ? filter.chain : null,
    app: filter.app && options.apps.includes(filter.app) ? filter.app : null,
    type: filter.type && options.types.includes(filter.type) ? filter.type : null,
  };
}

export interface AppGroup {
  app: string;
  chains: string[];
  types: PositionCategory[];
  netUsd: number;
  positions: Position[];
}

/** Every position grouped by the app it lives in, largest first. */
export function appGroups(positions: Position[]): AppGroup[] {
  const groups = new Map<string, AppGroup>();
  for (const position of positions) {
    const app = positionAppName(position);
    const group = groups.get(app) ?? { app, chains: [], types: [], netUsd: 0, positions: [] };
    if (!group.chains.includes(position.chain)) group.chains.push(position.chain);
    const type = categoryOf(position);
    if (!group.types.includes(type)) group.types.push(type);
    group.netUsd += positionNetUsd(position);
    group.positions.push(position);
    groups.set(app, group);
  }
  for (const group of groups.values()) group.positions.sort((a, b) => positionNetUsd(b) - positionNetUsd(a));
  return [...groups.values()].sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd));
}
