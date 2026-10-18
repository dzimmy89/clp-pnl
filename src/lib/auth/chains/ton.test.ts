import { ed25519 } from "@noble/curves/ed25519.js";
import { Address, beginCell, Cell, contractAddress, storeStateInit, type StateInit } from "@ton/core";
import { describe, expect, it, vi } from "vitest";
import { ton, tonProofHash, type TonProofEnvelope } from "./ton";
import type { ChainProof } from "./types";

// Wallet v4r2 code, as shipped in @ton/ton (WalletContractV4).
const V4R2_CODE = Cell.fromBase64(
  "te6ccgECFAEAAtQAART/APSkE/S88sgLAQIBIAIDAgFIBAUE+PKDCNcYINMf0x/THwL4I7vyZO1E0NMf0x/T//QE0VFDuvKhUVG68qIF+QFUEGT5EPKj+AAkpMjLH1JAyx9SMMv/UhD0AMntVPgPAdMHIcAAn2xRkyDXSpbTB9QC+wDoMOAhwAHjACHAAuMAAcADkTDjDQOkyMsfEssfy/8QERITAubQAdDTAyFxsJJfBOAi10nBIJJfBOAC0x8hghBwbHVnvSKCEGRzdHK9sJJfBeAD+kAwIPpEAcjKB8v/ydDtRNCBAUDXIfQEMFyBAQj0Cm+hMbOSXwfgBdM/yCWCEHBsdWe6kjgw4w0DghBkc3RyupJfBuMNBgcCASAICQB4AfoA9AQw+CdvIjBQCqEhvvLgUIIQcGx1Z4MesXCAGFAEywUmzxZY+gIZ9ADLaRfLH1Jgyz8gyYBA+wAGAIpQBIEBCPRZMO1E0IEBQNcgyAHPFvQAye1UAXKwjiOCEGRzdHKDHrFwgBhQBcsFUAPPFiP6AhPLassfyz/JgED7AJJfA+ICASAKCwBZvSQrb2omhAgKBrkPoCGEcNQICEekk30pkQzmkD6f+YN4EoAbeBAUiYcVnzGEAgFYDA0AEbjJftRNDXCx+AA9sp37UTQgQFA1yH0BDACyMoHy//J0AGBAQj0Cm+hMYAIBIA4PABmtznaiaEAga5Drhf/AABmvHfaiaEAQa5DrhY/AAG7SB/oA1NQi+QAFyMoHFcv/ydB3dIAYyMsFywIizxZQBfoCFMtrEszMyXP7AMhAFIEBCPRR8qcCAHCBAQjXGPoA0z/IVCBHgQEI9FHyp4IQbm90ZXB0gBjIywXLAlAGzxZQBPoCFMtqEssfyz/Jc/sAAgBsgQEI1xj6ANM/MFIkgQEI9Fnyp4IQZHN0cnB0gBjIywXLAlAFzxZQA/oCE8tqyx8Syz/Jc/sAAAr0AMntVA==",
);

const DOMAIN = "omnifolio.example";
const NONCE = "ab".repeat(32);
const NOW = Date.parse("2026-10-09T20:00:00Z");
const TIMESTAMP = Math.floor(NOW / 1000) - 60;

function makeWallet() {
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secret);
  const data = beginCell()
    .storeUint(0, 32) // seqno
    .storeUint(698983191, 32) // subwallet id
    .storeBuffer(Buffer.from(publicKey))
    .storeBit(0) // empty plugins dict
    .endCell();
  const init: StateInit = { code: V4R2_CODE, data };
  const address = contractAddress(0, init);
  const stateInit = beginCell().store(storeStateInit(init)).endCell().toBoc().toString("base64");
  return { secret, publicKey, address, stateInit };
}

type Wallet = ReturnType<typeof makeWallet>;

/** Signs a ton_proof the way a TON Connect wallet does. */
function signProof(wallet: Wallet, overrides: Partial<TonProofEnvelope> = {}, signer = wallet.secret) {
  const envelope: TonProofEnvelope = {
    timestamp: TIMESTAMP,
    domain: { lengthBytes: new TextEncoder().encode(DOMAIN).length, value: DOMAIN },
    payload: NONCE,
    ...overrides,
  };
  const signature = Buffer.from(ed25519.sign(tonProofHash(wallet.address, envelope), signer)).toString("base64");
  return { signature, signedMessage: JSON.stringify(envelope) };
}

function proofFor(wallet: Wallet, signed: { signature: string; signedMessage: string }, withStateInit = true): ChainProof {
  return {
    address: wallet.address.toRawString(),
    message: "ignored for TON",
    signature: signed.signature,
    signedMessage: signed.signedMessage,
    publicKey: Buffer.from(wallet.publicKey).toString("hex"),
    extra: withStateInit ? { stateInit: wallet.stateInit } : undefined,
    domain: DOMAIN,
    nonce: NONCE,
  };
}

function noFetch(): typeof fetch {
  return vi.fn(async () => {
    throw new Error("no network in tests");
  }) as unknown as typeof fetch;
}

function getterFetch(publicKey: Uint8Array, exitCode = 0) {
  return vi.fn<typeof fetch>(async () =>
    Response.json({
      ok: true,
      result: { exit_code: exitCode, stack: [["num", `0x${Buffer.from(publicKey).toString("hex")}`]] },
    }),
  );
}

describe("ton.normalize", () => {
  it("returns the lowercase raw form for raw and user-friendly input", () => {
    const raw = `0:${"AB".repeat(32)}`;
    const friendly = Address.parse(raw).toString({ bounceable: false });
    expect(ton.normalize(raw)).toBe(`0:${"ab".repeat(32)}`);
    expect(ton.normalize(friendly)).toBe(`0:${"ab".repeat(32)}`);
  });

  it("throws on garbage", () => {
    expect(() => ton.normalize("not an address")).toThrow();
  });
});

describe("ton.verify with a StateInit", () => {
  it("accepts a proof signed by the key in the wallet's StateInit", async () => {
    const wallet = makeWallet();
    const fetch = noFetch();
    await expect(ton.verify(proofFor(wallet, signProof(wallet)), { fetch, now: NOW })).resolves.toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the user-friendly address form", async () => {
    const wallet = makeWallet();
    const proof = { ...proofFor(wallet, signProof(wallet)), address: wallet.address.toString() };
    await expect(ton.verify(proof, { fetch: noFetch(), now: NOW })).resolves.toBe(true);
  });

  it("rejects a proof whose payload is not the server nonce", async () => {
    const wallet = makeWallet();
    const proof = proofFor(wallet, signProof(wallet, { payload: "cd".repeat(32) }));
    await expect(ton.verify(proof, { fetch: noFetch(), now: NOW })).resolves.toBe(false);
  });

  it("rejects a proof bound to another domain", async () => {
    const wallet = makeWallet();
    const evil = "evil.example";
    const proof = proofFor(wallet, signProof(wallet, { domain: { lengthBytes: evil.length, value: evil } }));
    await expect(ton.verify(proof, { fetch: noFetch(), now: NOW })).resolves.toBe(false);
  });

  it("rejects a stale or far-future timestamp", async () => {
    const wallet = makeWallet();
    const stale = proofFor(wallet, signProof(wallet, { timestamp: TIMESTAMP - 20 * 60 }));
    const future = proofFor(wallet, signProof(wallet, { timestamp: TIMESTAMP + 20 * 60 }));
    await expect(ton.verify(stale, { fetch: noFetch(), now: NOW })).resolves.toBe(false);
    await expect(ton.verify(future, { fetch: noFetch(), now: NOW })).resolves.toBe(false);
  });

  it("rejects a signature from a key other than the wallet's", async () => {
    const wallet = makeWallet();
    const other = ed25519.utils.randomSecretKey();
    const proof = proofFor(wallet, signProof(wallet, {}, other));
    // The client-supplied publicKey hint must not be trusted either.
    proof.publicKey = Buffer.from(ed25519.getPublicKey(other)).toString("hex");
    await expect(ton.verify(proof, { fetch: noFetch(), now: NOW })).resolves.toBe(false);
  });

  it("rejects a StateInit that does not hash to the address", async () => {
    const wallet = makeWallet();
    const attacker = makeWallet();
    // Attacker signs for the victim address but supplies their own StateInit.
    const proof = { ...proofFor(wallet, signProof(wallet, {}, attacker.secret)), extra: { stateInit: attacker.stateInit } };
    await expect(ton.verify(proof, { fetch: noFetch(), now: NOW })).resolves.toBe(false);
  });

  it("rejects a tampered envelope", async () => {
    const wallet = makeWallet();
    const signed = signProof(wallet);
    const envelope = JSON.parse(signed.signedMessage) as TonProofEnvelope;
    const tampered = JSON.stringify({ ...envelope, timestamp: envelope.timestamp + 1 });
    await expect(
      ton.verify(proofFor(wallet, { ...signed, signedMessage: tampered }), { fetch: noFetch(), now: NOW }),
    ).resolves.toBe(false);
  });
});

describe("ton.verify via the get_public_key getter", () => {
  it("accepts when the deployed wallet reports the signing key", async () => {
    const wallet = makeWallet();
    const fetch = getterFetch(wallet.publicKey);
    const proof = proofFor(wallet, signProof(wallet), false);
    await expect(ton.verify(proof, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW })).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://toncenter.com/api/v2/runGetMethod");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      address: wallet.address.toRawString(),
      method: "get_public_key",
      stack: [],
    });
  });

  it("rejects when the on-chain key differs", async () => {
    const wallet = makeWallet();
    const fetch = getterFetch(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
    const proof = proofFor(wallet, signProof(wallet), false);
    await expect(ton.verify(proof, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW })).resolves.toBe(false);
  });

  it("rejects when the getter fails (undeployed wallet, no StateInit)", async () => {
    const wallet = makeWallet();
    const fetch = getterFetch(wallet.publicKey, -13);
    const proof = proofFor(wallet, signProof(wallet), false);
    await expect(ton.verify(proof, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW })).resolves.toBe(false);
    await expect(ton.verify(proof, { fetch: noFetch(), now: NOW })).resolves.toBe(false);
  });

  it("falls back to the getter when the StateInit is not a known wallet", async () => {
    const secret = ed25519.utils.randomSecretKey();
    const publicKey = ed25519.getPublicKey(secret);
    const init: StateInit = {
      code: beginCell().storeUint(0xdeadbeef, 32).endCell(),
      data: beginCell().storeBuffer(Buffer.from(publicKey)).endCell(),
    };
    const address = contractAddress(0, init);
    const wallet: Wallet = {
      secret,
      publicKey,
      address,
      stateInit: beginCell().store(storeStateInit(init)).endCell().toBoc().toString("base64"),
    };
    const fetch = getterFetch(publicKey);
    const proof = proofFor(wallet, signProof(wallet));
    await expect(ton.verify(proof, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW })).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
