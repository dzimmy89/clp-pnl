/** One net-worth reading. `t` is epoch ms. */
export interface HistoryPoint {
  t: number;
  usd: number;
}

/** Readings closer together than this replace the previous one instead of adding a point. */
export const MIN_GAP_MS = 15 * 60 * 1000;
export const MAX_POINTS = 3000;

export const RANGES = [
  { id: "7d", label: "7D", days: 7 },
  { id: "30d", label: "30D", days: 30 },
  { id: "90d", label: "90D", days: 90 },
  { id: "all", label: "All", days: null },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];

export function appendPoint(points: HistoryPoint[], point: HistoryPoint): HistoryPoint[] {
  if (!Number.isFinite(point.usd)) return points;
  const last = points[points.length - 1];
  const next = last && point.t - last.t < MIN_GAP_MS ? [...points.slice(0, -1), point] : [...points, point];
  return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
}

export function pointsInRange(points: HistoryPoint[], range: RangeId, now = Date.now()): HistoryPoint[] {
  const days = RANGES.find((r) => r.id === range)?.days ?? null;
  if (days == null) return points;
  const from = now - days * 24 * 60 * 60 * 1000;
  return points.filter((point) => point.t >= from);
}

/** Change from the first to the last point in view, as a decimal. */
export function changeOver(points: HistoryPoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].usd;
  const last = points[points.length - 1].usd;
  if (first === 0) return null;
  return (last - first) / Math.abs(first);
}

/**
 * Change from the reading nearest `ms` ago to `current`. Readings within the last third of
 * the window are too recent to count, so a fresh series shows nothing rather than a
 * misleading "24h" figure built from ten minutes of data.
 */
export function changeSince(
  points: HistoryPoint[],
  current: number,
  ms: number,
  now = Date.now(),
): { usd: number; pct: number | null; since: number } | null {
  const target = now - ms;
  let best: HistoryPoint | null = null;
  for (const point of points) {
    if (point.t > now - ms / 3) continue;
    if (!best || Math.abs(point.t - target) < Math.abs(best.t - target)) best = point;
  }
  if (!best || !Number.isFinite(current)) return null;
  const usd = current - best.usd;
  return { usd, pct: best.usd === 0 ? null : usd / Math.abs(best.usd), since: best.t };
}

/** One reading for one series: `book:<account or device>` or `wallet:<address key>`. */
export interface HistoryWrite extends HistoryPoint {
  scope: string;
}

/** Most readings one request to the account history may carry. */
export const MAX_HISTORY_WRITE = 1000;

export function isHistoryScope(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^(book|wallet):\S+$/.test(value);
}

/** Keeps well-formed readings from the last ten years (and none from the future). */
export function validHistoryWrites(value: unknown, now = Date.now()): HistoryWrite[] {
  if (!Array.isArray(value)) return [];
  const oldest = now - 10 * 365 * 24 * 60 * 60 * 1000;
  return value.filter(
    (item): item is HistoryWrite =>
      typeof item === "object" &&
      item !== null &&
      isHistoryScope(item.scope) &&
      Number.isFinite(item.t) &&
      item.t >= oldest &&
      item.t <= now + 60 * 60 * 1000 &&
      Number.isFinite(item.usd),
  );
}

/**
 * The 15-minute bucket a reading falls in. The account keeps one reading per scope and
 * bucket (the latest), the same spacing `appendPoint` keeps in the browser.
 */
export function historyBucket(t: number): number {
  return Math.floor(t / MIN_GAP_MS);
}

/** One reading per scope and bucket, the latest one, so a batch never hits the same row twice. */
export function dedupeWrites(writes: HistoryWrite[]): HistoryWrite[] {
  const latest = new Map<string, HistoryWrite>();
  for (const write of writes) {
    const key = `${write.scope}|${historyBucket(write.t)}`;
    const seen = latest.get(key);
    if (!seen || write.t >= seen.t) latest.set(key, write);
  }
  return [...latest.values()];
}

const KEY = "hedge-ledger.history.v1";

/**
 * Snapshots live in this browser, one series per set of wallets, since there is no
 * indexer to replay balances. The chart starts empty and fills as the app is opened.
 */
export function loadHistory(scope: string): HistoryPoint[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, HistoryPoint[]>;
    return Array.isArray(all[scope]) ? all[scope] : [];
  } catch {
    return [];
  }
}

export function recordHistory(scope: string, point: HistoryPoint): HistoryPoint[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, HistoryPoint[]>;
    const next = appendPoint(Array.isArray(all[scope]) ? all[scope] : [], point);
    all[scope] = next;
    window.localStorage.setItem(KEY, JSON.stringify(all));
    return next;
  } catch {
    return [point];
  }
}

/** Every series saved in this browser, for copying them to an account on first sign-in. */
export function allLocalHistory(): Record<string, HistoryPoint[]> {
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, HistoryPoint[]>;
    return Object.fromEntries(Object.entries(all).filter(([, points]) => Array.isArray(points)));
  } catch {
    return {};
  }
}

export function clearLocalHistory() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: nothing saved to clear.
  }
}

/** A fixed 30-day series for the example book, so the chart has something to show. */
export function exampleHistory(endUsd: number, now = Date.now()): HistoryPoint[] {
  const day = 24 * 60 * 60 * 1000;
  const out: HistoryPoint[] = [];
  for (let i = 30; i >= 0; i--) {
    const wobble = Math.sin(i * 0.7) * 0.025 + Math.sin(i * 0.23) * 0.04 - i * 0.0015;
    out.push({ t: now - i * day, usd: endUsd * (1 + wobble) });
  }
  out[out.length - 1] = { t: now, usd: endUsd };
  return out;
}
