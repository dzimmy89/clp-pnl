import { isCantonParty } from "@/lib/addresses";
import { protocolMeta, type ProtocolFetch } from "@/lib/types";

export async function fetchAlpend(partyId: string): Promise<ProtocolFetch> {
  const meta = protocolMeta("alpend");
  const base = { id: meta.id, name: meta.name, chain: meta.chain, positions: [], spot: [] };
  const party = partyId.trim();
  if (!party) {
    return { ...base, status: "skipped", message: "No Canton party id saved." };
  }
  if (!isCantonParty(party)) {
    return { ...base, status: "error", message: "Enter the Canton party id Alpend shows on the position." };
  }
  return {
    ...base,
    status: "manual",
    message:
      "Alpend does not publish a public position API. Add the book manually and it will use the same metrics, scenario, and alerts.",
  };
}
