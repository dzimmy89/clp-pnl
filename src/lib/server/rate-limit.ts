import "server-only";
import { headers } from "next/headers";
import { hit } from "@/lib/rate-window";

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-real-ip") || h.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

/** A 429 response when the caller is over `limit` requests per minute for `bucket`, else null. */
export async function rateLimited(bucket: string, limit: number): Promise<Response | null> {
  const { ok, retryAfter } = hit(`${bucket}:${await clientIp()}`, limit, 60_000);
  if (ok) return null;
  return Response.json(
    { error: "Too many requests. Wait a minute and try again." },
    { status: 429, headers: { "retry-after": String(retryAfter) } },
  );
}
