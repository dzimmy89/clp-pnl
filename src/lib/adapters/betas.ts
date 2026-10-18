import { BETA_COINGECKO, BETA_WINDOW_DAYS, betaFromPrices, type BetaBook } from "@/lib/beta";
import { fetchJson } from "@/lib/http";

interface ChartResponse {
  coins?: Record<string, { prices?: { timestamp: number; price: number }[] }>;
}

const CACHE_MS = 6 * 60 * 60_000;
const globalForBetas = globalThis as unknown as { omnifolioBetas?: Map<string, { at: number; beta: BetaBook[string] | null }> };
const cache = (globalForBetas.omnifolioBetas ??= new Map());

/** Daily closes keyed by UTC day, so two series line up even when a day is missing. */
function byDay(prices: { timestamp: number; price: number }[] = []): Map<number, number> {
  const out = new Map<number, number>();
  for (const point of prices) if (point.price > 0) out.set(Math.floor(point.timestamp / 86_400), point.price);
  return out;
}

/**
 * BTC betas from DefiLlama's daily price history over the last 90 days. Assets DefiLlama
 * can't price, or with under a month of history, are left out and read as assumed.
 */
export async function fetchBetas(underlyings: string[], now = Date.now()): Promise<{ betas: BetaBook; error?: string }> {
  const betas: BetaBook = {};
  const missing: string[] = [];
  for (const underlying of new Set(underlyings)) {
    if (!BETA_COINGECKO[underlying] || underlying === "BTC") continue;
    const hit = cache.get(underlying);
    if (hit && now - hit.at < CACHE_MS) {
      if (hit.beta) betas[underlying] = hit.beta;
    } else missing.push(underlying);
  }
  if (!missing.length) return { betas };

  const start = Math.floor(now / 1000) - (BETA_WINDOW_DAYS + 1) * 86_400;
  const keys = ["coingecko:bitcoin", ...missing.map((u) => `coingecko:${BETA_COINGECKO[u]}`)];
  try {
    for (let i = 1; i < keys.length; i += 25) {
      const chunk = ["coingecko:bitcoin", ...keys.slice(i, i + 25)];
      const body = await fetchJson<ChartResponse>(
        `https://coins.llama.fi/chart/${chunk.join(",")}?start=${start}&span=${BETA_WINDOW_DAYS + 1}&period=1d&searchWidth=600`,
        {},
        20_000,
      );
      const btc = byDay(body.coins?.["coingecko:bitcoin"]?.prices);
      for (const key of chunk.slice(1)) {
        const underlying = missing.find((u) => `coingecko:${BETA_COINGECKO[u]}` === key);
        if (!underlying) continue;
        const asset = byDay(body.coins?.[key]?.prices);
        const days = [...asset.keys()].filter((day) => btc.has(day)).sort((a, b) => a - b);
        const measured = betaFromPrices(days.map((d) => asset.get(d)!), days.map((d) => btc.get(d)!));
        const beta = measured ? { ...measured, source: "history" as const } : null;
        cache.set(underlying, { at: now, beta });
        if (beta) betas[underlying] = beta;
      }
    }
    return { betas };
  } catch (error) {
    return { betas, error: error instanceof Error ? error.message : "Price history request failed" };
  }
}
