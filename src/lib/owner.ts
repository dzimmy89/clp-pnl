import { walletKey } from "@/lib/wallet-set";

/**
 * The wallets allowed to sign in, from OWNER_WALLETS (addresses separated by commas, spaces
 * or new lines). An empty set leaves the site open to anyone, as before.
 */
export function parseOwnerWallets(raw: string | undefined, canonical: (address: string) => string[] = () => []): Set<string> {
  const keys = new Set<string>();
  for (const address of (raw ?? "").split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)) {
    keys.add(walletKey(address));
    // Sign-in stores some chains in another form (TON as raw 0:…, Starknet padded), so match those too.
    for (const form of canonical(address)) keys.add(walletKey(form));
  }
  return keys;
}

export function isOwnerAddress(owners: Set<string>, address: string): boolean {
  return owners.has(walletKey(address));
}
