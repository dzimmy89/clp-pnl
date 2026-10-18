import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { AccountView } from "@/lib/account";
import { NONCE_TTL_MS, type WalletChain } from "@/lib/auth/message";
import { db } from "./db";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class AccountConflictError extends Error {}

export async function issueNonce(): Promise<string> {
  const sql = await db();
  const nonce = randomBytes(32).toString("hex");
  await sql`delete from auth_nonces where expires_at < now()`;
  await sql`insert into auth_nonces (nonce, expires_at) values (${nonce}, ${new Date(Date.now() + NONCE_TTL_MS)})`;
  return nonce;
}

/** Single use: a nonce is deleted the moment it is checked, valid or not. */
export async function consumeNonce(nonce: string): Promise<boolean> {
  const sql = await db();
  const rows = await sql`delete from auth_nonces where nonce = ${nonce} returning expires_at`;
  return rows.length === 1 && new Date(rows[0].expires_at).getTime() > Date.now();
}

/** Finds the account that owns this wallet, or creates one with the wallet as its first. */
export async function signInWallet(chain: WalletChain, address: string): Promise<string> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const existing = await tx`
      update wallets set last_sign_in_at = now()
      where chain = ${chain} and address = ${address}
      returning account_id`;
    if (existing.length) return existing[0].account_id as string;
    const [account] = await tx`insert into accounts default values returning id`;
    await tx`
      insert into wallets (account_id, chain, address, last_sign_in_at)
      values (${account.id}, ${chain}, ${address}, now())`;
    return account.id as string;
  });
}

/** Adds a wallet to a signed-in account. A wallet can belong to one account only. */
export async function linkWallet(accountId: string, chain: WalletChain, address: string): Promise<void> {
  const sql = await db();
  const rows = await sql`
    insert into wallets (account_id, chain, address)
    values (${accountId}, ${chain}, ${address})
    on conflict (chain, address) do nothing
    returning id`;
  if (rows.length) return;
  const [owner] = await sql`select account_id from wallets where chain = ${chain} and address = ${address}`;
  if (owner?.account_id !== accountId) {
    throw new AccountConflictError("This wallet is already signed up to another account. Sign in with it to use that account.");
  }
}

export async function renameWallet(accountId: string, walletId: string, label: string): Promise<boolean> {
  const sql = await db();
  const rows = await sql`
    update wallets set label = ${label.trim().slice(0, 40)}
    where id = ${walletId} and account_id = ${accountId}
    returning id`;
  return rows.length === 1;
}

/** Refuses to remove the last wallet, since that would leave no way to sign back in. */
export async function removeWallet(accountId: string, walletId: string): Promise<"removed" | "last" | "missing"> {
  const sql = await db();
  return sql.begin(async (tx) => {
    const wallets = await tx`select id from wallets where account_id = ${accountId} for update`;
    if (!wallets.some((w) => w.id === walletId)) return "missing";
    if (wallets.length === 1) return "last";
    await tx`delete from wallets where id = ${walletId} and account_id = ${accountId}`;
    return "removed";
  });
}

export async function loadAccount(accountId: string): Promise<AccountView | null> {
  const sql = await db();
  const [account] = await sql`select id, created_at from accounts where id = ${accountId}`;
  if (!account) return null;
  const wallets = await sql`
    select id, chain, address, label, created_at from wallets
    where account_id = ${accountId} order by created_at`;
  return {
    id: account.id,
    createdAt: new Date(account.created_at).toISOString(),
    wallets: wallets.map((w) => ({
      id: w.id,
      chain: w.chain,
      address: w.address,
      label: w.label,
      createdAt: new Date(w.created_at).toISOString(),
    })),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(accountId: string): Promise<{ token: string; expiresAt: Date }> {
  const sql = await db();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sql`delete from sessions where expires_at < now()`;
  await sql`insert into sessions (token_hash, account_id, expires_at) values (${hashToken(token)}, ${accountId}, ${expiresAt})`;
  return { token, expiresAt };
}

export async function sessionAccountId(token: string): Promise<string | null> {
  const sql = await db();
  const [row] = await sql`
    select account_id from sessions
    where token_hash = ${hashToken(token)} and expires_at > now()`;
  return row ? (row.account_id as string) : null;
}

export async function deleteSession(token: string): Promise<void> {
  const sql = await db();
  await sql`delete from sessions where token_hash = ${hashToken(token)}`;
}
