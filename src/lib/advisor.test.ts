import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "@/lib/alerts";
import { DEFAULT_GOALS, suggest, type AdvisorInput } from "@/lib/advisor";
import { betaFromPrices, betaOf, bookBeta, positionBeta, type BetaBook } from "@/lib/beta";
import { portfolioMetrics, positionMetrics } from "@/lib/metrics";
import type { Leg, Position, SpotHolding } from "@/lib/types";

function leg(side: Leg["side"], symbol: string, amount: number, price: number, extra: Partial<Leg> = {}): Leg {
  const kind = /USD/.test(symbol) ? "stable" : symbol === "BTC" ? "btc" : "volatile";
  return { id: `${side}-${symbol}`, side, symbol, underlying: symbol, kind, amount, usd: amount * price, apy: 0.03, ...extra };
}

function position(id: string, legs: Leg[], extra: Partial<Position> = {}): Position {
  return { id, protocol: "aave", chain: "Ethereum", wallet: "0xabc", label: id, source: "live", legs, ...extra };
}

const betas: BetaBook = { ETH: { beta: 1.2, correlation: 0.8, days: 90, source: "history" } };
const BTC = 60_000;

function input(positions: Position[], spot: SpotHolding[] = [], extra: Partial<AdvisorInput> = {}): AdvisorInput {
  return {
    rows: portfolioMetrics(positions, spot, BTC).rows,
    spot,
    betas,
    btcPrice: BTC,
    thresholds: DEFAULT_THRESHOLDS,
    goals: DEFAULT_GOALS,
    hedgeTargets: {},
    leverageTargets: {},
    ...extra,
  };
}

describe("btc beta", () => {
  it("recovers a known beta from price paths", () => {
    const btc = [100];
    const eth = [100];
    for (let i = 1; i <= 60; i++) {
      const r = Math.sin(i) * 0.03;
      btc.push(btc[i - 1] * Math.exp(r));
      eth.push(eth[i - 1] * Math.exp(1.5 * r));
    }
    const measured = betaFromPrices(eth, btc);
    expect(measured?.beta).toBeCloseTo(1.5, 6);
    expect(measured?.correlation).toBeCloseTo(1, 6);
    expect(betaFromPrices(eth.slice(0, 10), btc.slice(0, 10))).toBeNull();
  });

  it("fixes BTC at 1 and stables at 0, assumes 1 for unknowns, and follows staked tokens to their base", () => {
    expect(betaOf("BTC", "btc", {}).beta).toBe(1);
    expect(betaOf("USDC", "stable", {}).beta).toBe(0);
    expect(betaOf("FOO", "volatile", {})).toMatchObject({ beta: 1, source: "assumed" });
    expect(betaOf("WSTETH", "volatile", betas).beta).toBe(1.2);
  });

  it("weights a levered position and the whole book", () => {
    // 10 ETH at 3,000 against 15,000 USDC: equity 15,000, ETH exposure 30,000 × 1.2.
    const p = position("p", [leg("supply", "ETH", 10, 3000), leg("borrow", "USDC", 15000, 1)]);
    const exposure = positionBeta(p, betas, BTC);
    expect(exposure.betaUsd).toBeCloseTo(36000);
    expect(exposure.betaBtc).toBeCloseTo(0.6);
    expect(exposure.beta).toBeCloseTo(2.4);
    const spot: SpotHolding[] = [{ id: "s", wallet: "0xabc", chain: "Bitcoin", symbol: "BTC", underlying: "BTC", kind: "btc", amount: 0.25, usd: 15000, priceUsd: BTC, source: "live" }];
    const book = bookBeta(portfolioMetrics([p], spot, BTC).rows, spot, betas, BTC);
    expect(book.betaUsd).toBeCloseTo(51000);
    expect(book.beta).toBeCloseTo(1.7);
  });
});

describe("advisor", () => {
  // Health = 10 × 3000 × 0.8 / 18,000 = 1.333.
  const risky = position("risky", [leg("supply", "ETH", 10, 3000, { liquidationThreshold: 0.8 }), leg("borrow", "USDC", 18000, 1)]);

  it("sizes repay, add-collateral and sell-to-repay so each reaches the health target", () => {
    const [first] = suggest(input([risky]));
    expect(first.kind).toBe("safety");
    expect(first.severity).toBe("warning");
    // Repay x: 24,000 / (18,000 − x) = 2 → x = 6,000.
    expect(first.options[0]).toContain("$6,000");
    // Add y ETH: (24,000 + 0.8y) / 18,000 = 2 → y = 15,000 (5 ETH).
    expect(first.options[1]).toMatch(/^Or add 5 ETH/);
    // Sell x to repay: (24,000 − 0.8x) / (18,000 − x) = 2 → x = 10,000.
    expect(first.options[2]).toContain("$10,000");
    expect(first.effects[0].after).toBe("2.00");
    const after = positionMetrics(position("after", [leg("supply", "ETH", 10, 3000, { liquidationThreshold: 0.8 }), leg("borrow", "USDC", 8000, 1)]), BTC);
    expect(after.healthFactor).toBeCloseTo(3);
  });

  it("keeps a protocol-reported health factor on its own scale", () => {
    const reported = { ...risky, id: "reported", healthFactor: 1.5 };
    const [first] = suggest(input([reported]));
    // Protocol weighted collateral = 1.5 × 18,000 = 27,000 → repay 18,000 − 13,500 = 4,500.
    expect(first.options[0]).toContain("$4,500");
    expect(first.effects[0].after).toBe("2.00");
  });

  it("unwinds to a leverage target and sizes a hedge", () => {
    const p = position("lev", [leg("supply", "ETH", 10, 3000, { liquidationThreshold: 0.8 }), leg("borrow", "USDC", 15000, 1)]);
    const found = suggest(input([p], [], { goals: { ...DEFAULT_GOALS, healthTarget: 1.2 }, leverageTargets: { lev: 1.5 }, hedgeTargets: { lev: 0.2 } }));
    const lev = found.find((s) => s.kind === "leverage")!;
    // Leverage 2 → 1.5: sell x where (30,000 − x) / 15,000 = 1.5 → x = 7,500.
    expect(lev.options[0]).toContain("2.5 ETH ($7,500.00)");
    expect(lev.effects[0].after).toBe("1.50×");
    const h = found.find((s) => s.kind === "hedge")!;
    // 0.2 × 10 ETH = 2 ETH borrowed, sold to repay USDC.
    expect(h.options[0]).toContain("Borrow 2 ETH");
    expect(h.options[0]).toContain("repay $6,000.00 of USDC");
    expect(h.effects[0].after).toBe("0.20");
  });

  it("moves the book toward a BTC beta target", () => {
    const spot: SpotHolding[] = [
      { id: "e", wallet: "0xabc", chain: "Ethereum", symbol: "ETH", underlying: "ETH", kind: "volatile", amount: 10, usd: 30000, priceUsd: 3000, source: "live" },
      { id: "u", wallet: "0xabc", chain: "Ethereum", symbol: "USDC", underlying: "USDC", kind: "stable", amount: 10000, usd: 10000, priceUsd: 1, source: "live" },
    ];
    // Beta = 36,000 / 40,000 = 0.9. Target 0.5 → cut 16,000 of beta-weighted exposure.
    const [beta] = suggest(input([], spot, { goals: { ...DEFAULT_GOALS, portfolioBeta: 0.5 } })).filter((s) => s.kind === "beta");
    expect(beta.title).toBe("Cut $16,000 of BTC-equivalent exposure");
    expect(beta.options[0]).toContain("Sell $13,333 of ETH (Ethereum)");
    expect(beta.effects[0]).toEqual({ label: "Portfolio BTC beta", before: "0.90", after: "0.50" });
  });

  it("repays across several loans when one is not enough, and keeps hedge proceeds in the position", () => {
    // Health = 24,000 / (6,000 USDC + 12,000 ETH loan) = 1.33; repay 6,000 needs both loans.
    const mixed = position("mixed", [leg("supply", "ETH", 10, 3000, { liquidationThreshold: 0.8 }), leg("borrow", "USDC", 3000, 1), leg("borrow", "ETH", 5, 3000)]);
    const safety = suggest(input([mixed], [], { hedgeTargets: { mixed: 0.5 } })).find((s) => s.kind === "safety")!;
    expect(safety.options[0]).toBe("Repay $6,000.00 of debt, starting with USDC.");
    expect(safety.effects[0].after).toBe("2.00");

    const thin = position("thin", [leg("supply", "ETH", 10, 3000, { liquidationThreshold: 0.8 }), leg("borrow", "USDC", 1000, 1)]);
    const hedge = suggest(input([thin])).find((s) => s.kind === "hedge")!;
    // 3 ETH ($9,000): repay the $1,000 loan, supply the other $8,000.
    expect(hedge.options[0]).toBe("Borrow 3 ETH ($9,000.00) and sell it, repay $1,000.00 of USDC and supply the other $8,000.00 as USDC.");
  });

  it("stays quiet on healthy, on-target books", () => {
    const calm = position("calm", [leg("supply", "ETH", 10, 3000, { liquidationThreshold: 0.8 }), leg("borrow", "ETH", 3, 3000), leg("borrow", "USDC", 3000, 1)]);
    expect(suggest(input([calm]))).toEqual([]);
  });
});
