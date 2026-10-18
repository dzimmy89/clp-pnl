import { loadLiveBook } from "@/lib/adapters/book";
import { parseDesk } from "@/lib/desk";
import { positionMetrics } from "@/lib/metrics";
import { loadAccount } from "@/lib/server/accounts";
import { databaseConfigured } from "@/lib/server/db";
import { loadAccountDesk } from "@/lib/server/desk";
import { ownerAccountIds, privateSite, readTokenMatches } from "@/lib/server/owner";
import { rateLimited } from "@/lib/server/rate-limit";
import { currentAccountId, errorResponse } from "@/lib/server/session";
import { trackedWallets, walletSetOf } from "@/lib/wallet-set";
import type { Position } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The owner's whole book in one read: every wallet on the owner's account plus the desk's
 * pasted addresses, read live, with the books entered by hand and each position's risk
 * figures (health factor, liquidation price and side, distance, threshold scale). Needs
 * `Authorization: Bearer <OWNER_READ_TOKEN>` or the owner signed in, and a private site.
 */
export async function GET(request: Request) {
  const limited = await rateLimited("owner-book", 10);
  if (limited) return limited;
  if (!privateSite() || !databaseConfigured()) {
    return Response.json({ error: "Set OWNER_WALLETS and a database to use this route." }, { status: 404 });
  }
  const allowed = readTokenMatches(request) || (await currentAccountId()) != null;
  if (!allowed) {
    return Response.json({ error: "Not allowed" }, { status: 401 });
  }
  try {
    const accountIds = await ownerAccountIds();
    const accounts = (await Promise.all(accountIds.map(loadAccount))).filter((a) => a != null);
    const desks = (await Promise.all(accountIds.map(loadAccountDesk))).map((row) => parseDesk(row?.desk));
    const pasted = desks.flatMap((desk) => desk.pasted);
    const manual = desks.flatMap((desk) => desk.manual);
    const manualSpot = desks.flatMap((desk) => desk.manualSpot);
    const wallets = trackedWallets(accounts.flatMap((account) => account.wallets), pasted);
    const book = await loadLiveBook(walletSetOf(wallets));
    const btcPrice = book.btcPrice ?? 0;
    const risk = (position: Position) => {
      const m = positionMetrics(position, btcPrice);
      return {
        id: position.id,
        label: position.label,
        app: position.app ?? position.protocol,
        chain: position.chain,
        wallet: position.wallet,
        source: position.source,
        supplyUsd: m.supplyUsd,
        borrowUsd: m.borrowUsd,
        equity: m.equity,
        leverage: m.leverage,
        healthFactor: m.healthFactor,
        healthFactorSource: m.healthFactorSource,
        assumedThreshold: m.assumedThreshold,
        thresholdScale: m.thresholdScale,
        primaryUnderlying: m.primaryUnderlying,
        primaryPriceUsd: m.primaryPriceUsd,
        liquidationPriceUsd: m.liquidationPriceUsd,
        liquidationSide: m.liquidationSide,
        liquidationDistance: m.liquidationDistance,
      };
    };
    const positions = [...book.protocols.flatMap((protocol) => protocol.positions), ...manual];
    return Response.json(
      {
        wallets,
        book,
        manual,
        manualSpot,
        risk: positions.filter((position) => position.legs.some((leg) => leg.side === "borrow")).map(risk),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error, "Could not load the owner's book");
  }
}
