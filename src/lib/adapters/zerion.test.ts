import { describe, expect, it } from "vitest";
import { chainLabel, zerionToBook, type ZerionPosition } from "./zerion";

const W = "0x1111111111111111111111111111111111111111";

function item(
  id: string,
  chain: string,
  attributes: Partial<ZerionPosition["attributes"]> & { symbol?: string },
  dapp?: string,
): ZerionPosition {
  const { symbol, ...rest } = attributes;
  return {
    id,
    attributes: { fungible_info: { symbol: symbol ?? "ETH" }, quantity: { float: 1 }, value: 100, price: 100, ...rest },
    relationships: { chain: { data: { id: chain } }, ...(dapp ? { dapp: { data: { id: dapp } } } : {}) },
  };
}

describe("zerionToBook", () => {
  it("turns wallet rows into spot and skips trash and empty balances", () => {
    const { spot, positions } = zerionToBook(
      [
        item("a", "base", { position_type: "wallet", symbol: "USDC", quantity: { float: 50 }, value: 50, price: 1 }),
        item("b", "base", { position_type: "wallet", symbol: "SCAM", flags: { is_trash: true } }),
        item("c", "arbitrum", { position_type: "wallet", quantity: { float: 0 } }),
        item("d", "arbitrum", { position_type: "wallet", symbol: "NEW", value: null }),
      ],
      W,
    );
    expect(positions).toHaveLength(0);
    expect(spot.map((s) => [s.symbol, s.chain, s.usd, s.unpriced])).toEqual([
      ["USDC", "Base", 50, false],
      ["NEW", "Arbitrum", 0, true],
    ]);
    expect(spot[0].kind).toBe("stable");
  });

  it("groups a lending market's deposits and loans into one position", () => {
    const meta = { application_metadata: { name: "Morpho" }, protocol_module: "lending" };
    const { positions } = zerionToBook(
      [
        item("s1", "base", { ...meta, position_type: "deposit", symbol: "WETH", value: 3000 }),
        item("b1", "base", { ...meta, position_type: "loan", symbol: "USDC", value: 1000 }),
      ],
      W,
    );
    expect(positions).toHaveLength(1);
    const [p] = positions;
    expect(p.category).toBe("lending");
    expect(p.app).toBe("Morpho");
    expect(p.label).toBe("Morpho Lending · Base");
    expect(p.legs.map((leg) => [leg.side, leg.symbol, leg.usd, leg.isCollateral])).toEqual([
      ["supply", "WETH", 3000, true],
      ["borrow", "USDC", 1000, false],
    ]);
    expect(p.healthFactorSource).toBe("estimated");
  });

  it("keeps each liquidity pool as its own row and labels it by its tokens", () => {
    const lp = { application_metadata: { name: "Uniswap V3" }, protocol_module: "liquidity_pool", position_type: "deposit" };
    const { positions } = zerionToBook(
      [
        item("p1", "ethereum", { ...lp, group_id: "g1", symbol: "WETH" }),
        item("p2", "ethereum", { ...lp, group_id: "g1", symbol: "USDC" }),
        item("p3", "ethereum", { ...lp, group_id: "g2", symbol: "WBTC" }),
      ],
      W,
    );
    expect(positions.map((p) => p.label).sort()).toEqual(["Uniswap V3 WBTC · Ethereum", "Uniswap V3 WETH/USDC · Ethereum"]);
    expect(positions.every((p) => p.category === "liquidity")).toBe(true);
  });

  it("classifies staking and drops apps the desk reads directly", () => {
    const { positions } = zerionToBook(
      [
        item("st", "ethereum", { application_metadata: { name: "Lido" }, protocol_module: "staked", position_type: "staked" }),
        item("aave", "ethereum", { application_metadata: { name: "Aave V3" }, protocol_module: "lending", position_type: "deposit" }),
        item("aave-arb", "arbitrum", { application_metadata: { name: "Aave V3" }, protocol_module: "lending", position_type: "deposit" }),
      ],
      W,
    );
    expect(positions.map((p) => [p.app, p.chain, p.category])).toEqual(
      expect.arrayContaining([
        ["Lido", "Ethereum", "staking"],
        ["Aave V3", "Arbitrum", "lending"],
      ]),
    );
    expect(positions).toHaveLength(2);
  });
});

describe("chainLabel", () => {
  it("names known chains and title-cases the rest", () => {
    expect(chainLabel("binance-smart-chain")).toBe("BNB Chain");
    expect(chainLabel("some-new-chain")).toBe("Some New Chain");
  });
});
