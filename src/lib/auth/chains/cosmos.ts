import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32 } from "@scure/base";
import type { ChainProof, ChainVerifier } from "./types";

/**
 * Cosmos sign-in (Keplr, Leap) with ADR-036 `signArbitrary`.
 *
 * The wallet signs sha256 of an amino-JSON sign doc wrapping one `sign/MsgSignData` message whose
 * `data` is base64(utf8(text)) and whose `signer` is the bech32 address. The sign doc is
 * serialized with sorted keys, no whitespace, and `&`, `<`, `>` escaped as \u0026, \u003c,
 * \u003e (cosmjs `serializeSignDoc`). The signature is a 64-byte compact r||s, base64, low-s.
 *
 * The proof carries `publicKey` (base64 33-byte compressed secp256k1 key) and `signature`
 * (base64). The key is bound to the address by bech32(prefix, ripemd160(sha256(key))).
 * Any bech32 prefix is accepted (cosmos, osmo, …); ethermint-style chains that use
 * eth_secp256k1 keys (Evmos, Injective) are not supported.
 */

/** Rebuilds the exact bytes Keplr/Leap sign for `signArbitrary(chainId, signer, data)`. */
export function adr36SignBytes(signer: string, message: string): Uint8Array {
  const doc = {
    account_number: "0",
    chain_id: "",
    fee: { amount: [], gas: "0" },
    memo: "",
    msgs: [
      {
        type: "sign/MsgSignData",
        value: { data: Buffer.from(message, "utf8").toString("base64"), signer },
      },
    ],
    sequence: "0",
  };
  return new TextEncoder().encode(escapeCharacters(sortedJson(doc)));
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${sortedJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function escapeCharacters(input: string): string {
  return input.replace(/&/g, "\\u0026").replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/** bech32 address for a compressed secp256k1 key under `prefix`. */
export function cosmosAddressFromPublicKey(prefix: string, publicKey: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(ripemd160(sha256(publicKey))));
}

function decode(address: string): { prefix: string; bytes: Uint8Array } {
  const lower = address.trim().toLowerCase();
  const { prefix, words } = bech32.decode(lower as `${string}1${string}`);
  const bytes = bech32.fromWords(words);
  if (bytes.length !== 20) throw new Error("Not a Cosmos account address");
  return { prefix, bytes };
}

function normalize(address: string): string {
  const { prefix, bytes } = decode(address);
  return bech32.encode(prefix, bech32.toWords(bytes));
}

function fromBase64(value: string | undefined): Uint8Array | null {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim())) return null;
  return Uint8Array.from(Buffer.from(value.trim(), "base64"));
}

export const cosmos: ChainVerifier = {
  normalize,
  async verify(proof: ChainProof): Promise<boolean> {
    try {
      const address = normalize(proof.address);
      const { prefix } = decode(address);
      const publicKey = fromBase64(proof.publicKey);
      const signature = fromBase64(proof.signature);
      if (!publicKey || publicKey.length !== 33 || !signature || signature.length !== 64) return false;
      if (cosmosAddressFromPublicKey(prefix, publicKey) !== address) return false;
      // prehash: sha256(signDoc); lowS: Cosmos SDK rejects high-s signatures too.
      return secp256k1.verify(signature, adr36SignBytes(address, proof.message), publicKey, {
        prehash: true,
        lowS: true,
        format: "compact",
      });
    } catch {
      return false;
    }
  },
};
