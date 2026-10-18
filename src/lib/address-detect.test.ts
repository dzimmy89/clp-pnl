import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { detectKinds, parseAddressList } from "./address-detect";

const EVM = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const HEX64 = `0x${"ab".repeat(32)}`;
const SOLANA = "Ex6pGc7XS7rBSEpV5Q17gabVRJJ1sJk21wRxgKr6Ldq7";
const TRON = "THB3VZEcYBdo4wDnP3hzxrp3aPr4Hsd2Jm";
const TON = "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N";
const KASPA = "kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj";
const COSMOS = bech32.encode("cosmos", bech32.toWords(new Uint8Array(20).fill(7)));
const OSMO = bech32.encode("osmo", bech32.toWords(new Uint8Array(20).fill(7)));
const INJ = bech32.encode("inj", bech32.toWords(new Uint8Array(20).fill(7)));
const CARDANO = "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";

describe("detectKinds", () => {
  it("settles the chain when the format is unique", () => {
    expect(detectKinds(EVM)).toEqual(["evm"]);
    expect(detectKinds(SOLANA)).toEqual(["solana"]);
    expect(detectKinds(TRON)).toEqual(["tron"]);
    expect(detectKinds(TON)).toEqual(["ton"]);
    expect(detectKinds(`0:${"ab".repeat(32)}`)).toEqual(["ton"]);
    expect(detectKinds(KASPA)).toEqual(["kaspa"]);
    expect(detectKinds(COSMOS)).toEqual(["cosmos"]);
    expect(detectKinds(OSMO)).toEqual(["cosmos"]);
    expect(detectKinds(CARDANO)).toEqual(["cardano"]);
    expect(detectKinds("alice.near")).toEqual(["near"]);
    expect(detectKinds("bot.tg")).toEqual(["near"]);
    expect(detectKinds("ab".repeat(32))).toEqual(["near"]);
    expect(detectKinds("Party::1220abcd")).toEqual(["canton"]);
  });

  it("lists every candidate for shared hex formats", () => {
    expect(detectKinds(HEX64)).toEqual(["sui", "aptos", "starknet"]);
    expect(detectKinds(`0x${"1".repeat(63)}`)).toEqual(["starknet", "aptos"]);
  });

  it("rejects what no reader can use", () => {
    expect(detectKinds("hello")).toEqual([]);
    expect(detectKinds(INJ)).toEqual([]);
    expect(detectKinds("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toEqual([]);
    expect(detectKinds("0x12zz")).toEqual([]);
  });
});

describe("parseAddressList", () => {
  it("splits on lines, commas and spaces and drops repeats", () => {
    const parsed = parseAddressList(`${EVM}, ${SOLANA}\n${TRON};${EVM}\n\n  ${KASPA}`);
    expect(parsed.map((p) => [p.address, p.kinds])).toEqual([
      [EVM, ["evm"]],
      [SOLANA, ["solana"]],
      [TRON, ["tron"]],
      [KASPA, ["kaspa"]],
    ]);
  });

  it("takes a chain: prefix as the chain", () => {
    expect(parseAddressList(`aptos:${HEX64} SUI:${HEX64}`)).toEqual([
      { address: HEX64, kinds: ["aptos"] },
      { address: HEX64, kinds: ["sui"] },
    ]);
  });
});
