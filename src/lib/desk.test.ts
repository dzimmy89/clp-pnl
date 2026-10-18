import { describe, expect, it } from "vitest";
import { accountPart, defaultDesk, loadPasted, mergeDesks, parseDesk } from "./desk";
import { localHistoryFor } from "./account-sync";
import { dedupeWrites, isHistoryScope, validHistoryWrites } from "./history";
import type { Position, SpotHolding } from "./types";

const position = (id: string): Position => ({
  id,
  protocol: "alpend",
  chain: "Canton",
  wallet: "manual",
  label: id,
  source: "manual",
  legs: [{ id: "l", side: "supply", symbol: "CBTC", underlying: "BTC", kind: "btc", amount: 1, usd: 100000, apy: 0 }],
});
const balance = (id: string): SpotHolding => ({
  id,
  wallet: "manual",
  chain: "Canton",
  symbol: "CC",
  underlying: "CC",
  kind: "volatile",
  amount: 1000,
  usd: 120,
  priceUsd: 0.12,
  source: "manual",
});

describe("loadPasted", () => {
  it("keeps a saved list and drops malformed entries", () => {
    const pasted = loadPasted({
      pasted: [
        { kind: "sui", address: "0xab" },
        { kind: "dogecoin", address: "D1" },
        { kind: "evm", address: " " },
      ],
    });
    expect(pasted).toEqual([{ kind: "sui", address: "0xab" }]);
  });

  it("carries over the one-address-per-chain fields older versions saved", () => {
    expect(loadPasted({ addresses: { evm: " 0xa ", solana: "", near: "bob.near" } })).toEqual([
      { kind: "evm", address: "0xa" },
      { kind: "near", address: "bob.near" },
    ]);
  });
});

describe("parseDesk", () => {
  it("drops malformed books, balances and numbers", () => {
    const desk = parseDesk({
      mode: "live",
      manual: [position("p1"), { id: "bad", legs: "nope" }],
      manualSpot: [balance("s1"), { id: "s2", symbol: "CC", chain: "Canton", amount: "1", usd: 1 }],
      hedgeTargets: { p1: 0.3, p2: "x" },
      goals: { healthTarget: "2", portfolioBeta: 0.5 },
      thresholds: { maxLeverage: 4, healthWarning: null },
    });
    expect(desk.mode).toBe("live");
    expect(desk.manual.map((p) => p.id)).toEqual(["p1"]);
    expect(desk.manualSpot.map((s) => s.id)).toEqual(["s1"]);
    expect(desk.hedgeTargets).toEqual({ p1: 0.3 });
    expect(desk.goals).toEqual({ healthTarget: 2, portfolioLeverage: null, portfolioBeta: 0.5 });
    expect(desk.thresholds.maxLeverage).toBe(4);
    expect(desk.thresholds.healthWarning).toBe(defaultDesk().thresholds.healthWarning);
  });

  it("treats anything but an object as an empty desk", () => {
    expect(parseDesk("junk")).toEqual(defaultDesk());
  });
});

describe("mergeDesks", () => {
  it("keeps everything from both sides, the account winning on conflicts", () => {
    const account = accountPart({
      ...defaultDesk(),
      pasted: [{ kind: "evm", address: "0xAbC" }],
      manual: [position("p1")],
      hedgeTargets: { p1: 0.4 },
      goals: { healthTarget: 1.8, portfolioLeverage: null, portfolioBeta: null },
    });
    const local = {
      ...defaultDesk(),
      mode: "live" as const,
      pasted: [{ kind: "evm" as const, address: "0xabc" }, { kind: "near" as const, address: "bob.near" }],
      manual: [position("p1"), position("p2")],
      manualSpot: [balance("s1")],
      hedgeTargets: { p1: 0.1, p2: 0.2 },
    };
    const merged = mergeDesks(account, local);
    expect(merged.mode).toBe("live");
    expect(merged.pasted).toEqual([{ kind: "evm", address: "0xAbC" }, { kind: "near", address: "bob.near" }]);
    expect(merged.manual.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(merged.manualSpot.map((s) => s.id)).toEqual(["s1"]);
    expect(merged.hedgeTargets).toEqual({ p1: 0.4, p2: 0.2 });
    expect(merged.goals.healthTarget).toBe(1.8);
  });

  it("never sends browser-only fields to the account", () => {
    expect(Object.keys(accountPart({ ...defaultDesk(), syncedAccount: "a" }))).not.toContain("syncedAccount");
    expect(Object.keys(accountPart(defaultDesk()))).not.toContain("mode");
  });
});

describe("account history", () => {
  it("moves the signed-out series onto the account and leaves other accounts' behind", () => {
    const writes = localHistoryFor("acct", {
      "book:device": [{ t: 1, usd: 10 }],
      "book:acct": [{ t: 2, usd: 20 }],
      "book:other": [{ t: 3, usd: 30 }],
      "wallet:0xabc": [{ t: 4, usd: 40 }],
    });
    expect(writes).toEqual([
      { scope: "book:acct", t: 1, usd: 10 },
      { scope: "book:acct", t: 2, usd: 20 },
      { scope: "wallet:0xabc", t: 4, usd: 40 },
    ]);
  });

  it("validates scopes and readings", () => {
    const now = Date.UTC(2026, 9, 11);
    expect(isHistoryScope("book:acct")).toBe(true);
    expect(isHistoryScope("wallet:")).toBe(false);
    expect(isHistoryScope("other:x")).toBe(false);
    const writes = validHistoryWrites(
      [
        { scope: "book:a", t: now - 1000, usd: 5 },
        { scope: "book:a", t: now + 2 * 60 * 60 * 1000, usd: 5 },
        { scope: "book:a", t: now, usd: Number.NaN },
        { scope: "x", t: now, usd: 1 },
      ],
      now,
    );
    expect(writes).toHaveLength(1);
  });

  it("keeps the latest reading per 15-minute bucket", () => {
    const base = Date.UTC(2026, 9, 11, 12, 0);
    const kept = dedupeWrites([
      { scope: "book:a", t: base + 60_000, usd: 1 },
      { scope: "book:a", t: base + 120_000, usd: 2 },
      { scope: "book:a", t: base + 20 * 60_000, usd: 3 },
      { scope: "wallet:x", t: base + 60_000, usd: 4 },
    ]);
    expect(kept.map((w) => w.usd).sort()).toEqual([2, 3, 4]);
  });
});
