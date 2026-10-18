import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { createBase58check } from "@scure/base";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hexToBytes, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { tron, tronAddressFromPublicKey } from "./tron";
import type { ChainProof } from "./types";

const b58c = createBase58check(sha256);
const MESSAGE = [
  "127.0.0.1:43127 wants you to sign in with your Tron account:",
  "TXXX",
  "",
  "Sign in to Omnifolio. <test> & more",
  "",
  "Nonce: " + "ab".repeat(32),
  "Issued At: 2026-10-09T19:58:00.000Z ünïcode",
].join("\n");

/** Built by hand here, independently of the module, from TronWeb's hashMessage. */
function signedDigest(message: string): Uint8Array {
  const body = new TextEncoder().encode(message);
  const head = new TextEncoder().encode(`\x19TRON Signed Message:\n${body.length}`);
  return keccak_256(concatBytes(head, body));
}

/** A Tron address is the EVM address of the same key behind a 0x41 byte. */
function tronFromEvm(evmAddress: string): string {
  return b58c.encode(concatBytes(new Uint8Array([0x41]), hexToBytes(evmAddress as Hex)));
}

function proof(address: string, signature: string, message = MESSAGE): ChainProof {
  return { address, message, signature, domain: "127.0.0.1:43127", nonce: "ab".repeat(32) };
}

/** Signs like TronWeb's signMessageV2: 0x + r + s + v(27/28). */
async function signLikeTronWeb(privateKey: Hex, message: string): Promise<string> {
  return privateKeyToAccount(privateKey).sign({ hash: `0x${bytesToHex(signedDigest(message))}` });
}

describe("tron.normalize", () => {
  it("accepts well-known addresses", () => {
    // 0x41 followed by 20 zero bytes.
    expect(tron.normalize(" T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb ")).toBe("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
    // USDT (TRC-20) contract, hex 41a614f803b6fd780986a42c78ec9c7f77e6ded13c.
    const usdt = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    expect(tron.normalize(usdt)).toBe(usdt);
    expect(bytesToHex(b58c.decode(usdt))).toBe("41a614f803b6fd780986a42c78ec9c7f77e6ded13c");
    expect(b58c.encode(Uint8Array.of(0x41, ...new Uint8Array(20)))).toBe("T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
  });

  it("rejects bad checksums, wrong versions, and other chains", () => {
    expect(() => tron.normalize("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toThrow();
    expect(() => tron.normalize(b58c.encode(new Uint8Array(21)))).toThrow();
    expect(() => tron.normalize("0xa614f803b6fd780986a42c78ec9c7f77e6ded13c")).toThrow();
    expect(() => tron.normalize("")).toThrow();
  });
});

describe("tron address derivation", () => {
  it("matches 0x41 + the EVM address of the same key", () => {
    const privateKey = generatePrivateKey();
    const evm = privateKeyToAccount(privateKey).address;
    const pub = secp256k1.getPublicKey(hexToBytes(privateKey), false);
    expect(tronAddressFromPublicKey(pub)).toBe(tronFromEvm(evm));
    expect(tronAddressFromPublicKey(secp256k1.getPublicKey(hexToBytes(privateKey), true))).toBe(tronFromEvm(evm));
  });

  it("derives the expected address for private key 1", () => {
    // Private key 1 is the generator point; its EVM address is the well-known 0x7E5F…5Bdf.
    const pub = secp256k1.getPublicKey(hexToBytes(`0x${"0".repeat(63)}1`), false);
    expect(tronAddressFromPublicKey(pub)).toBe(tronFromEvm("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"));
  });
});

describe("tron.verify (signMessageV2)", () => {
  it("accepts a signature from the address key", async () => {
    const privateKey = generatePrivateKey();
    const address = tronFromEvm(privateKeyToAccount(privateKey).address);
    const signature = await signLikeTronWeb(privateKey, MESSAGE);
    expect(signature).toMatch(/^0x[0-9a-f]{128}(1b|1c)$/);
    await expect(tron.verify(proof(address, signature))).resolves.toBe(true);
  });

  it("accepts v as 0/1 and no 0x prefix", async () => {
    const privateKey = generatePrivateKey();
    const address = tronFromEvm(privateKeyToAccount(privateKey).address);
    const sig = await signLikeTronWeb(privateKey, MESSAGE);
    const v = Number.parseInt(sig.slice(-2), 16) - 27;
    const raw = `${sig.slice(2, -2)}0${v}`;
    await expect(tron.verify(proof(address, raw))).resolves.toBe(true);
  });

  it("accepts a signature made with noble directly", async () => {
    const priv = secp256k1.utils.randomSecretKey();
    const address = tronAddressFromPublicKey(secp256k1.getPublicKey(priv, false));
    const rec = secp256k1.sign(signedDigest(MESSAGE), priv, { prehash: false, format: "recovered" });
    const signature = `0x${bytesToHex(rec.subarray(1))}${(rec[0] + 27).toString(16)}`;
    await expect(tron.verify(proof(address, signature))).resolves.toBe(true);
  });

  it("rejects a signature from another key", async () => {
    const owner = tronFromEvm(privateKeyToAccount(generatePrivateKey()).address);
    const signature = await signLikeTronWeb(generatePrivateKey(), MESSAGE);
    await expect(tron.verify(proof(owner, signature))).resolves.toBe(false);
  });

  it("rejects a tampered message", async () => {
    const privateKey = generatePrivateKey();
    const address = tronFromEvm(privateKeyToAccount(privateKey).address);
    const signature = await signLikeTronWeb(privateKey, MESSAGE);
    await expect(tron.verify(proof(address, signature, `${MESSAGE} `))).resolves.toBe(false);
    await expect(tron.verify(proof(address, signature, MESSAGE.replace("ab", "cd")))).resolves.toBe(false);
  });

  it("rejects a plain EIP-191 (Ethereum prefix) signature", async () => {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const signature = await account.signMessage({ message: MESSAGE });
    await expect(tron.verify(proof(tronFromEvm(account.address), signature))).resolves.toBe(false);
  });

  it("rejects an invalid address or malformed signature", async () => {
    const privateKey = generatePrivateKey();
    const address = tronFromEvm(privateKeyToAccount(privateKey).address);
    const signature = await signLikeTronWeb(privateKey, MESSAGE);
    await expect(tron.verify(proof(`${address}x`, signature))).resolves.toBe(false);
    await expect(tron.verify(proof(address, signature.slice(0, -2)))).resolves.toBe(false);
    await expect(tron.verify(proof(address, `${signature.slice(0, -2)}1d`))).resolves.toBe(false);
    await expect(tron.verify(proof(address, "zz"))).resolves.toBe(false);
  });
});
