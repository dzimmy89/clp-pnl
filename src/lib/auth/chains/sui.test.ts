import { ed25519 } from "@noble/curves/ed25519.js";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { sui, suiAddressFromPublicKey, suiPersonalMessageDigest } from "./sui";
import type { ChainProof } from "./types";

const DOMAIN = "127.0.0.1:43127";
const NONCE = "cd".repeat(32);
const text = (address: string) => `${DOMAIN} wants you to sign in with your Sui account:\n${address}\n\nNonce: ${NONCE}`;

type Scheme = "ed25519" | "secp256k1" | "secp256r1";

function keypair(scheme: Scheme) {
  if (scheme === "ed25519") {
    const secret = ed25519.utils.randomSecretKey();
    return { flag: 0, secret, publicKey: ed25519.getPublicKey(secret) };
  }
  const curve = scheme === "secp256k1" ? secp256k1 : p256;
  const secret = curve.utils.randomSecretKey();
  return { flag: scheme === "secp256k1" ? 1 : 2, secret, publicKey: curve.getPublicKey(secret, true) };
}

/** Signs the way the Sui TypeScript SDK keypairs do inside wallets. */
function walletSign(scheme: Scheme, key: ReturnType<typeof keypair>, message: string): string {
  const digest = suiPersonalMessageDigest(new TextEncoder().encode(message));
  let signature: Uint8Array;
  if (scheme === "ed25519") signature = ed25519.sign(digest, key.secret);
  else {
    // The SDK computes sha256(digest) and signs that hash without another prehash.
    const curve = scheme === "secp256k1" ? secp256k1 : p256;
    signature = curve.sign(sha256(digest), key.secret, { prehash: false, lowS: true });
  }
  const serialized = new Uint8Array(1 + signature.length + key.publicKey.length);
  serialized[0] = key.flag;
  serialized.set(signature, 1);
  serialized.set(key.publicKey, 1 + signature.length);
  return base64.encode(serialized);
}

function proofFor(address: string, signature: string, message = text(address)): ChainProof {
  return { address, message, signature, domain: DOMAIN, nonce: NONCE };
}

describe("Sui digest", () => {
  it("matches the intent || ULEB128 length || bytes layout", () => {
    // A 200-byte message needs a two-byte ULEB128 length (0xc8 0x01).
    const msg = new Uint8Array(200).fill(7);
    const manual = new Uint8Array([3, 0, 0, 0xc8, 0x01, ...msg]);
    expect(suiPersonalMessageDigest(msg)).toEqual(blake2b(manual, { dkLen: 32 }));
  });
});

describe.each<Scheme>(["ed25519", "secp256k1", "secp256r1"])("Sui sign-in (%s)", (scheme) => {
  it("accepts a personal-message signature from the address key", async () => {
    const key = keypair(scheme);
    const address = suiAddressFromPublicKey(key.flag, key.publicKey);
    await expect(sui.verify(proofFor(address, walletSign(scheme, key, text(address))))).resolves.toBe(true);
  });

  it("accepts an uppercase or unpadded form of the same address", async () => {
    const key = keypair(scheme);
    const address = suiAddressFromPublicKey(key.flag, key.publicKey);
    const message = text(address);
    await expect(sui.verify(proofFor(address.toUpperCase().replace("0X", "0x"), walletSign(scheme, key, message), message))).resolves.toBe(true);
  });

  it("rejects a signature from another key", async () => {
    const owner = keypair(scheme);
    const other = keypair(scheme);
    const address = suiAddressFromPublicKey(owner.flag, owner.publicKey);
    await expect(sui.verify(proofFor(address, walletSign(scheme, other, text(address))))).resolves.toBe(false);
  });

  it("rejects a signature over a different text", async () => {
    const key = keypair(scheme);
    const address = suiAddressFromPublicKey(key.flag, key.publicKey);
    const signature = walletSign(scheme, key, text(address).replace(DOMAIN, "evil.example"));
    await expect(sui.verify(proofFor(address, signature))).resolves.toBe(false);
  });

  it("rejects when the key does not hash to the claimed address", async () => {
    const key = keypair(scheme);
    const other = keypair(scheme);
    const otherAddress = suiAddressFromPublicKey(other.flag, other.publicKey);
    await expect(sui.verify(proofFor(otherAddress, walletSign(scheme, key, text(otherAddress))))).resolves.toBe(false);
  });
});

describe("Sui unsupported signatures", () => {
  it("rejects a raw sha256-free ECDSA signature (wrong hashing)", async () => {
    const key = keypair("secp256k1");
    const address = suiAddressFromPublicKey(key.flag, key.publicKey);
    const digest = suiPersonalMessageDigest(new TextEncoder().encode(text(address)));
    const sig = secp256k1.sign(digest, key.secret, { prehash: false });
    const serialized = base64.encode(new Uint8Array([1, ...sig, ...key.publicKey]));
    await expect(sui.verify(proofFor(address, serialized))).resolves.toBe(false);
  });

  it.each([3, 5, 6])("rejects flag 0x0%i (multisig / zkLogin / passkey)", async (flag) => {
    const key = keypair("ed25519");
    const address = suiAddressFromPublicKey(flag, key.publicKey);
    const signature = base64.decode(walletSign("ed25519", key, text(address)));
    signature[0] = flag;
    await expect(sui.verify(proofFor(address, base64.encode(signature)))).resolves.toBe(false);
  });

  it("rejects garbage", async () => {
    await expect(sui.verify(proofFor(`0x${"1".repeat(64)}`, "not base64!!"))).resolves.toBe(false);
  });
});

describe("Sui normalize", () => {
  it("lowercases and left-pads", () => {
    expect(sui.normalize("0x2")).toBe(`0x${"0".repeat(63)}2`);
    expect(sui.normalize(` 0x${"AB".repeat(32)} `)).toBe(`0x${"ab".repeat(32)}`);
  });

  it("throws on invalid input", () => {
    expect(() => sui.normalize("0x")).toThrow();
    expect(() => sui.normalize(`0x${"a".repeat(65)}`)).toThrow();
    expect(() => sui.normalize("0xzz")).toThrow();
  });
});
