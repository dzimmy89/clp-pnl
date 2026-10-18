import { isStableSymbol, underlyingOf } from "@/lib/assets";
import { BETA_COINGECKO } from "@/lib/beta";
import { fetchJson } from "@/lib/http";
import { symbolToLlamaKey } from "@/lib/adapters/prices";

/**
 * Live USD prices by ticker, for balances and books entered by hand. Tickers the app already
 * knows map straight to a CoinGecko id, and wrapped tickers (CBTC, WETH) to their base asset.
 * Dollar stables are $1. Any other ticker is looked up with CoinGecko's search and the largest
 * coin by market cap with that exact ticker wins. Prices come from DefiLlama.
 */

export interface TokenPrice {
  usd: number;
  /** CoinGecko id the price is for, so a clash between two tokens with one ticker shows. */
  id: string;
  name?: string;
}

export interface TokenPriceResult {
  prices: Record<string, TokenPrice>;
  /** Tickers with no price found. */
  missing: string[];
  error?: string;
}

interface SearchResponse {
  coins?: { id?: string; name?: string; symbol?: string; market_cap_rank?: number | null }[];
}

interface LlamaResponse {
  coins?: Record<string, { price?: number }>;
}

/** A ticker's CoinGecko id is stable, so lookups are kept for a day (misses for an hour). */
const ID_CACHE_MS = 24 * 60 * 60_000;
const MISS_CACHE_MS = 60 * 60_000;
const PRICE_CACHE_MS = 60_000;
/** CoinGecko's keyless search allows only a few calls a minute, so each request does a few at most. */
const MAX_SEARCHES = 6;
export const MAX_PRICE_SYMBOLS = 40;

type IdHit = { at: number; id: string | null; name?: string };
const store = globalThis as unknown as {
  omnifolioTokenIds?: Map<string, IdHit>;
  omnifolioTokenPrices?: Map<string, { at: number; usd: number | null }>;
};
const ids = (store.omnifolioTokenIds ??= new Map());
const prices = (store.omnifolioTokenPrices ??= new Map());

export function normalizeSymbol(raw: string): string | null {
  const symbol = raw.trim().toUpperCase();
  return /^[A-Z0-9.$_-]{1,20}$/.test(symbol) ? symbol : null;
}

function directId(symbol: string): string | null {
  const key = symbolToLlamaKey(symbol);
  if (key) return key.slice("coingecko:".length);
  return BETA_COINGECKO[symbol] ?? null;
}

/** The CoinGecko id the app already uses for this ticker or, for a wrapped ticker, its base asset. */
export function knownId(symbol: string): string | null {
  const direct = directId(symbol);
  if (direct) return direct;
  const base = underlyingOf(symbol);
  return base !== symbol ? directId(base) : null;
}

/** The biggest coin by market cap whose ticker is exactly `symbol`. */
export function pickSearchResult(symbol: string, body: SearchResponse): { id: string; name?: string } | null {
  const matches = (body.coins ?? []).filter((coin) => coin.id && coin.symbol?.toUpperCase() === symbol);
  matches.sort((a, b) => (a.market_cap_rank ?? Infinity) - (b.market_cap_rank ?? Infinity));
  const best = matches[0];
  return best?.id ? { id: best.id, name: best.name } : null;
}

async function searchId(symbol: string, now: number): Promise<IdHit> {
  // A free CoinGecko demo key, when set, lifts the keyless rate limit shared by cloud hosts.
  const key = process.env.COINGECKO_API_KEY;
  const body = await fetchJson<SearchResponse>(
    `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`,
    key ? { headers: { "x-cg-demo-api-key": key } } : {},
    10_000,
  );
  const best = pickSearchResult(symbol, body);
  const hit: IdHit = { at: now, id: best?.id ?? null, name: best?.name };
  ids.set(symbol, hit);
  return hit;
}

async function priceIds(wanted: string[], now: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const fetchNow: string[] = [];
  for (const id of new Set(wanted)) {
    const hit = prices.get(id);
    if (hit && now - hit.at < PRICE_CACHE_MS) {
      if (hit.usd != null) out[id] = hit.usd;
    } else fetchNow.push(id);
  }
  for (let i = 0; i < fetchNow.length; i += 50) {
    const chunk = fetchNow.slice(i, i + 50);
    const body = await fetchJson<LlamaResponse>(`https://coins.llama.fi/prices/current/${chunk.map((id) => `coingecko:${id}`).join(",")}`);
    for (const id of chunk) {
      const usd = body.coins?.[`coingecko:${id}`]?.price;
      const valid = usd != null && usd > 0 ? usd : null;
      prices.set(id, { at: now, usd: valid });
      if (valid != null) out[id] = valid;
    }
  }
  return out;
}

export async function fetchTokenPrices(symbols: string[], now = Date.now()): Promise<TokenPriceResult> {
  const wanted = [...new Set(symbols.map(normalizeSymbol).filter((s): s is string => s !== null))].slice(0, MAX_PRICE_SYMBOLS);
  const result: TokenPriceResult = { prices: {}, missing: [] };
  const errors: string[] = [];

  try {
    // Known tickers first; a known id DefiLlama can't price falls through to a search.
    const known = wanted.filter((s) => knownId(s));
    const knownPrices = await priceIds(known.map((s) => knownId(s)!), now);
    for (const symbol of known) {
      const id = knownId(symbol)!;
      if (knownPrices[id] != null) result.prices[symbol] = { usd: knownPrices[id], id };
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Price request failed");
  }

  // A stable's ticker is often reused by small tokens, so stables aren't searched; they read $1.
  const toSearch = wanted.filter((s) => !result.prices[s] && !isStableSymbol(s));
  const found: { symbol: string; id: string; name?: string }[] = [];
  let searches = 0;
  for (const symbol of toSearch) {
    let hit = ids.get(symbol);
    const fresh = hit && now - hit.at < (hit.id ? ID_CACHE_MS : MISS_CACHE_MS);
    if (!fresh) {
      if (searches >= MAX_SEARCHES) continue;
      searches += 1;
      try {
        hit = await searchId(symbol, now);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Token search failed");
        continue;
      }
    }
    if (hit?.id && hit.id !== knownId(symbol)) found.push({ symbol, id: hit.id, name: hit.name });
  }
  try {
    const searched = await priceIds(found.map((f) => f.id), now);
    for (const { symbol, id, name } of found) {
      if (searched[id] != null) result.prices[symbol] = { usd: searched[id], id, name };
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Price request failed");
  }

  for (const symbol of wanted) {
    if (result.prices[symbol]) continue;
    if (isStableSymbol(symbol)) result.prices[symbol] = { usd: 1, id: "usd" };
    else result.missing.push(symbol);
  }
  if (errors.length) result.error = errors[0];
  return result;
}
