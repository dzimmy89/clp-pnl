import { accountPart, MAX_DESK_BYTES, parseDesk } from "@/lib/desk";
import { loadAccountDesk, saveAccountDesk } from "@/lib/server/desk";
import { rateLimited } from "@/lib/server/rate-limit";
import { currentAccountId, errorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** The desk saved on the signed-in account, or `desk: null` when it has none yet. */
export async function GET() {
  try {
    const accountId = await currentAccountId();
    if (!accountId) return Response.json({ error: "Not signed in" }, { status: 401 });
    const saved = await loadAccountDesk(accountId);
    return Response.json(saved ? { desk: accountPart(parseDesk(saved.desk)), updatedAt: saved.updatedAt } : { desk: null });
  } catch (error) {
    return errorResponse(error, "Could not load saved desk");
  }
}

export async function PUT(request: Request) {
  const limited = await rateLimited("desk", 60);
  if (limited) return limited;
  try {
    const accountId = await currentAccountId();
    if (!accountId) return Response.json({ error: "Not signed in" }, { status: 401 });
    const text = await request.text();
    if (text.length > MAX_DESK_BYTES) return Response.json({ error: "Saved desk is too large" }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "Expected JSON" }, { status: 400 });
    }
    const updatedAt = await saveAccountDesk(accountId, accountPart(parseDesk(body)));
    return Response.json({ updatedAt });
  } catch (error) {
    return errorResponse(error, "Could not save desk");
  }
}
