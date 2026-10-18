import { describe, expect, it } from "vitest";
import { burrowUnits, priceSymbol } from "@/lib/adapters/rhea";

describe("rhea adapter", () => {
  it("reads Burrow balances in token decimals plus the asset's extra decimals", () => {
    // USDT.e: 6 token decimals + 12 extra, so 8.016 USDT.e is stored as 8 016 000 000 000 000 000.
    expect(burrowUnits("8016000000000000000", 6 + 12)).toBeCloseTo(8.016, 9);
    // wNEAR: 24 decimals, no extra.
    expect(burrowUnits("10000954000000000000000000", 24)).toBeCloseTo(10.000954, 9);
    expect(burrowUnits(undefined, 18)).toBe(0);
  });

  it("prices a bridged token as the token it wraps", () => {
    expect(priceSymbol("USDT.e")).toBe("USDT");
    expect(priceSymbol("USDC.E")).toBe("USDC");
    expect(priceSymbol("wNEAR")).toBe("wNEAR");
  });
});
