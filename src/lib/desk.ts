import { DEFAULT_GOALS, type Goals } from "@/lib/advisor";
import { DEFAULT_THRESHOLDS } from "@/lib/alerts";
import { walletKey } from "@/lib/wallet-set";
import { WALLET_KINDS, type Addresses, type BookMode, type PastedWallet, type Position, type SpotHolding, type Thresholds } from "@/lib/types";

/**
 * Everything the desk keeps besides live reads: pasted addresses, books and balances entered
 * by hand, targets and goals. It lives in the browser, and on the account when signed in.
 */
export interface SavedDesk {
  /** Addresses tracked without linking, any number per chain. */
  pasted: PastedWallet[];
  mode: BookMode;
  manual: Position[];
  /** Wallet balances entered by hand, for chains with no public balance read (e.g. Canton). */
  manualSpot: SpotHolding[];
  thresholds: Thresholds;
  hedgeTargets: Record<string, number>;
  /** Per-position leverage targets for the advisor, keyed by position id. */
  leverageTargets: Record<string, number>;
  goals: Goals;
  /** The account this copy was last saved to. Browser-only; never sent to the server. */
  syncedAccount?: string;
}

/** The part of the desk saved on the account. Mode and sync bookkeeping stay per browser. */
export type AccountDesk = Omit<SavedDesk, "mode" | "syncedAccount">;

/** Upper bound on a saved desk, in bytes of JSON, so one account can't fill the database. */
export const MAX_DESK_BYTES = 256 * 1024;

export function defaultDesk(): SavedDesk {
  return {
    pasted: [],
    mode: "example",
    manual: [],
    manualSpot: [],
    thresholds: { ...DEFAULT_THRESHOLDS },
    hedgeTargets: {},
    leverageTargets: {},
    goals: { ...DEFAULT_GOALS },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isPastedWallet(value: unknown): value is PastedWallet {
  const wallet = value as PastedWallet | null;
  return (
    typeof wallet?.address === "string" &&
    wallet.address.trim() !== "" &&
    (WALLET_KINDS as readonly string[]).includes(wallet.kind) &&
    (wallet.label === undefined || typeof wallet.label === "string")
  );
}

function isPosition(value: unknown): value is Position {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    Array.isArray(value.legs) &&
    value.legs.every((leg) => isRecord(leg) && typeof leg.symbol === "string" && finite(leg.amount) && finite(leg.usd))
  );
}

function isSpot(value: unknown): value is SpotHolding {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.symbol === "string" &&
    typeof value.chain === "string" &&
    finite(value.amount) &&
    finite(value.usd)
  );
}

function numberMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => finite(entry[1])));
}

function parseGoals(value: unknown): Goals {
  const goals = isRecord(value) ? value : {};
  const optional = (field: unknown) => (finite(field) ? field : null);
  return {
    healthTarget: finite(goals.healthTarget) ? goals.healthTarget : DEFAULT_GOALS.healthTarget,
    portfolioLeverage: optional(goals.portfolioLeverage),
    portfolioBeta: optional(goals.portfolioBeta),
  };
}

/** The saved list, or the single address per chain that older versions kept. */
export function loadPasted(parsed: { pasted?: unknown; addresses?: Partial<Addresses> }): PastedWallet[] {
  if (Array.isArray(parsed.pasted)) return parsed.pasted.filter(isPastedWallet);
  const legacy = parsed.addresses ?? {};
  return (["evm", "solana", "near", "canton"] as const)
    .map((kind) => ({ kind, address: (legacy[kind] ?? "").trim() }))
    .filter((wallet) => wallet.address !== "");
}

/** Reads a desk from untrusted JSON (browser storage or the server), dropping anything malformed. */
export function parseDesk(raw: unknown): SavedDesk {
  const base = defaultDesk();
  if (!isRecord(raw)) return base;
  return {
    pasted: loadPasted(raw as { pasted?: unknown; addresses?: Partial<Addresses> }),
    mode: raw.mode === "live" ? "live" : "example",
    manual: Array.isArray(raw.manual) ? raw.manual.filter(isPosition) : [],
    manualSpot: Array.isArray(raw.manualSpot) ? raw.manualSpot.filter(isSpot) : [],
    thresholds: { ...base.thresholds, ...(isRecord(raw.thresholds) ? numberMap(raw.thresholds) : {}) },
    hedgeTargets: numberMap(raw.hedgeTargets),
    leverageTargets: numberMap(raw.leverageTargets),
    goals: parseGoals(raw.goals),
    syncedAccount: typeof raw.syncedAccount === "string" ? raw.syncedAccount : undefined,
  };
}

export function accountPart(desk: SavedDesk): AccountDesk {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- dropping browser-only fields
  const { mode, syncedAccount, ...rest } = desk;
  return rest;
}

function unionBy<T>(first: T[], second: T[], key: (item: T) => string): T[] {
  const seen = new Set(first.map(key));
  return [...first, ...second.filter((item) => !seen.has(key(item)))];
}

/**
 * The first time this browser's desk meets an account, nothing on either side is dropped:
 * the account's copy wins where both have a value, and the browser adds what it alone has.
 */
export function mergeDesks(account: AccountDesk, local: SavedDesk): SavedDesk {
  return {
    ...local,
    ...account,
    pasted: unionBy(account.pasted, local.pasted, (w) => `${w.kind}:${walletKey(w.address)}`),
    manual: unionBy(account.manual, local.manual, (p) => p.id),
    manualSpot: unionBy(account.manualSpot, local.manualSpot, (s) => s.id),
    hedgeTargets: { ...local.hedgeTargets, ...account.hedgeTargets },
    leverageTargets: { ...local.leverageTargets, ...account.leverageTargets },
  };
}
