export function fmtUsd(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 1 || abs === 0 ? 2 : 4;
  const s = abs.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  return `${sign}$${s}`;
}

export function fmtAmount(v: number, symbol?: string): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  let s: string;
  if (abs === 0) s = "0";
  else if (abs >= 1_000_000) s = abs.toLocaleString("en-US", { maximumFractionDigits: 0 });
  else if (abs >= 1000) s = abs.toLocaleString("en-US", { maximumFractionDigits: 2 });
  else if (abs >= 1) s = abs.toLocaleString("en-US", { maximumFractionDigits: 4 });
  else s = abs.toLocaleString("en-US", { maximumSignificantDigits: 4 });
  return symbol ? `${v < 0 ? "−" : ""}${s} ${symbol}` : `${v < 0 ? "−" : ""}${s}`;
}

export function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  if (v >= 1e9 || v < 1e-6) return v.toExponential(3);
  if (v >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (v >= 1) return v.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return v.toLocaleString("en-US", { maximumSignificantDigits: 5 });
}

export function fmtFee(fee: number): string {
  return `${(fee / 10_000).toLocaleString("en-US", { maximumFractionDigits: 3 })}%`;
}

export function fmtPct(v: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
