"use client";

import { useEffect, useRef, useState } from "react";
import { accountPart, defaultDesk, mergeDesks, parseDesk, type SavedDesk } from "@/lib/desk";
import { allLocalHistory, clearLocalHistory, MAX_HISTORY_WRITE, type HistoryPoint, type HistoryWrite } from "@/lib/history";
import { commitDesk, currentDesk } from "@/lib/storage";

export type SyncStatus = "off" | "loading" | "saving" | "saved" | "error";

/** How long the desk waits after the last edit before saving to the account. */
const SAVE_DELAY_MS = 800;

async function putDesk(desk: SavedDesk): Promise<void> {
  const response = await fetch("/api/account/desk", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(accountPart(desk)),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Save failed (${response.status})`);
  }
}

export async function postHistory(points: HistoryWrite[]): Promise<void> {
  for (let i = 0; i < points.length; i += MAX_HISTORY_WRITE) {
    const response = await fetch("/api/account/history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: points.slice(i, i + MAX_HISTORY_WRITE) }),
    });
    if (!response.ok) throw new Error(`History save failed (${response.status})`);
  }
}

export async function fetchAccountHistory(scope: string): Promise<HistoryPoint[]> {
  const response = await fetch(`/api/account/history?scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`History request failed (${response.status})`);
  const body = (await response.json()) as { points?: HistoryPoint[] };
  return body.points ?? [];
}

/**
 * This browser's readings, ready to copy to `accountId`: the signed-out series becomes the
 * account's book series, and other accounts' book series are left behind.
 */
export function localHistoryFor(accountId: string, local: Record<string, HistoryPoint[]>): HistoryWrite[] {
  const out: HistoryWrite[] = [];
  for (const [scope, points] of Object.entries(local)) {
    const target = scope === "book:device" ? `book:${accountId}` : scope;
    if (target.startsWith("book:") && target !== `book:${accountId}`) continue;
    for (const point of points) out.push({ scope: target, t: point.t, usd: point.usd });
  }
  return out;
}

/**
 * Keeps the desk (pasted addresses, manual books and balances, targets, goals) on the
 * signed-in account. On sign-in the account's copy loads into this browser; a browser that
 * has not met this account before merges its own desk and history in first. Every later
 * edit is saved to the account. Signing out clears the account's data from this browser.
 */
export function useAccountSync(accountId: string | null, accountLoading: boolean, desk: SavedDesk) {
  const [status, setStatus] = useState<SyncStatus>("off");
  const [error, setError] = useState<string | null>(null);
  /** Bumps each time the account's desk lands, so the book and history reload. */
  const [version, setVersion] = useState(0);
  const [syncedId, setSyncedId] = useState<string | null>(null);
  const syncedFor = useRef<string | null>(null);
  const signedInAs = useRef<string | null>(null);
  const lastSaved = useRef<string>("");

  useEffect(() => {
    if (accountLoading) return;
    if (!accountId) {
      if (signedInAs.current) {
        // Signed out here: leave nothing of the account behind for the next person.
        commitDesk(defaultDesk());
        clearLocalHistory();
      }
      signedInAs.current = null;
      syncedFor.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the session ending
      setSyncedId(null);
      setStatus("off");
      return;
    }
    signedInAs.current = accountId;
    if (syncedFor.current === accountId) return;
    let cancelled = false;
    setStatus("loading");
    setError(null);
    (async () => {
      const response = await fetch("/api/account/desk", { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load your saved desk (${response.status})`);
      const body = (await response.json()) as { desk: unknown };
      if (cancelled) return;
      const local = currentDesk();
      const firstVisit = local.syncedAccount !== accountId;
      let next: SavedDesk;
      if (body.desk == null) next = local;
      else if (!firstVisit) next = { ...parseDesk(body.desk), mode: local.mode, syncedAccount: accountId };
      else next = mergeDesks(accountPart(parseDesk(body.desk)), local);
      commitDesk(next);
      syncedFor.current = accountId;
      // Marked saved up front so the edit watcher doesn't queue a second copy of this save.
      lastSaved.current = JSON.stringify(accountPart(next));
      if (body.desk == null || firstVisit) {
        await putDesk(next);
        if (firstVisit) await postHistory(localHistoryFor(accountId, allLocalHistory()));
        // Only once the account holds this browser's desk does the account's copy win on later loads.
        commitDesk({ ...currentDesk(), syncedAccount: accountId });
      }
      if (cancelled) return;
      setSyncedId(accountId);
      setStatus("saved");
      setVersion((v) => v + 1);
    })().catch((failure: unknown) => {
      if (cancelled) return;
      setStatus("error");
      setError(failure instanceof Error ? failure.message : "Could not load your saved desk");
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, accountLoading]);

  useEffect(() => {
    if (!accountId || syncedFor.current !== accountId) return;
    const serialized = JSON.stringify(accountPart(desk));
    if (serialized === lastSaved.current) return;
    const timer = window.setTimeout(() => {
      setStatus("saving");
      putDesk(desk)
        .then(() => {
          lastSaved.current = serialized;
          setStatus("saved");
          setError(null);
        })
        .catch((failure: unknown) => {
          setStatus("error");
          setError(failure instanceof Error ? failure.message : "Could not save to your account");
        });
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [accountId, desk, version]);

  return { status, error, version, synced: accountId !== null && syncedId === accountId };
}
