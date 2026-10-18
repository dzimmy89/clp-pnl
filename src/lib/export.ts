import type { BookRow } from "@/lib/metrics";
import { positionAppName, type SpotHolding } from "@/lib/types";
import { TYPE_LABEL, categoryOf } from "@/lib/view-filter";

const HEADER = ["Type", "App", "Chain", "Wallet", "Side", "Symbol", "Amount", "Price USD", "Value USD", "APY", "Health factor", "Liq. asset", "Liq. price USD", "Liq. move", "Source"];

function cell(value: string | number | null | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  // Text a spreadsheet would run as a formula gets a leading quote; commas and quotes get quoted.
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One line per supply, borrow and wallet balance, in raw numbers for a spreadsheet. */
export function bookCsv(rows: BookRow[], spot: SpotHolding[]): string {
  const lines: (string | number | null | undefined)[][] = [HEADER];
  for (const { position, metrics } of rows) {
    for (const leg of position.legs) {
      lines.push([
        TYPE_LABEL[categoryOf(position)],
        positionAppName(position),
        position.chain,
        position.wallet,
        leg.side,
        leg.symbol,
        leg.amount,
        leg.priceUsd ?? (leg.amount ? leg.usd / leg.amount : null),
        leg.side === "borrow" ? -leg.usd : leg.usd,
        leg.apyUnknown ? null : leg.apy,
        metrics.healthFactor,
        metrics.liquidationPriceUsd == null ? null : metrics.primaryUnderlying,
        metrics.liquidationPriceUsd,
        // Signed: −0.4 means every crypto asset falling 40% together liquidates the book.
        metrics.liquidationDistance == null ? null : metrics.liquidationSide === "above" ? metrics.liquidationDistance : -metrics.liquidationDistance,
        position.source,
      ]);
    }
  }
  for (const holding of spot) {
    lines.push([
      TYPE_LABEL.wallet,
      "",
      holding.chain,
      holding.wallet,
      "balance",
      holding.symbol,
      holding.amount,
      holding.unpriced ? null : holding.priceUsd,
      holding.unpriced ? null : holding.usd,
      null,
      null,
      null,
      null,
      null,
      holding.source,
    ]);
  }
  return lines.map((line) => line.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function csvFileName(now = new Date()): string {
  return `omnifolio-${now.toISOString().slice(0, 10)}.csv`;
}
