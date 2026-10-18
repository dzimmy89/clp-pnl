import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bech32 } from "@scure/base";
import { Encoder } from "cbor-x";
import { describe, expect, it } from "vitest";
import { cardano, cardanoAddressToBech32, coseSign1SigStructure } from "./cardano";
import type { ChainProof } from "./types";

const MESSAGE = [
  "127.0.0.1:43127 wants you to sign in with your Cardano account:",
  "addr1…",
  "",
  "Sign in to Omnifolio. ünïcode ✓",
  "",
  `Nonce: ${"ab".repeat(32)}`,
].join("\n");

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const encoder = new Encoder({ useRecords: false, tagUint8Array: false, mapsAsObjects: false });
const cbor = (value: unknown) => Uint8Array.from(encoder.encode(value));

function account(header = 0x61, stakeHash?: Uint8Array) {
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secret);
  const keyHash = blake2b(publicKey, { dkLen: 28 });
  const addressBytes = Uint8Array.from([header, ...keyHash, ...(stakeHash ?? [])]);
  return { secret, publicKey, addressBytes, address: cardanoAddressToBech32(addressBytes) };
}

/** Builds { signature, key } exactly like a CIP-30 wallet's api.signData(addressHex, payloadHex). */
function signData(
  secret: Uint8Array,
  addressBytes: Uint8Array,
  message: string,
  { hashed = false, protectedAddress = addressBytes } = {},
) {
  const publicKey = ed25519.getPublicKey(secret);
  const protectedBytes = cbor(new Map<number | string, unknown>([[1, -8], ["address", protectedAddress]]));
  const text = new TextEncoder().encode(message);
  const payload = hashed ? blake2b(text, { dkLen: 28 }) : text;
  // Independent encoding of the Sig_structure through cbor-x, not the verifier's helper.
  const toSign = cbor(["Signature1", protectedBytes, new Uint8Array(0), payload]);
  const signature = ed25519.sign(toSign, secret);
  const sign1 = cbor([protectedBytes, new Map([["hashed", hashed]]), payload, signature]);
  const key = cbor(new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, publicKey]]));
  return { signature: hex(sign1), key: hex(key) };
}

function proof(address: string, signed: { signature: string; key: string }, message = MESSAGE): ChainProof {
  return {
    address,
    message,
    signature: signed.signature,
    publicKey: signed.key,
    domain: "127.0.0.1:43127",
    nonce: "ab".repeat(32),
  };
}

describe("Cardano addresses", () => {
  it("normalizes mainnet addr/stake and rejects testnet or garbage", () => {
    const { address } = account();
    expect(address.startsWith("addr1")).toBe(true);
    expect(cardano.normalize(` ${address.toUpperCase()} `)).toBe(address);
    const stake = "stake1uyvfslqkzgrf6syq5r4jg7pqewv8l65phh024lw5r7vk9qgznhyty";
    expect(cardano.normalize(stake)).toBe(stake);
    expect(() => cardano.normalize(account(0x60).address)).toThrow(/mainnet/);
    expect(() => cardano.normalize("addr1qqqq")).toThrow();
    const mislabeled = bech32.encode("stake", bech32.toWords(account().addressBytes), 1023);
    expect(() => cardano.normalize(mislabeled)).toThrow(/prefix/);
  });

  it("encodes the Sig_structure as canonical CBOR", () => {
    const protectedBytes = cbor(new Map<number | string, unknown>([[1, -8], ["address", new Uint8Array(29)]]));
    const payload = new TextEncoder().encode(MESSAGE);
    expect(hex(coseSign1SigStructure(protectedBytes, payload))).toBe(
      hex(cbor(["Signature1", protectedBytes, new Uint8Array(0), payload])),
    );
  });
});

describe("Cardano sign-in (CIP-30 signData)", () => {
  it("verifies the cardano-verify-datasignature README vector (real wallet, stake address)", async () => {
    const vector: ChainProof = {
      address: "stake1uyvfslqkzgrf6syq5r4jg7pqewv8l65phh024lw5r7vk9qgznhyty",
      message: "Augusta Ada King, Countess of Lovelace",
      publicKey: "a4010103272006215820b89526fd6bf4ba737c55ea90670d16a27f8de6cc1982349b3b676705a2f420c6",
      signature:
        "84582aa201276761646472657373581de118987c1612069d4080a0eb247820cb987fea81bddeaafdd41f996281a166686173686564f458264175677573746120416461204b696e672c20436f756e74657373206f66204c6f76656c61636558401712458b19f606b322982f6290c78529a235b56c0f1cec4f24b12a8660b40cd37f4c5440a465754089c462ed4b0d613bffaee3d1833516569fda4852f42a4a0f",
      domain: "example.com",
      nonce: "ab".repeat(32),
    };
    await expect(cardano.verify(vector)).resolves.toBe(true);
    await expect(cardano.verify({ ...vector, message: `${vector.message}!` })).resolves.toBe(false);
  });

  it("accepts a signature from an enterprise address key", async () => {
    const { secret, address, addressBytes } = account();
    await expect(cardano.verify(proof(address, signData(secret, addressBytes, MESSAGE)))).resolves.toBe(true);
  });

  it("accepts a base address (payment key + stake key) and a hashed payload", async () => {
    const { secret, address, addressBytes } = account(0x01, new Uint8Array(28).fill(7));
    expect(addressBytes.length).toBe(57);
    await expect(cardano.verify(proof(address, signData(secret, addressBytes, MESSAGE)))).resolves.toBe(true);
    await expect(cardano.verify(proof(address, signData(secret, addressBytes, MESSAGE, { hashed: true })))).resolves.toBe(
      true,
    );
  });

  it("accepts a tag-18 COSE_Sign1 and a bare hex public key", async () => {
    const { secret, address, addressBytes, publicKey } = account();
    const signed = signData(secret, addressBytes, MESSAGE);
    const tagged = `d2${signed.signature}`;
    await expect(cardano.verify(proof(address, { signature: tagged, key: hex(publicKey) }))).resolves.toBe(true);
  });

  it("rejects a signature from another key", async () => {
    const owner = account();
    const other = account();
    // The other key signs over the owner's address and presents its own COSE_Key.
    const signed = signData(other.secret, owner.addressBytes, MESSAGE);
    await expect(cardano.verify(proof(owner.address, signed))).resolves.toBe(false);
    // Or presents the owner's key with its own signature.
    const ownerKey = signData(owner.secret, owner.addressBytes, MESSAGE).key;
    await expect(cardano.verify(proof(owner.address, { ...signed, key: ownerKey }))).resolves.toBe(false);
  });

  it("rejects a tampered payload or another message", async () => {
    const { secret, address, addressBytes } = account();
    const signed = signData(secret, addressBytes, MESSAGE);
    await expect(cardano.verify(proof(address, signed, MESSAGE.replace("ab", "ac")))).resolves.toBe(false);
    const original = hex(new TextEncoder().encode("Sign in to Omnifolio."));
    const swapped = hex(new TextEncoder().encode("Sign in to Omnifoliø."));
    const tampered = signed.signature.replace(original, swapped);
    expect(tampered).not.toBe(signed.signature);
    await expect(cardano.verify(proof(address, { ...signed, signature: tampered }, MESSAGE))).resolves.toBe(false);
  });

  it("rejects when the address header does not match the claimed address", async () => {
    const { secret, address, addressBytes } = account();
    const otherBase = account(0x01, new Uint8Array(28).fill(1)).addressBytes;
    // Same payment key, different (base) address in the header.
    const sameKeyBase = Uint8Array.from([0x01, ...addressBytes.slice(1), ...otherBase.slice(29)]);
    const signed = signData(secret, addressBytes, MESSAGE, { protectedAddress: sameKeyBase });
    await expect(cardano.verify(proof(address, signed))).resolves.toBe(false);
    await expect(cardano.verify(proof(cardanoAddressToBech32(sameKeyBase), signed))).resolves.toBe(true);
  });

  it("rejects script addresses", async () => {
    const { secret, publicKey } = account();
    const scriptAddress = Uint8Array.from([0x71, ...blake2b(publicKey, { dkLen: 28 })]);
    const signed = signData(secret, scriptAddress, MESSAGE);
    await expect(cardano.verify(proof(cardanoAddressToBech32(scriptAddress), signed))).resolves.toBe(false);
  });

  it("rejects missing or malformed fields", async () => {
    const { secret, address, addressBytes } = account();
    const signed = signData(secret, addressBytes, MESSAGE);
    await expect(cardano.verify({ ...proof(address, signed), publicKey: undefined })).resolves.toBe(false);
    await expect(cardano.verify(proof(address, { ...signed, signature: "zz" }))).resolves.toBe(false);
    await expect(cardano.verify(proof(address, { ...signed, signature: "80" }))).resolves.toBe(false);
  });
});
