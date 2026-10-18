import { loadAccount } from "@/lib/server/accounts";
import { databaseConfigured } from "@/lib/server/db";
import { currentAccountId, errorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!databaseConfigured()) return Response.json({ account: null, accountsEnabled: false });
  try {
    const accountId = await currentAccountId();
    const account = accountId ? await loadAccount(accountId) : null;
    return Response.json({ account, accountsEnabled: true });
  } catch (error) {
    return errorResponse(error, "Could not load account");
  }
}
