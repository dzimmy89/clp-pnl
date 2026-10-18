import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { chainVerifier } from "@/lib/auth/chains";
import { WALLET_CHAINS, type PluginChain } from "@/lib/auth/message";
import { isOwnerAddress, parseOwnerWallets as parseList } from "@/lib/owner";
import { db } from "./db";

const PLUGIN_CHAINS = WALLET_CHAINS.filter((chain): chain is PluginChain => chain !== "evm" && chain !== "solana" && chain !== "near");

/** Every form sign-in could store this address as, on the chains whose verifier rewrites it. */
function canonicalForms(address: string): string[] {
  const forms: string[] = [];
  for (const chain of PLUGIN_CHAINS) {
    try {
      forms.push(chainVerifier(chain).normalize(address));
    } catch {}
  }
  return forms;
}

function parseOwnerWallets(raw: string | undefined): Set<string> {
  return parseList(raw, canonicalForms);
}

/** True when OWNER_WALLETS names at least one wallet: only those wallets' account can use the site. */
export function privateSite(): boolean {
  return parseOwnerWallets(process.env.OWNER_WALLETS).size > 0;
}

export function isOwnerWallet(address: string): boolean {
  return isOwnerAddress(parseOwnerWallets(process.env.OWNER_WALLETS), address);
}

/** Accounts holding any owner wallet. Usually one; more if the owner signed in with two wallets before linking them. */
export async function ownerAccountIds(): Promise<string[]> {
  const owners = parseOwnerWallets(process.env.OWNER_WALLETS);
  if (!owners.size) return [];
  const sql = await db();
  const rows = await sql`select account_id, address from wallets`;
  return [...new Set(rows.filter((row) => isOwnerAddress(owners, row.address)).map((row) => row.account_id as string))];
}

export async function isOwnerAccount(accountId: string): Promise<boolean> {
  return (await ownerAccountIds()).includes(accountId);
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** `Authorization: Bearer <OWNER_READ_TOKEN>`. Never true when the token isn't set or is short. */
export function readTokenMatches(request: Request): boolean {
  const token = process.env.OWNER_READ_TOKEN?.trim();
  if (!token || token.length < 24) return false;
  const sent = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!sent) return false;
  return timingSafeEqual(digest(sent), digest(token));
}

export const PRIVATE_MESSAGE = "This Omnifolio is private. Sign in with the owner's wallet.";

/**
 * Null when the caller may use the data routes: the site is open, the request carries the
 * read token, or the signed-in account is the owner's. Otherwise a 401 to return as is.
 */
export async function ownerOnly(request: Request, accountId: () => Promise<string | null>): Promise<Response | null> {
  if (!privateSite() || readTokenMatches(request)) return null;
  if (await accountId()) return null;
  return Response.json({ error: PRIVATE_MESSAGE, code: "private" }, { status: 401 });
}
