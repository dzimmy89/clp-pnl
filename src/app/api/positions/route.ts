import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { CHAIN_BY_KEY, type ChainKey } from "@/lib/chains";
import { fetchChainPositions } from "@/lib/positions";

export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address") ?? "";
  const chain = searchParams.get("chain") as ChainKey | null;

  if (!isAddress(address)) {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }
  if (!chain || !(chain in CHAIN_BY_KEY)) {
    return NextResponse.json({ error: "Unknown chain" }, { status: 400 });
  }

  const result = await fetchChainPositions(chain, getAddress(address));
  return NextResponse.json(result, {
    headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120" },
  });
}
