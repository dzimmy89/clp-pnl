import { loadLiveBook } from "@/lib/adapters/book";
import { rateLimited } from "@/lib/server/rate-limit";
import { requireOwner } from "@/lib/server/session";
import { WALLET_KINDS } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `?evm=0xa&evm=0xb&solana=…&sui=…`: one repeated key per wallet kind; every wallet is read and merged into one book. */
export async function GET(request: Request) {
  const limited = await rateLimited("book", 30);
  if (limited) return limited;
  const denied = await requireOwner(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const all = (key: string) => url.searchParams.getAll(key).flatMap((value) => value.split(","));
  try {
    const book = await loadLiveBook(Object.fromEntries(WALLET_KINDS.map((kind) => [kind, all(kind)])));
    return Response.json(book);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Book request failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
