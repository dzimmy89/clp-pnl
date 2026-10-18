import { hash, typedData } from "starknet";
import { describe, expect, it, vi } from "vitest";
import { nonceFelt, parseStarknetSignature, starknet, starknetSignInText, starknetSignInTypedData } from "./starknet";
import type { ChainProof } from "./types";

const NONCE = "ab".repeat(32);
const DOMAIN = "omnifolio.example";
const ADDRESS = "0x" + "0".repeat(2) + "4a".repeat(31);
const MESSAGE = [
  `${DOMAIN} wants you to sign in with your Starknet account:`,
  ADDRESS,
  "",
  "Sign in to Omnifolio. This only proves you own this wallet. It is not a transaction and costs no gas.",
  "",
  `URI: https://${DOMAIN}`,
  "Version: 1",
  `Nonce: ${NONCE}`,
  "Issued At: 2026-10-09T19:58:00.000Z",
].join("\n");
const SIGNATURE = ["0x1234", "0xabcd"];

function proof(overrides: Partial<ChainProof> = {}): ChainProof {
  return {
    address: ADDRESS,
    message: MESSAGE,
    signature: JSON.stringify(SIGNATURE),
    domain: DOMAIN,
    nonce: NONCE,
    ...overrides,
  };
}

type RpcReply = { result?: unknown; error?: unknown };

function rpcFetch(...replies: RpcReply[]) {
  let i = 0;
  return vi.fn<typeof fetch>(async () =>
    Response.json({ jsonrpc: "2.0", id: 1, ...replies[Math.min(i++, replies.length - 1)] }),
  );
}

function asFetch(f: ReturnType<typeof rpcFetch>): typeof fetch {
  return f as unknown as typeof fetch;
}

describe("starknet typed data", () => {
  it("builds a SNIP-12 revision 1 payload that hashes", () => {
    const td = starknetSignInTypedData(MESSAGE, NONCE);
    expect(td.domain).toEqual({ name: "Omnifolio", version: "1", chainId: "SN_MAIN", revision: "1" });
    expect(td.primaryType).toBe("SignIn");
    expect(td.message).toEqual({ message: starknetSignInText(MESSAGE), nonce: `0x${NONCE.slice(0, 62)}` });
    const h = typedData.getMessageHash(td, ADDRESS);
    expect(h).toMatch(/^0x[0-9a-f]+$/);
    // Bound to the account and to the text.
    expect(typedData.getMessageHash(td, "0x123")).not.toBe(h);
    expect(typedData.getMessageHash(starknetSignInTypedData(`${MESSAGE}!`, NONCE), ADDRESS)).not.toBe(h);
  });

  it("flattens the text to one printable-ASCII line", () => {
    expect(starknetSignInText("a\n\nb\r\nc")).toBe("a | b | c");
    expect(starknetSignInText(MESSAGE)).toContain(`| Nonce: ${NONCE} |`);
    expect(() => starknetSignInText("caf\u00e9")).toThrow();
    expect(() => starknetSignInText("tab\there")).toThrow();
  });

  it("rejects a malformed nonce", () => {
    expect(() => nonceFelt("xyz")).toThrow();
  });

  it("parses felt arrays and rejects junk", () => {
    expect(parseStarknetSignature('["0x1", "2"]')).toEqual(["0x1", "0x2"]);
    expect(parseStarknetSignature("[]")).toBeNull();
    expect(parseStarknetSignature('["nope"]')).toBeNull();
    expect(parseStarknetSignature('{"r":"0x1"}')).toBeNull();
    expect(parseStarknetSignature("not json")).toBeNull();
  });
});

describe("starknet.normalize", () => {
  it("pads to 0x + 64 lowercase hex", () => {
    expect(starknet.normalize("0xABC")).toBe(`0x${"0".repeat(61)}abc`);
  });

  it("throws on garbage", () => {
    expect(() => starknet.normalize("hello")).toThrow();
  });
});

describe("starknet.verify", () => {
  it("accepts when the account returns VALID, and sends the right call", async () => {
    const fetch = rpcFetch({ result: ["0x56414c4944"] });
    await expect(starknet.verify(proof(), { fetch: asFetch(fetch) })).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    const address = starknet.normalize(ADDRESS);
    const messageHash = typedData.getMessageHash(starknetSignInTypedData(MESSAGE, NONCE), address);
    expect(body.method).toBe("starknet_call");
    expect(body.params.block_id).toBe("latest");
    expect(body.params.request).toEqual({
      contract_address: address,
      entry_point_selector: hash.getSelectorFromName("is_valid_signature"),
      calldata: [messageHash, "0x2", ...SIGNATURE],
    });
  });

  it("accepts a Cairo 0 account through isValidSignature returning 1", async () => {
    const fetch = rpcFetch({ error: { code: 21, message: "Entry point not found" } }, { result: ["0x1"] });
    await expect(starknet.verify(proof(), { fetch: asFetch(fetch) })).resolves.toBe(true);
    const second = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(second.params.request.entry_point_selector).toBe(hash.getSelectorFromName("isValidSignature"));
  });

  it("rejects when the account reverts", async () => {
    const fetch = rpcFetch({ error: { code: 40, message: "Contract error: argent/invalid-signature" } });
    await expect(starknet.verify(proof(), { fetch: asFetch(fetch) })).resolves.toBe(false);
  });

  it("rejects a 0 result", async () => {
    const fetch = rpcFetch({ result: ["0x0"] });
    await expect(starknet.verify(proof(), { fetch: asFetch(fetch) })).resolves.toBe(false);
  });

  it("rejects without calling the RPC when the signature is malformed", async () => {
    const fetch = rpcFetch({ result: ["0x56414c4944"] });
    await expect(starknet.verify(proof({ signature: "0x1234" }), { fetch: asFetch(fetch) })).resolves.toBe(false);
    await expect(starknet.verify(proof({ address: "nope" }), { fetch: asFetch(fetch) })).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects when the network fails", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(starknet.verify(proof(), { fetch: fetch as unknown as typeof globalThis.fetch })).resolves.toBe(false);
  });
});
