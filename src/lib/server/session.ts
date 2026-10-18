import "server-only";
import { cookies, headers } from "next/headers";
import { createSession, deleteSession, sessionAccountId } from "./accounts";
import { databaseConfigured, DatabaseNotConfiguredError } from "./db";
import { isOwnerAccount, ownerOnly, privateSite } from "./owner";
import { publicHost } from "@/lib/site";

const COOKIE = "hl_session";

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
  const token = (await cookies()).get(COOKIE)?.value;
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
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token && databaseConfigured()) await deleteSession(token);
  store.delete(COOKIE);
}

/**
 * The host the browser is on. The signed message must name it, which is what stops a
 * signature collected by another site from signing in here. Host headers come from the
 * request, so production pins the public host: AUTH_DOMAIN, or the Vercel production domain.
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
