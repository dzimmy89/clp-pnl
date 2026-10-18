import "server-only";
import { type AccountDesk } from "@/lib/desk";
import { dedupeWrites, historyBucket, MAX_POINTS, type HistoryPoint, type HistoryWrite } from "@/lib/history";
import { db } from "./db";

export async function loadAccountDesk(accountId: string): Promise<{ desk: unknown; updatedAt: string } | null> {
  const sql = await db();
  const [row] = await sql`select desk, updated_at from account_desks where account_id = ${accountId}`;
  return row ? { desk: row.desk, updatedAt: new Date(row.updated_at).toISOString() } : null;
}

export async function saveAccountDesk(accountId: string, desk: AccountDesk): Promise<string> {
  const sql = await db();
  const [row] = await sql`
    insert into account_desks (account_id, desk, updated_at)
    values (${accountId}, ${sql.json(JSON.parse(JSON.stringify(desk)))}, now())
    on conflict (account_id) do update set desk = excluded.desk, updated_at = excluded.updated_at
    returning updated_at`;
  return new Date(row.updated_at).toISOString();
}

/** The newest readings for one series, oldest first. */
export async function loadAccountHistory(accountId: string, scope: string): Promise<HistoryPoint[]> {
  const sql = await db();
  const rows = await sql`
    select t, usd from net_worth_history
    where account_id = ${accountId} and scope = ${scope}
    order by bucket desc limit ${MAX_POINTS}`;
  return rows.map((row) => ({ t: new Date(row.t).getTime(), usd: Number(row.usd) })).reverse();
}

/** Saves readings; a later reading in the same 15-minute bucket replaces the earlier one. */
export async function recordAccountHistory(accountId: string, writes: HistoryWrite[]): Promise<void> {
  const rows = dedupeWrites(writes).map((write) => ({
    account_id: accountId,
    scope: write.scope,
    bucket: historyBucket(write.t),
    t: new Date(write.t),
    usd: write.usd,
  }));
  if (!rows.length) return;
  const sql = await db();
  await sql`
    insert into net_worth_history ${sql(rows, "account_id", "scope", "bucket", "t", "usd")}
    on conflict (account_id, scope, bucket)
    do update set t = excluded.t, usd = excluded.usd
    where excluded.t >= net_worth_history.t`;
}
