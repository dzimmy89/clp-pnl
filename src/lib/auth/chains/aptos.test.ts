import { ed25519 } from "@noble/curves/ed25519.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import { aptos, aptosAuthKey, APTOS_ACCOUNT_API } from "./aptos";
import type { ChainProof } from "./types";

const DOMAIN = "127.0.0.1:43127";
const ORIGIN = `http://${DOMAIN}`;
const NONCE = "ef".repeat(32);
const text = (address: string) =>
  `${DOMAIN} wants you to sign in with your Aptos account:\n${address}\n\nURI: ${ORIGIN}\nNonce: ${NONCE}`;

function keypair() {
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secret);
  return { secret, publicKey, address: aptosAuthKey(publicKey) };
}

/** Petra-style envelope with `address: true, application: true` (nonce before message). */
function envelope(address: string, message: string, opts: { application?: string; nonceLast?: boolean } = {}) {
  const lines = ["APTOS", `address: ${address}`, `application: ${opts.application ?? ORIGIN}`];
  const tail = opts.nonceLast ? [`message: ${message}`, `nonce: ${NONCE}`] : [`nonce: ${NONCE}`, `message: ${message}`];
  return [...lines, ...tail].join("\n");
}

function signed(key: ReturnType<typeof keypair>, address: string, fullMessage: string, message = text(address)): ChainProof {
  const signature = `0x${bytesToHex(ed25519.sign(new TextEncoder().encode(fullMessage), key.secret))}`;
  return {
    address,
    message,
    signature,
    publicKey: `0x${bytesToHex(key.publicKey)}`,
    signedMessage: fullMessage,
    domain: DOMAIN,
    nonce: NONCE,
  };
}

const noFetch = vi.fn(async () => {
  throw new Error("should not fetch");
}) as unknown as typeof fetch;

describe("Aptos sign-in", () => {
  it("accepts a signMessage envelope from the account's original key without a network call", async () => {
    const key = keypair();
    const proof = signed(key, key.address, envelope(key.address, text(key.address)));
    await expect(aptos.verify(proof, { fetch: noFetch })).resolves.toBe(true);
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("accepts the nonce-last ordering and a bare envelope", async () => {
    const key = keypair();
    const msg = text(key.address);
    const nonceLast = signed(key, key.address, envelope(key.address, msg, { nonceLast: true }));
    const bare = signed(key, key.address, `APTOS\nnonce: ${NONCE}\nmessage: ${msg}`);
    await expect(aptos.verify(nonceLast, { fetch: noFetch })).resolves.toBe(true);
    await expect(aptos.verify(bare, { fetch: noFetch })).resolves.toBe(true);
  });

  it("rejects a signature from another key", async () => {
    const key = keypair();
    const other = keypair();
    const proof = signed(other, key.address, envelope(key.address, text(key.address)));
    // Signature verifies against `other`'s key, which is not bound to the address.
    const fakeFetch = vi.fn(async () => Response.json({ authentication_key: key.address })) as unknown as typeof fetch;
    await expect(aptos.verify(proof, { fetch: fakeFetch })).resolves.toBe(false);
    // And a claimed publicKey that did not produce the signature fails outright.
    await expect(aptos.verify({ ...proof, publicKey: `0x${bytesToHex(key.publicKey)}` }, { fetch: noFetch })).resolves.toBe(false);
  });

  it("rejects an envelope around another text", async () => {
    const key = keypair();
    const proof = signed(key, key.address, envelope(key.address, text(key.address).replace(DOMAIN, "evil.example")));
    await expect(aptos.verify(proof, { fetch: noFetch })).resolves.toBe(false);
  });

  it("rejects a wrong nonce or extra text after the message", async () => {
    const key = keypair();
    const msg = text(key.address);
    const wrongNonce = signed(key, key.address, envelope(key.address, msg).replace(`nonce: ${NONCE}`, `nonce: ${"00".repeat(32)}`));
    const trailing = signed(key, key.address, `${envelope(key.address, msg)}\nextra`);
    await expect(aptos.verify(wrongNonce, { fetch: noFetch })).resolves.toBe(false);
    await expect(aptos.verify(trailing, { fetch: noFetch })).resolves.toBe(false);
  });

  it("rejects an envelope for another application or address", async () => {
    const key = keypair();
    const msg = text(key.address);
    const app = signed(key, key.address, envelope(key.address, msg, { application: "https://evil.example" }));
    const addr = signed(key, key.address, envelope(`0x${"1".repeat(64)}`, msg));
    await expect(aptos.verify(app, { fetch: noFetch })).resolves.toBe(false);
    await expect(aptos.verify(addr, { fetch: noFetch })).resolves.toBe(false);
  });

  it("rejects when the key does not own the claimed address", async () => {
    const key = keypair();
    const victim = `0x${"2".repeat(64)}`;
    const proof = signed(key, victim, envelope(victim, text(victim)));
    const fakeFetch = vi.fn(async () => Response.json({ authentication_key: victim })) as unknown as typeof fetch;
    await expect(aptos.verify(proof, { fetch: fakeFetch })).resolves.toBe(false);
  });

  it("accepts a rotated key when the on-chain authentication key matches", async () => {
    const key = keypair();
    const account = `0x${"3".repeat(64)}`;
    const proof = signed(key, account, envelope(account, text(account)));
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe(`${APTOS_ACCOUNT_API}/${account}`);
      return Response.json({ sequence_number: "7", authentication_key: key.address });
    }) as unknown as typeof fetch;
    await expect(aptos.verify(proof, { fetch: fakeFetch })).resolves.toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a rotated key when the account lookup fails", async () => {
    const key = keypair();
    const account = `0x${"4".repeat(64)}`;
    const proof = signed(key, account, envelope(account, text(account)));
    const notFound = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(aptos.verify(proof, { fetch: notFound })).resolves.toBe(false);
  });

  it("rejects missing or malformed key material", async () => {
    const key = keypair();
    const proof = signed(key, key.address, envelope(key.address, text(key.address)));
    await expect(aptos.verify({ ...proof, publicKey: undefined }, { fetch: noFetch })).resolves.toBe(false);
    await expect(aptos.verify({ ...proof, publicKey: `${proof.publicKey}00` }, { fetch: noFetch })).resolves.toBe(false);
    await expect(aptos.verify({ ...proof, signedMessage: undefined }, { fetch: noFetch })).resolves.toBe(false);
  });
});

describe("Aptos normalize", () => {
  it("lowercases and left-pads", () => {
    expect(aptos.normalize("0x1")).toBe(`0x${"0".repeat(63)}1`);
    expect(aptos.normalize(`0x${"AB".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`);
  });

  it("throws on invalid input", () => {
    expect(() => aptos.normalize("0x")).toThrow();
    expect(() => aptos.normalize(`0x${"a".repeat(65)}`)).toThrow();
    expect(() => aptos.normalize("hello")).toThrow();
  });
});
