import "server-only";
import { cookies, headers } from "next/headers";
import { createSession, deleteSession, sessionAccountId } from "./accounts";
import { databaseConfigured, DatabaseNotConfiguredError } from "./db";
import { isOwnerAccount, ownerOnly, privateSite } from "./owner";
import { publicHost } from "@/lib/site";

/**
 * `__session` is the only cookie Firebase Hosting passes through to Cloud Run, so the app can sit
 * behind a free `*.web.app` site. Sessions set under the old name are still read until they expire.
 */
const COOKIE = "__session";
const LEGACY_COOKIE = "hl_session";

async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(COOKIE)?.value ?? store.get(LEGACY_COOKIE)?.value;
}

export async function startSession(accountId: string) {
  const { token, expiresAt } = await createSession(accountId);
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** The signed-in account id, or null. On a private site, only the owner's account counts as signed in. */
export async function currentAccountId(): Promise<string | null> {
  if (!databaseConfigured()) return null;
  const token = await sessionToken();
  if (!token) return null;
  const accountId = await sessionAccountId(token);
  if (accountId && privateSite() && !(await isOwnerAccount(accountId))) return null;
  return accountId;
}

/** Null when the caller may read books and prices; on a private site, a 401 for anyone but the owner. */
export function requireOwner(request: Request): Promise<Response | null> {
  return ownerOnly(request, currentAccountId);
}

export async function endSession() {
  const token = await sessionToken();
  if (token && databaseConfigured()) await deleteSession(token);
  const store = await cookies();
  store.delete(COOKIE);
  store.delete(LEGACY_COOKIE);
}

/**
 * The host the browser is on. The signed message must name it, which is what stops a
 * signature collected by another site from signing in here. Host headers come from the
 * request, so production pins the public host: AUTH_DOMAIN.
 */
export async function siteDomain(): Promise<string> {
  const pinned = publicHost();
  if (pinned) return pinned;
  const h = await headers();
  return h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host") || "localhost";
}

export function errorResponse(error: unknown, fallback = "Request failed") {
  if (error instanceof DatabaseNotConfiguredError) {
    return Response.json({ error: error.message, code: "no_database" }, { status: 503 });
  }
  console.error(error);
  return Response.json({ error: fallback }, { status: 500 });
}
