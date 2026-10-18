/** What a hidden amount shows instead of digits. */
export const HIDDEN = "••••";

let amountsHidden = false;

/**
 * Privacy mode: dollar values and token amounts render as dots, so the dashboard can be
 * shown on a stream or a shared screen. Prices, rates and health factors stay visible.
 */
export function setAmountsHidden(hidden: boolean) {
  amountsHidden = hidden;
}

export function amountsAreHidden(): boolean {
  return amountsHidden;
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (amountsHidden) return `$${HIDDEN}`;
  return usd(value);
}

function usd(value: number): string {
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  }
  if (abs >= 10_000) {
    return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  }
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatPercent(decimal: number, digits = 2): string {
  if (!Number.isFinite(decimal)) return "—";
  return `${(decimal * 100).toFixed(digits)}%`;
}

export function formatRatio(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

export function formatLeverage(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}×`;
}

export function formatHealth(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (amountsHidden) return HIDDEN;
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
  });
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  // A market price says nothing about the holder, so privacy mode leaves it alone.
  if (value >= 1000) return usd(Math.round(value));
  if (value >= 1) return usd(value);
  return `$${value.toPrecision(3)}`;
}

export function shortAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 14) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export function signedUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value > 0) return `+${formatUsd(value)}`;
  return formatUsd(value);
}

export function priceTimestampLabel(unixSeconds: number | null): string {
  if (!unixSeconds) return "timestamp unavailable";
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");
}
