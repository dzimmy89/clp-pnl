interface RateWindow {
  count: number;
  resetAt: number;
}

const globalForLimits = globalThis as unknown as { omnifolioLimits?: Map<string, RateWindow> };
const windows = (globalForLimits.omnifolioLimits ??= new Map());

/**
 * Fixed-window limit per client IP, kept in this server instance's memory. It does not
 * coordinate across instances, so it blunts scripted abuse of one warm instance rather
 * than enforcing an exact global quota.
 */
export function hit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: boolean; retryAfter: number } {
  if (windows.size > 10_000) {
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
  }
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  current.count += 1;
  return { ok: current.count <= limit, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
}
