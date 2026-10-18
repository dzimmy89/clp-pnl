import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildSignInMessage, nonceBytes, type SignInFields } from "./message";
import { nep413Hash, SignInError, verifySignIn } from "./verify";

const DOMAIN = "127.0.0.1:43127";
const URI = "http://127.0.0.1:43127";
const NONCE = "ab".repeat(32);
const NOW = Date.parse("2026-10-09T20:00:00Z");
const ISSUED = "2026-10-09T19:58:00.000Z";

function fields(chain: SignInFields["chain"], address: string): SignInFields {
  return { chain, address, domain: DOMAIN, uri: URI, nonce: NONCE, issuedAt: ISSUED, chainId: 1 };
}

const base = { domain: DOMAIN, uri: URI, now: NOW, evmContractCheck: async () => false };

describe("EVM sign-in", () => {
  it("accepts a SIWE message signed by the address", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const f = fields("evm", account.address.toLowerCase());
    const signature = await account.signMessage({ message: buildSignInMessage(f) });
    await expect(verifySignIn({ ...f, signature }, base)).resolves.toBe(account.address);
  });

  it("rejects a signature from another key", async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const other = privateKeyToAccount(generatePrivateKey());
    const f = fields("evm", owner.address);
    const signature = await other.signMessage({ message: buildSignInMessage(f) });
    await expect(verifySignIn({ ...f, signature }, base)).rejects.toThrow(SignInError);
  });

  it("rejects a message built for another domain", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const f = fields("evm", account.address);
    const signature = await account.signMessage({
      message: buildSignInMessage({ ...f, domain: "evil.example", uri: "https://evil.example" }),
    });
    await expect(verifySignIn({ ...f, signature }, base)).rejects.toThrow(SignInError);
  });

  it("rejects a stale message", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const f = { ...fields("evm", account.address), issuedAt: "2026-10-09T19:00:00.000Z" };
    const signature = await account.signMessage({ message: buildSignInMessage(f) });
    await expect(verifySignIn({ ...f, signature }, base)).rejects.toThrow(/expired/);
  });
});

describe("Solana sign-in", () => {
  it("accepts an ed25519 signature from the address key", async () => {
    const secret = ed25519.utils.randomSecretKey();
    const address = bs58.encode(ed25519.getPublicKey(secret));
    const f = fields("solana", address);
    const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(buildSignInMessage(f)), secret));
    await expect(verifySignIn({ ...f, signature }, base)).resolves.toBe(address);
  });

  it("rejects a signature for a different message", async () => {
    const secret = ed25519.utils.randomSecretKey();
    const address = bs58.encode(ed25519.getPublicKey(secret));
    const f = fields("solana", address);
    const signature = bs58.encode(ed25519.sign(new TextEncoder().encode("something else"), secret));
    await expect(verifySignIn({ ...f, signature }, base)).rejects.toThrow(SignInError);
  });
});

describe("NEAR sign-in (NEP-413)", () => {
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = `ed25519:${bs58.encode(ed25519.getPublicKey(secret))}`;

  function signNear(accountId: string) {
    const f = fields("near", accountId);
    const hash = nep413Hash(buildSignInMessage(f), nonceBytes(NONCE), DOMAIN);
    const signature = Buffer.from(ed25519.sign(hash, secret)).toString("base64");
    return { ...f, signature, publicKey };
  }

  it("accepts a signature from a full-access key of the account", async () => {
    const proof = signNear("Alice.near");
    const checked: string[] = [];
    const address = await verifySignIn(proof, {
      ...base,
      nearKeyCheck: async (account, key) => {
        checked.push(account, key);
        return true;
      },
    });
    expect(address).toBe("alice.near");
    expect(checked).toEqual(["alice.near", publicKey]);
  });

  it("rejects a key the account does not own", async () => {
    await expect(
      verifySignIn(signNear("alice.near"), { ...base, nearKeyCheck: async () => false }),
    ).rejects.toThrow(SignInError);
  });
});

describe("plugin-chain sign-in through verifySignIn", () => {
  it("accepts a Cosmos ADR-036 signature over the server-built message and returns the canonical address", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    const { sha256 } = await import("@noble/hashes/sha2.js");
    const { ripemd160 } = await import("@noble/hashes/legacy.js");
    const { bech32 } = await import("@scure/base");
    const { adr36SignBytes } = await import("./chains/cosmos");
    const secret = secp256k1.utils.randomSecretKey();
    const publicKey = secp256k1.getPublicKey(secret, true);
    const address = bech32.encode("cosmos", bech32.toWords(ripemd160(sha256(publicKey))));
    const f = { ...fields("cosmos", address), chainId: undefined };
    const message = buildSignInMessage(f);
    const signature = secp256k1.sign(sha256(adr36SignBytes(address, message)), secret, { prehash: false });
    const proof = {
      ...f,
      signature: Buffer.from(signature).toString("base64"),
      publicKey: Buffer.from(publicKey).toString("base64"),
    };
    await expect(verifySignIn(proof, base)).resolves.toBe(address);
    await expect(verifySignIn(proof, { ...base, domain: "evil.example", uri: "https://evil.example" })).rejects.toThrow(SignInError);
  });
});
