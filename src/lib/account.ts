"use client";

import { useCallback, useEffect, useState } from "react";
import type { WalletChain } from "@/lib/auth/message";

export interface AccountWallet {
  id: string;
  chain: WalletChain;
  address: string;
  label: string;
  createdAt: string;
}

export interface AccountView {
  id: string;
  createdAt: string;
  wallets: AccountWallet[];
}

export interface AccountState {
  account: AccountView | null;
  /** False when the server has no database, so sign-in is unavailable. */
  accountsEnabled: boolean;
  loading: boolean;
  setAccount: (account: AccountView | null) => void;
  refresh: () => Promise<void>;
}

export function useAccount(): AccountState {
  const [account, setAccount] = useState<AccountView | null>(null);
  const [accountsEnabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/account", { cache: "no-store" });
      const data = (await response.json()) as { account?: AccountView | null; accountsEnabled?: boolean };
      setAccount(data.account ?? null);
      setEnabled(data.accountsEnabled !== false && response.status !== 503);
    } catch {
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial load of the session
    void refresh();
  }, [refresh]);

  return { account, accountsEnabled, loading, setAccount, refresh };
}

export async function renameAccountWallet(id: string, label: string): Promise<AccountView> {
  return accountRequest(`/api/account/wallets/${id}`, "PATCH", { label });
}

export async function removeAccountWallet(id: string): Promise<AccountView> {
  return accountRequest(`/api/account/wallets/${id}`, "DELETE");
}

async function accountRequest(url: string, method: string, body?: unknown): Promise<AccountView> {
  const response = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as { account?: AccountView; error?: string };
  if (!response.ok || !data.account) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data.account;
}
