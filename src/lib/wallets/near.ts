"use client";

import type { NearConnector } from "@hot-labs/near-connect";
import { nonceBytes } from "@/lib/auth/message";

let connector: Promise<NearConnector> | null = null;

/** NEAR Connect loads wallet scripts (HOT, Meteor, Intear, MyNearWallet…) in sandboxes. */
function getConnector(): Promise<NearConnector> {
  connector ??= import("@hot-labs/near-connect").then(
    ({ NearConnector }) => new NearConnector({ network: "mainnet", autoConnect: false }),
  );
  return connector;
}

export interface NearSignature {
  accountId: string;
  publicKey: string;
  signature: string;
}

/**
 * Opens NEAR Connect's own wallet picker, then has the wallet sign the message (NEP-413).
 * The message itself is built after the account is known, so `build` gets the account id.
 */
export async function signInNear(
  nonce: string,
  recipient: string,
  build: (accountId: string) => string,
): Promise<NearSignature> {
  const near = await getConnector();
  const walletId = await near.selectWallet({ features: { signMessage: true } });
  const wallet = await near.wallet(walletId);
  const accounts = await wallet.signIn({ network: "mainnet" });
  const accountId = accounts[0]?.accountId;
  if (!accountId) throw new Error("The wallet returned no account");
  const signed = await wallet.signMessage({
    message: build(accountId),
    recipient,
    nonce: nonceBytes(nonce),
    network: "mainnet",
    signerId: accountId,
  });
  return { accountId, publicKey: signed.publicKey, signature: signed.signature };
}
