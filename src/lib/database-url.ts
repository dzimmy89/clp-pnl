type Env = Record<string, string | undefined>;

const POSTGRES = /^postgres(ql)?:\/\//;
const NAME = /(^|_)(DATABASE_URL|POSTGRES_URL)$/;

/**
 * The Postgres connection string, wherever the host put it. `DATABASE_URL` wins, then
 * `POSTGRES_URL`. Vercel's Neon integration can add a custom prefix (e.g.
 * `STORAGE_DATABASE_URL`), so any other `*_DATABASE_URL` or `*_POSTGRES_URL` holding a
 * postgres:// URL is accepted too. Pooled names come before `_UNPOOLED`/`_NON_POOLING`,
 * which the NAME pattern never matches.
 */
export function resolveDatabaseUrl(env: Env): { name: string; url: string } | null {
  for (const name of ["DATABASE_URL", "POSTGRES_URL"]) {
    const url = env[name]?.trim();
    if (url && POSTGRES.test(url)) return { name, url };
  }
  const names = Object.keys(env)
    .filter((name) => NAME.test(name))
    .sort();
  for (const name of names) {
    const url = env[name]?.trim();
    if (url && POSTGRES.test(url)) return { name, url };
  }
  return null;
}

/**
 * Cloud SQL from Cloud Run speaks over a unix socket under `/cloudsql/<connection name>`. A
 * connection string written as `postgresql://user:pass@localhost/db?host=/cloudsql/proj:region:inst`
 * (the form the Cloud SQL docs use) is split here into the URL without that parameter and
 * the socket directory, which the driver takes as its `path` option.
 */
export function splitSocketUrl(url: string): { url: string; socketDir: string | null } {
  try {
    const parsed = new URL(url);
    const host = parsed.searchParams.get("host");
    if (!host || !host.startsWith("/")) return { url, socketDir: null };
    parsed.searchParams.delete("host");
    return { url: parsed.toString(), socketDir: host };
  } catch {
    return { url, socketDir: null };
  }
}
