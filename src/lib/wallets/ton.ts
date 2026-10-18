"use client";

import type { ConnectedWallet, TonConnectUI } from "@tonconnect/ui";
import type { ClientChainModule, ClientSigned } from "@/lib/auth/chains/types";

/**
 * TON sign-in through TON Connect. Wallets (Tonkeeper, MyTonWallet, Wallet in Telegram…) only
 * sign a `ton_proof` envelope, so we ask for one with the server nonce as its payload. The
 * envelope binds the wallet address, the app domain (from the manifest) and a timestamp; the
 * server checks it in `src/lib/auth/chains/ton.ts`.
 */

let uiPromise: Promise<TonConnectUI> | null = null;

/** One TonConnectUI per page, created on first use (the library touches the DOM). */
function getUi(): Promise<TonConnectUI> {
  if (!uiPromise) {
    uiPromise = import("@tonconnect/ui").then(
      ({ TonConnectUI }) => new TonConnectUI({ manifestUrl: `${window.location.origin}/tonconnect-manifest.json` }),
    );
    uiPromise.catch(() => {
      uiPromise = null;
    });
  }
  return uiPromise;
}

function toSigned(wallet: ConnectedWallet): ClientSigned {
  const reply = wallet.connectItems?.tonProof;
  if (!reply) throw new Error("The wallet connected without signing in. Try again.");
  if ("error" in reply) throw new Error(reply.error.message || "The wallet refused to sign in");
  const { timestamp, domain, payload, signature } = reply.proof;
  const signed: ClientSigned = {
    address: wallet.account.address,
    signature,
    signedMessage: JSON.stringify({ timestamp, domain: { lengthBytes: domain.lengthBytes, value: domain.value }, payload }),
    extra: { stateInit: wallet.account.walletStateInit },
  };
  if (wallet.account.publicKey) signed.publicKey = wallet.account.publicKey;
  return signed;
}

export const tonWallets: ClientChainModule = {
  // TON Connect shows its own wallet picker (extensions, mobile apps via QR, Telegram).
  installHint: "",

  list() {
    return [{ id: "ton:connect", name: "TON wallet" }];
  },

  watch() {
    return () => {};
  },

  async signIn(_wallet, _build, { nonce }): Promise<ClientSigned> {
    const ui = await getUi();
    await ui.connectionRestored;
    // A restored session has no fresh proof; start over so the wallet signs this nonce.
    if (ui.connected) await ui.disconnect();
    ui.setConnectRequestParameters({ state: "ready", value: { tonProof: nonce } });

    return new Promise<ClientSigned>((resolve, reject) => {
      let done = false;
      const cleanup: (() => void)[] = [];
      const finish = (error: unknown, result?: ClientSigned) => {
        if (done) return;
        done = true;
        cleanup.forEach((off) => off());
        ui.setConnectRequestParameters(null);
        if (result) resolve(result);
        else reject(error instanceof Error ? error : new Error("TON wallet sign-in failed"));
      };

      cleanup.push(
        ui.onStatusChange(
          (wallet) => {
            if (!wallet) return;
            try {
              finish(null, toSigned(wallet));
            } catch (error) {
              finish(error);
            }
          },
          (error) => finish(error),
        ),
      );
      cleanup.push(
        ui.onModalStateChange((state) => {
          if (state.status === "closed" && state.closeReason === "action-cancelled" && !ui.connected) {
            finish(new Error("Sign-in cancelled"));
          }
        }),
      );
      ui.openModal().catch((error: unknown) => finish(error));
    });
  },
};
