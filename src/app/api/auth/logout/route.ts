import { endSession, errorResponse } from "@/lib/server/session";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await endSession();
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Sign-out failed");
  }
}
