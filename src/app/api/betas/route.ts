import { fetchBetas } from "@/lib/adapters/betas";
import { rateLimited } from "@/lib/server/rate-limit";
import { requireOwner } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** `?asset=ETH&asset=SOL`: 90-day BTC beta for each asset DefiLlama has history for. */
export async function GET(request: Request) {
  const limited = await rateLimited("betas", 30);
  if (limited) return limited;
  const denied = await requireOwner(request);
  if (denied) return denied;
  const assets = new URL(request.url).searchParams
    .getAll("asset")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => /^[A-Z0-9.]{1,16}$/.test(value))
    .slice(0, 80);
  const result = await fetchBetas(assets);
  return Response.json(result, { headers: { "cache-control": "private, max-age=3600" } });
}
