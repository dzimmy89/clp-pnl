import { secp256k1, schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { decodeKaspaAddress, encodeKaspaAddress, kaspa, kaspaPersonalMessageHash } from "./kaspa";
import type { ChainProof } from "./types";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

const MESSAGE = [
  "127.0.0.1:43127 wants you to sign in with your Kaspa account:",
  "kaspa:q…",
  "",
  "Sign in to Omnifolio. ünïcode ✓",
  "",
  `Nonce: ${"ab".repeat(32)}`,
].join("\n");

function proof(address: string, signature: string, message = MESSAGE): ChainProof {
  return { address, message, signature, domain: "127.0.0.1:43127", nonce: "ab".repeat(32) };
}

describe("Kaspa addresses (rusty-kaspa crypto/addresses vectors)", () => {
  const vectors: [string, number, Uint8Array, string][] = [
    ["kaspa", 0, new Uint8Array(32), "kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e"],
    [
      "kaspa",
      0,
      unhex("5fff3c4da18f45adcdd499e44611e9fff148ba69db3c4ea2ddd955fc46a59522"),
      "kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj",
    ],
    ["kaspatest", 0, new Uint8Array(32), "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya"],
    ["kaspatest", 1, new Uint8Array(33), "kaspatest:qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhe837j2d"],
    [
      "kaspatest",
      1,
      unhex("ba01fc5f4e9d9879599c69a3dafdb835a7255e5f2e934e9322ecd3af190ab0f60e"),
      "kaspatest:qxaqrlzlf6wes72en3568khahq66wf27tuhfxn5nytkd8tcep2c0vrse6gdmpks",
    ],
  ];

  it.each(vectors)("encodes and decodes %s v%i", (prefix, version, payload, text) => {
    expect(encodeKaspaAddress(version, payload, prefix)).toBe(text);
    const decoded = decodeKaspaAddress(text);
    expect(decoded.prefix).toBe(prefix);
    expect(decoded.version).toBe(version);
    expect(hex(decoded.payload)).toBe(hex(payload));
  });

  it("normalizes mainnet key addresses and rejects everything else", () => {
    const addr = "kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj";
    expect(kaspa.normalize(` ${addr.toUpperCase()} `)).toBe(addr);
    expect(() => kaspa.normalize(addr.slice(0, -1) + "q")).toThrow(/checksum/);
    expect(() => kaspa.normalize("kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e")).toThrow();
    expect(() => kaspa.normalize("kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya")).toThrow(/mainnet/);
    expect(() => kaspa.normalize(encodeKaspaAddress(8, new Uint8Array(32)))).toThrow(/Script/);
    expect(() => kaspa.normalize("Kaspa:qp0l70zd5x85ttwd6jv7g3s3a8llzj96d8dncn4zmhv4tlzx5k2jyqh70xmfj")).toThrow(/Mixed/);
  });
});

describe("Kaspa personal message signing (rusty-kaspa wallet/core message.rs vectors)", () => {
  const vectors = [
    {
      message: "Hello Kaspa!",
      key: "0000000000000000000000000000000000000000000000000000000000000003",
      aux: "0000000000000000000000000000000000000000000000000000000000000000",
      pubkey: "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
      sig: "40b9bb2be0ae02607279eda64015a8d86e3763279170340b8243f7ce5344d77aff1191598baf2fd26149cac3b4b12c2c433261c00834db6098cb172aa48ef522",
    },
    {
      message: "Hello Kaspa!",
      key: "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef",
      aux: "0000000000000000000000000000000000000000000000000000000000000001",
      pubkey: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      sig: "eb9e8a3c547eb91b6a7592644f328f0648bdd21aba3cd44787d429d4d790aa8b962745691f3b472ed8d65f3b770ecb4f777bd17b1d309100919b53e0e206b4c6",
    },
    {
      message: "こんにちは世界",
      key: "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef",
      aux: "0000000000000000000000000000000000000000000000000000000000000001",
      pubkey: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      sig: "810653d5f80206db519672362add6c98dad378844e5ba4d89a22c9f0c7092e8cecba734fff7922b656b4be3f4b1f098899c95cb5c1023dce3519208afafb59bc",
    },
  ];

  it.each(vectors)("reproduces and verifies the official signature for $message", async (v) => {
    const hash = kaspaPersonalMessageHash(v.message);
    expect(hex(schnorr.sign(hash, unhex(v.key), unhex(v.aux)))).toBe(v.sig);
    expect(hex(schnorr.getPublicKey(unhex(v.key)))).toBe(v.pubkey);
    const address = encodeKaspaAddress(0, unhex(v.pubkey));
    await expect(kaspa.verify(proof(address, v.sig, v.message))).resolves.toBe(true);
    await expect(kaspa.verify(proof(address, v.sig, `${v.message}.`))).resolves.toBe(false);
  });
});

describe("Kaspa sign-in", () => {
  function schnorrAccount() {
    const secret = schnorr.utils.randomSecretKey();
    return { secret, address: encodeKaspaAddress(0, schnorr.getPublicKey(secret)) };
  }

  it("accepts a Schnorr signature from the address key (hex, as KasWare returns it)", async () => {
    const { secret, address } = schnorrAccount();
    const sig = hex(schnorr.sign(kaspaPersonalMessageHash(MESSAGE), secret));
    await expect(kaspa.verify(proof(address, sig))).resolves.toBe(true);
    await expect(kaspa.verify(proof(address.toUpperCase(), sig.toUpperCase()))).resolves.toBe(true);
    await expect(kaspa.verify(proof(address, Buffer.from(sig, "hex").toString("base64")))).resolves.toBe(true);
  });

  it("rejects a signature from another key", async () => {
    const owner = schnorrAccount();
    const other = schnorrAccount();
    const sig = hex(schnorr.sign(kaspaPersonalMessageHash(MESSAGE), other.secret));
    await expect(kaspa.verify(proof(owner.address, sig))).resolves.toBe(false);
  });

  it("rejects a tampered message or signature", async () => {
    const { secret, address } = schnorrAccount();
    const sig = schnorr.sign(kaspaPersonalMessageHash(MESSAGE), secret);
    await expect(kaspa.verify(proof(address, hex(sig), MESSAGE.replace("ab", "ac")))).resolves.toBe(false);
    const bad = sig.slice();
    bad[10] ^= 1;
    await expect(kaspa.verify(proof(address, hex(bad)))).resolves.toBe(false);
    // Signing the raw text instead of the keyed blake2b hash is not accepted.
    const raw = hex(schnorr.sign(new TextEncoder().encode(MESSAGE), secret));
    await expect(kaspa.verify(proof(address, raw))).resolves.toBe(false);
  });

  it("rejects a script-hash address and garbage input", async () => {
    const { secret } = schnorrAccount();
    const sig = hex(schnorr.sign(kaspaPersonalMessageHash(MESSAGE), secret));
    await expect(kaspa.verify(proof(encodeKaspaAddress(8, schnorr.getPublicKey(secret)), sig))).resolves.toBe(false);
    await expect(kaspa.verify(proof("kaspa:nope", sig))).resolves.toBe(false);
    await expect(kaspa.verify(proof(schnorrAccount().address, "not a signature!"))).resolves.toBe(false);
  });

  it("accepts an ECDSA signature for a PubKeyECDSA address", async () => {
    const secret = secp256k1.utils.randomSecretKey();
    const address = encodeKaspaAddress(1, secp256k1.getPublicKey(secret, true));
    const hash = kaspaPersonalMessageHash(MESSAGE);
    const direct = secp256k1.sign(hash, secret, { prehash: false });
    const hashed = secp256k1.sign(sha256(hash), secret, { prehash: false, format: "der" });
    await expect(kaspa.verify(proof(address, hex(direct)))).resolves.toBe(true);
    await expect(kaspa.verify(proof(address, hex(hashed)))).resolves.toBe(true);
    const otherSecret = secp256k1.utils.randomSecretKey();
    const wrong = secp256k1.sign(hash, otherSecret, { prehash: false });
    await expect(kaspa.verify(proof(address, hex(wrong)))).resolves.toBe(false);
    // A Schnorr signature does not satisfy an ECDSA address.
    const schnorrSig = schnorr.sign(hash, secret);
    await expect(kaspa.verify(proof(address, hex(schnorrSig)))).resolves.toBe(false);
  });
});
