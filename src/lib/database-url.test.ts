import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl, splitSocketUrl } from "./database-url";

const PG = "postgresql://u:p@ep-x-pooler.neon.tech/neondb?sslmode=require";

describe("resolveDatabaseUrl", () => {
  it("prefers DATABASE_URL", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: PG, POSTGRES_URL: "postgres://other" })?.name).toBe("DATABASE_URL");
  });

  it("falls back to POSTGRES_URL", () => {
    expect(resolveDatabaseUrl({ POSTGRES_URL: PG })).toEqual({ name: "POSTGRES_URL", url: PG });
  });

  it("finds a prefixed Neon variable but not the unpooled one", () => {
    const found = resolveDatabaseUrl({ STORAGE_DATABASE_URL_UNPOOLED: "postgres://direct", STORAGE_DATABASE_URL: PG });
    expect(found).toEqual({ name: "STORAGE_DATABASE_URL", url: PG });
  });

  it("ignores empty or non-postgres values", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "", REDIS_DATABASE_URL: "redis://x" })).toBeNull();
  });
});

describe("splitSocketUrl", () => {
  it("lifts a Cloud SQL socket directory out of the connection string", () => {
    const { url, socketDir } = splitSocketUrl("postgresql://u:p@localhost/omnifolio?host=/cloudsql/proj:us-central1:db");
    expect(socketDir).toBe("/cloudsql/proj:us-central1:db");
    expect(url).toBe("postgresql://u:p@localhost/omnifolio");
  });

  it("leaves a TCP connection string alone", () => {
    expect(splitSocketUrl(PG)).toEqual({ url: PG, socketDir: null });
    expect(splitSocketUrl("postgres://u:p@db.example.com/x?host=db.example.com").socketDir).toBeNull();
  });
});
