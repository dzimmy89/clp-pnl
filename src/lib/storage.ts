"use client";

import { useSyncExternalStore } from "react";
import { defaultDesk, parseDesk, type SavedDesk } from "@/lib/desk";

const KEY = "hedge-ledger.v1";

export { defaultDesk, loadPasted, type SavedDesk } from "@/lib/desk";

export function loadDesk(): SavedDesk {
  if (typeof window === "undefined") return defaultDesk();
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? parseDesk(JSON.parse(raw)) : defaultDesk();
  } catch {
    return defaultDesk();
  }
}

export function saveDesk(desk: SavedDesk) {
  window.localStorage.setItem(KEY, JSON.stringify(desk));
}

const serverDesk = defaultDesk();
let clientDesk: SavedDesk | null = null;
const listeners = new Set<() => void>();

function readClientDesk(): SavedDesk {
  if (!clientDesk) clientDesk = loadDesk();
  return clientDesk;
}

export function useDesk(): SavedDesk {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readClientDesk,
    () => serverDesk,
  );
}

/** The desk as last committed in this browser. */
export function currentDesk(): SavedDesk {
  return readClientDesk();
}

export function commitDesk(next: SavedDesk) {
  clientDesk = next;
  saveDesk(next);
  for (const listener of listeners) listener();
}
