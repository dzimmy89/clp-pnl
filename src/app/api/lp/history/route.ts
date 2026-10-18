import { getAddress, isAddress } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "@/lib/lp/chains";
import { computePnl } from "@/lib/lp/history/pnl";
import { fetchV3History } from "@/lib/lp/history/v3";
import { fetchV4History } from "@/lib/lp/history/v4";
import type { LpPosition } from "@/lib/lp/types";
import { rateLimited } from "@/lib/server/rate-limit";
import { requireOwner } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST { address, position } -> PositionPnl
 * The live position (from the book) is posted back so its history can be priced against
 * current value without a second chain read.
 */
export async function POST(request: Request) {
  const limited = await rateLimited("lp-history", 120);
  if (limited) return limited;
  const denied = await requireOwner(request);
  if (denied) return denied;
  let body: { address?: string; position?: LpPosition };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Bad JSON" }, { status: 400 });
  }
  const { address, position } = body;
  if (!address || !isAddress(address)) return Response.json({ error: "Invalid address" }, { status: 400 });
  if (!position || typeof position !== "object" || !(position.chain in CHAIN_BY_KEY) || !/^\d+$/.test(String(position.tokenId))) {
    return Response.json({ error: "Invalid position" }, { status: 400 });
  }
  const chain = position.chain as ChainKey;
  try {
    const history =
      position.protocol === "v3"
        ? await fetchV3History(chain, position, getAddress(address))
        : await fetchV4History(chain, position, getAddress(address));
    return Response.json(computePnl(history, position), { headers: { "cache-control": "private, max-age=60" } });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return Response.json({ error: message }, { status: 502 });
  }
}
