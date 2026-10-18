import { issueNonce } from "@/lib/server/accounts";
import { rateLimited } from "@/lib/server/rate-limit";
import { errorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST() {
  const limited = await rateLimited("nonce", 20);
  if (limited) return limited;
  try {
    return Response.json({ nonce: await issueNonce() });
  } catch (error) {
    return errorResponse(error, "Could not start sign-in");
  }
}
