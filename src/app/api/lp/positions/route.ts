import { getAddress, isAddress } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "@/lib/lp/chains";
import { fetchChainPositions } from "@/lib/lp/positions";
import { rateLimited } from "@/lib/server/rate-limit";
import { requireOwner } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** `?address=0x…&chain=base`: the open Uniswap V3 and V4 positions one wallet holds on one chain. */
export async function GET(request: Request) {
  const limited = await rateLimited("lp-positions", 60);
  if (limited) return limited;
  const denied = await requireOwner(request);
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address") ?? "";
  const chain = searchParams.get("chain") as ChainKey | null;
  if (!isAddress(address)) return Response.json({ error: "Invalid address" }, { status: 400 });
  if (!chain || !(chain in CHAIN_BY_KEY)) return Response.json({ error: "Unknown chain" }, { status: 400 });
  const result = await fetchChainPositions(chain, getAddress(address));
  return Response.json(result, { headers: { "cache-control": "private, max-age=30" } });
}
