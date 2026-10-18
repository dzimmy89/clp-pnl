import { fetchTokenPrices, MAX_PRICE_SYMBOLS } from "@/lib/adapters/token-prices";
import { rateLimited } from "@/lib/server/rate-limit";
import { requireOwner } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** `?symbol=CC&symbol=ETH`: live USD price for each ticker, for balances entered by hand. */
export async function GET(request: Request) {
  const limited = await rateLimited("prices", 30);
  if (limited) return limited;
  const denied = await requireOwner(request);
  if (denied) return denied;
  const symbols = new URL(request.url).searchParams.getAll("symbol").slice(0, MAX_PRICE_SYMBOLS);
  const result = await fetchTokenPrices(symbols);
  return Response.json(result, { headers: { "cache-control": "private, max-age=60" } });
}
