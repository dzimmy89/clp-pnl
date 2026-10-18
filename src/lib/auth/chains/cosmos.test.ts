import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { adr36SignBytes, cosmos, cosmosAddressFromPublicKey } from "./cosmos";
import type { ChainProof } from "./types";

const MESSAGE = [
  "127.0.0.1:43127 wants you to sign in with your Cosmos account:",
  "cosmos1…",
  "",
  "Sign in to Omnifolio. <b> & more ünïcode",
  "",
  `Nonce: ${"ab".repeat(32)}`,
].join("\n");

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function keyPair(prefix = "cosmos") {
  const secret = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(secret, true);
  const address = bech32.encode(prefix, bech32.toWords(ripemd160(sha256(publicKey))));
  return { secret, publicKey, address };
}

/** The sign doc exactly as Keplr's makeADR36AminoSignDoc + serializeSignDoc produce it, by hand. */
function expectedDoc(signer: string, message: string): string {
  const data = Buffer.from(message, "utf8").toString("base64");
  return (
    `{"account_number":"0","chain_id":"","fee":{"amount":[],"gas":"0"},"memo":"",` +
    `"msgs":[{"type":"sign/MsgSignData","value":{"data":"${data}","signer":"${signer}"}}],"sequence":"0"}`
  );
}

/** Signs like Keplr/Leap signArbitrary: secp256k1 over sha256(signDoc), compact 64 bytes, base64. */
function signArbitrary(secret: Uint8Array, signer: string, message: string): string {
  const doc = new TextEncoder().encode(expectedDoc(signer, message));
  return b64(secp256k1.sign(doc, secret, { prehash: true, lowS: true, format: "compact" }));
}

function proof(address: string, publicKey: Uint8Array, signature: string, message = MESSAGE): ChainProof {
  return {
    address,
    message,
    signature,
    publicKey: b64(publicKey),
    domain: "127.0.0.1:43127",
    nonce: "ab".repeat(32),
  };
}

describe("ADR-036 sign doc", () => {
  it("serializes with sorted keys and no whitespace", () => {
    const signer = "cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu";
    expect(new TextDecoder().decode(adr36SignBytes(signer, "hello"))).toBe(expectedDoc(signer, "hello"));
  });

  it("escapes <, > and & like cosmjs serializeSignDoc", () => {
    // base64 data and bech32 never contain these, but the escaping must still match byte for byte.
    const text = new TextDecoder().decode(adr36SignBytes("a<b>&c", "x"));
    const bs = "\\";
    expect(text).toContain(`"signer":"a${bs}u003cb${bs}u003e${bs}u0026c"`);
    expect(text).not.toMatch(/[<>&]/);
  });
});

describe("cosmos.normalize", () => {
  it("lowercases and accepts any prefix", () => {
    const { address } = keyPair("osmo");
    expect(cosmos.normalize(` ${address.toUpperCase()} `)).toBe(address);
    expect(address.startsWith("osmo1")).toBe(true);
  });

  it("rejects bad checksums and non-20-byte payloads", () => {
    const { address } = keyPair();
    const flipped = address.slice(0, -1) + (address.endsWith("q") ? "p" : "q");
    expect(() => cosmos.normalize(flipped)).toThrow();
    expect(() => cosmos.normalize(bech32.encode("cosmos", bech32.toWords(new Uint8Array(32))))).toThrow();
    expect(() => cosmos.normalize("0x1234")).toThrow();
  });

  it("derives the address from the compressed key", () => {
    const { publicKey, address } = keyPair();
    expect(cosmosAddressFromPublicKey("cosmos", publicKey)).toBe(address);
  });
});

describe("cosmos.verify (ADR-036 signArbitrary)", () => {
  it("accepts a signature from the address key", async () => {
    const { secret, publicKey, address } = keyPair();
    const signature = signArbitrary(secret, address, MESSAGE);
    await expect(cosmos.verify(proof(address, publicKey, signature))).resolves.toBe(true);
  });

  it("accepts other prefixes and an uppercase address", async () => {
    const { secret, publicKey, address } = keyPair("osmo");
    const signature = signArbitrary(secret, address, MESSAGE);
    await expect(cosmos.verify(proof(address.toUpperCase(), publicKey, signature))).resolves.toBe(true);
  });

  it("rejects a signature from another key", async () => {
    const owner = keyPair();
    const other = keyPair();
    const signature = signArbitrary(other.secret, owner.address, MESSAGE);
    await expect(cosmos.verify(proof(owner.address, owner.publicKey, signature))).resolves.toBe(false);
  });

  it("rejects a tampered message", async () => {
    const { secret, publicKey, address } = keyPair();
    const signature = signArbitrary(secret, address, MESSAGE);
    await expect(cosmos.verify(proof(address, publicKey, signature, `${MESSAGE}!`))).resolves.toBe(false);
  });

  it("rejects a key that does not hash to the address", async () => {
    const owner = keyPair();
    const attacker = keyPair();
    // Valid signature by the attacker over a doc naming the owner, with the attacker's key.
    const signature = signArbitrary(attacker.secret, owner.address, MESSAGE);
    await expect(cosmos.verify(proof(owner.address, attacker.publicKey, signature))).resolves.toBe(false);
  });

  it("rejects a signature over a doc with a different signer", async () => {
    const { secret, publicKey, address } = keyPair();
    const otherPrefix = bech32.encode("osmo", bech32.decode(address as `${string}1${string}`).words);
    const signature = signArbitrary(secret, otherPrefix, MESSAGE);
    await expect(cosmos.verify(proof(address, publicKey, signature))).resolves.toBe(false);
  });

  it("rejects high-s, malformed, and missing fields", async () => {
    const { secret, publicKey, address } = keyPair();
    const doc = new TextEncoder().encode(expectedDoc(address, MESSAGE));
    const sig = secp256k1.Signature.fromBytes(secp256k1.sign(doc, secret), "compact");
    const highS = new secp256k1.Signature(sig.r, secp256k1.Point.CURVE().n - sig.s);
    await expect(cosmos.verify(proof(address, publicKey, b64(highS.toBytes("compact"))))).resolves.toBe(false);
    await expect(cosmos.verify(proof(address, publicKey, "not base64!"))).resolves.toBe(false);
    await expect(cosmos.verify({ ...proof(address, publicKey, b64(sig.toBytes())), publicKey: undefined })).resolves.toBe(
      false,
    );
    await expect(
      cosmos.verify(proof(address, secp256k1.getPublicKey(secret, false), b64(sig.toBytes()))),
    ).resolves.toBe(false);
  });
});
