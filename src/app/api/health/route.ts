import { databaseSource, db } from "@/lib/server/db";
import { zerionConfigured } from "@/lib/adapters/zerion";
import { privateSite } from "@/lib/server/owner";
import { onCloudRun, publicHost } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * Deploy check: is a database configured, and does it answer? Names the variable the
 * connection string came from but never its value.
 */
export async function GET() {
  const source = databaseSource();
  let database: "missing" | "ok" | "error" = source ? "ok" : "missing";
  let detail: string | undefined;
  if (source) {
    try {
      const sql = await db();
      await sql`select 1`;
    } catch (error) {
      database = "error";
      detail = error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "[connection string]") : "Query failed";
    }
  }
  return Response.json(
    { ok: database === "ok", database, databaseVariable: source, detail, signInHost: publicHost() ?? null, platform: onCloudRun() ? "cloud-run" : "node", alchemy: process.env.ALCHEMY_API_KEY ? "configured" : "missing", zerion: zerionConfigured() ? "configured" : "missing", private: privateSite() },
    { status: database === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
