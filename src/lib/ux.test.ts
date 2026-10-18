import { afterEach, describe, expect, it } from "vitest";
import { freshAlerts, titleWithAlerts } from "@/lib/alert-watch";
import type { DeskAlert } from "@/lib/alerts";
import { bookCsv } from "@/lib/export";
import { formatAmount, formatPrice, formatUsd, setAmountsHidden, signedUsd } from "@/lib/format";
import { changeSince } from "@/lib/history";
import { portfolioMetrics } from "@/lib/metrics";
import { parsePrefs, DEFAULT_PREFS } from "@/lib/prefs";
import type { Position, SpotHolding } from "@/lib/types";

const HOUR = 60 * 60 * 1000;

describe("privacy mode", () => {
  afterEach(() => setAmountsHidden(false));

  it("hides dollar values and amounts but keeps prices", () => {
    setAmountsHidden(true);
    expect(formatUsd(12_345)).toBe("$••••");
    expect(signedUsd(50)).toBe("+$••••");
    expect(formatAmount(1.5)).toBe("••••");
    expect(formatPrice(65_000)).toBe("$65,000");
    expect(formatPrice(1.25)).toBe("$1.25");
  });

  it("shows digits when off", () => {
    expect(formatUsd(12_345)).toBe("$12,345");
    expect(formatAmount(1.5)).toBe("1.5");
  });
});

describe("change since", () => {
  const now = 1_000 * HOUR;
  it("compares with the reading nearest the window start", () => {
    const points = [
      { t: now - 30 * HOUR, usd: 90 },
      { t: now - 23 * HOUR, usd: 100 },
      { t: now - HOUR, usd: 119 },
    ];
    const change = changeSince(points, 120, 24 * HOUR, now);
    expect(change?.usd).toBe(20);
    expect(change?.pct).toBeCloseTo(0.2);
    expect(change?.since).toBe(now - 23 * HOUR);
  });

  it("ignores readings too recent to stand for the window", () => {
    expect(changeSince([{ t: now - 2 * HOUR, usd: 100 }], 120, 24 * HOUR, now)).toBeNull();
  });

  it("has no percent from a zero start", () => {
    expect(changeSince([{ t: now - 24 * HOUR, usd: 0 }], 50, 24 * HOUR, now)?.pct).toBeNull();
  });
});

describe("alert watch", () => {
  const alert = (id: string, severity: DeskAlert["severity"] = "warning"): DeskAlert => ({ id, positionId: "p", severity, sentence: id });

  it("sets a baseline on the first read", () => {
    expect(freshAlerts(null, [alert("a")])).toEqual([]);
  });

  it("returns only alerts that weren't firing before", () => {
    expect(freshAlerts(new Set(["a"]), [alert("a"), alert("b")]).map((a) => a.id)).toEqual(["b"]);
  });

  it("puts the count in the title", () => {
    expect(titleWithAlerts("Omnifolio", [])).toBe("Omnifolio");
    expect(titleWithAlerts("Omnifolio", [alert("a"), alert("b")])).toBe("(2) Omnifolio");
    expect(titleWithAlerts("Omnifolio", [alert("a", "critical")])).toBe("(1!) Omnifolio");
  });
});

describe("prefs", () => {
  it("falls back to defaults for missing or bad values", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs({ hideAmounts: true, notify: "yes" })).toEqual({ ...DEFAULT_PREFS, hideAmounts: true });
  });
});

describe("csv export", () => {
  const position: Position = {
    id: "p",
    protocol: "aave",
    chain: "Ethereum",
    wallet: "0xabc",
    label: "Loop",
    source: "live",
    healthFactor: 1.8,
    healthFactorSource: "protocol",
    legs: [
      { id: "s", side: "supply", symbol: "WBTC", underlying: "BTC", kind: "btc", amount: 1, usd: 100_000, apy: 0.01, priceUsd: 100_000 },
      { id: "b", side: "borrow", symbol: "USDC", underlying: "USDC", kind: "stable", amount: 40_000, usd: 40_000, apy: 0.06 },
    ],
  };
  const spot: SpotHolding[] = [
    { id: "x", wallet: "0xabc", chain: "Base", symbol: "=EVIL,1", underlying: "X", kind: "volatile", amount: 5, usd: 0, priceUsd: 0, source: "live", unpriced: true },
  ];

  it("writes one line per leg and balance in raw numbers", () => {
    const csv = bookCsv(portfolioMetrics([position], spot, 100_000).rows, spot);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(4);
    const first = lines[1].split(",");
    expect(first.slice(0, 12)).toEqual(["Lending", "Aave", "Ethereum", "0xabc", "supply", "WBTC", "1", "100000", "100000", "0.01", "1.8", "BTC"]);
    // Liquidation price: the protocol's 1.8 puts spot / 1.8 on its scale; the move is a fall, so negative.
    expect(Number(first[12])).toBeCloseTo(100_000 / 1.8, 6);
    expect(Number(first[13])).toBeCloseTo(1 / 1.8 - 1, 9);
    expect(first[14]).toBe("live");
    expect(lines[2]).toContain("borrow,USDC,40000,1,-40000,0.06");
    // Formula-looking text is defused and quoted.
    expect(lines[3]).toBe(`Wallet balances,,Base,0xabc,balance,"'=EVIL,1",5,,,,,,,,live`);
  });
});
