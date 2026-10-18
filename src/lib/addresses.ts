export function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function isSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

export function isNearAccount(value: string): boolean {
  const account = value.trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(account)) return true;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(account) && account.length >= 2 && account.length <= 64;
}

export function isCantonParty(value: string): boolean {
  return value.trim().length >= 3;
}
