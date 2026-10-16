import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "@/lib/chains";
import { computePnl } from "@/lib/history/pnl";
import { fetchV3History } from "@/lib/history/v3";
import { fetchV4History } from "@/lib/history/v4";
import type { Position } from "@/lib/types";

export const maxDuration = 60;

/**
 * POST { address, position } -> PositionPnl
 * The live position (from /api/positions) is posted back so history can be
 * priced against current value without a second chain read.
 */
export async function POST(req: Request) {
  let body: { address?: string; position?: Position };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const { address, position } = body;
  if (!address || !isAddress(address)) return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  if (!position || !(position.chain in CHAIN_BY_KEY)) return NextResponse.json({ error: "Invalid position" }, { status: 400 });

  const chain = position.chain as ChainKey;
  try {
    const history =
      position.protocol === "v3"
        ? await fetchV3History(chain, position, getAddress(address))
        : await fetchV4History(chain, position, getAddress(address));
    return NextResponse.json(computePnl(history, position));
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
