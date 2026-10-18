import "server-only";
import postgres from "postgres";
import { resolveDatabaseUrl, splitSocketUrl } from "@/lib/database-url";

type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { hedgeLedgerSql?: Sql; hedgeLedgerSchema?: Promise<void> };

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("Accounts need a database. Set DATABASE_URL to a Postgres connection string.");
  }
}

export function databaseConfigured(): boolean {
  return resolveDatabaseUrl(process.env) !== null;
}

/** Which variable the connection string came from, for the health check. Never the value. */
export function databaseSource(): string | null {
  return resolveDatabaseUrl(process.env)?.name ?? null;
}

/** One pool per server process, reused across hot reloads in dev. */
function client(): Sql {
  const raw = resolveDatabaseUrl(process.env)?.url;
  if (!raw) throw new DatabaseNotConfiguredError();
  if (!globalForDb.hedgeLedgerSql) {
    const { url, socketDir } = splitSocketUrl(raw);
    globalForDb.hedgeLedgerSql = postgres(url, {
      // Cloud SQL over the Cloud Run connector: a unix socket directory instead of a TCP host.
      ...(socketDir ? { path: socketDir } : {}),
      max: 5,
      idle_timeout: 20,
      // Pooled hosts (Neon, Supabase, PgBouncer) run in transaction mode, which can't keep
      // named prepared statements between queries.
      prepare: false,
      onnotice: () => {},
    });
  }
  return globalForDb.hedgeLedgerSql;
}

const SCHEMA = `
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists wallets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  chain text not null,
  address text not null,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz,
  unique (chain, address)
);
create index if not exists wallets_account_idx on wallets (account_id);
-- The chain list grows with each new wallet type; the app validates it instead.
alter table wallets drop constraint if exists wallets_chain_check;

create table if not exists auth_nonces (
  nonce text primary key,
  expires_at timestamptz not null
);

create table if not exists sessions (
  token_hash text primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_account_idx on sessions (account_id);

-- Pasted addresses, manual books and balances, targets and goals, saved per account.
create table if not exists account_desks (
  account_id uuid primary key references accounts(id) on delete cascade,
  desk jsonb not null,
  updated_at timestamptz not null default now()
);

-- Net worth readings, one per scope (whole book or one wallet) per 15-minute bucket.
create table if not exists net_worth_history (
  account_id uuid not null references accounts(id) on delete cascade,
  scope text not null,
  bucket bigint not null,
  t timestamptz not null,
  usd double precision not null,
  primary key (account_id, scope, bucket)
);
`;

/** Creates tables on first use, so a fresh database needs no migration step. */
export async function db(): Promise<Sql> {
  const sql = client();
  if (!globalForDb.hedgeLedgerSchema) {
    globalForDb.hedgeLedgerSchema = sql.unsafe(SCHEMA).then(() => undefined);
    globalForDb.hedgeLedgerSchema.catch(() => {
      globalForDb.hedgeLedgerSchema = undefined;
    });
  }
  await globalForDb.hedgeLedgerSchema;
  return sql;
}
