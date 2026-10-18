import { isHistoryScope, MAX_HISTORY_WRITE, validHistoryWrites } from "@/lib/history";
import { loadAccountHistory, recordAccountHistory } from "@/lib/server/desk";
import { rateLimited } from "@/lib/server/rate-limit";
import { currentAccountId, errorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

/** `?scope=book:<account id>` or `?scope=wallet:<address key>`: that series' readings, oldest first. */
export async function GET(request: Request) {
  try {
    const accountId = await currentAccountId();
    if (!accountId) return Response.json({ error: "Not signed in" }, { status: 401 });
    const scope = new URL(request.url).searchParams.get("scope");
    if (!isHistoryScope(scope)) return Response.json({ error: "Unknown history scope" }, { status: 400 });
    return Response.json({ points: await loadAccountHistory(accountId, scope) });
  } catch (error) {
    return errorResponse(error, "Could not load history");
  }
}

/** `{ points: [{ scope, t, usd }] }`: readings to save, at most MAX_HISTORY_WRITE per request. */
export async function POST(request: Request) {
  const limited = await rateLimited("history", 60);
  if (limited) return limited;
  try {
    const accountId = await currentAccountId();
    if (!accountId) return Response.json({ error: "Not signed in" }, { status: 401 });
    const body = (await request.json().catch(() => null)) as { points?: unknown } | null;
    if (!Array.isArray(body?.points) || body.points.length > MAX_HISTORY_WRITE) {
      return Response.json({ error: `Send 1 to ${MAX_HISTORY_WRITE} readings` }, { status: 400 });
    }
    const points = validHistoryWrites(body.points);
    await recordAccountHistory(accountId, points);
    return Response.json({ saved: points.length });
  } catch (error) {
    return errorResponse(error, "Could not save history");
  }
}
