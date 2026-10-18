"use client";

import { useSyncExternalStore } from "react";

/**
 * How this browser shows the dashboard. Kept apart from the desk: these are per-device
 * viewing choices, not portfolio data, so they never go to the account.
 */
export interface Prefs {
  /** Privacy mode: dollar values and token amounts render as dots. */
  hideAmounts: boolean;
  /** Re-read the book every few minutes while the page is open. */
  autoRefresh: boolean;
  /** Show a browser notification when a new alert fires. */
  notify: boolean;
  /** Leave spot balances under $1 (and unpriced tokens) out of the spot table. */
  hideDust: boolean;
}

export const DEFAULT_PREFS: Prefs = { hideAmounts: false, autoRefresh: true, notify: false, hideDust: true };

const KEY = "hedge-ledger.prefs.v1";

export function parsePrefs(raw: unknown): Prefs {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof Prefs) => (typeof value[key] === "boolean" ? (value[key] as boolean) : DEFAULT_PREFS[key]);
  return { hideAmounts: flag("hideAmounts"), autoRefresh: flag("autoRefresh"), notify: flag("notify"), hideDust: flag("hideDust") };
}

let clientPrefs: Prefs | null = null;
const listeners = new Set<() => void>();

function readPrefs(): Prefs {
  if (clientPrefs) return clientPrefs;
  try {
    clientPrefs = parsePrefs(JSON.parse(window.localStorage.getItem(KEY) ?? "{}"));
  } catch {
    clientPrefs = { ...DEFAULT_PREFS };
  }
  return clientPrefs;
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readPrefs,
    () => DEFAULT_PREFS,
  );
}

export function setPrefs(partial: Partial<Prefs>) {
  clientPrefs = { ...readPrefs(), ...partial };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(clientPrefs));
  } catch {
    // Storage blocked: the choice lasts until the page closes.
  }
  for (const listener of listeners) listener();
}
