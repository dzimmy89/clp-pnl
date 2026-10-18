"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { WalletIcon } from "lucide-react";
import type { AccountView } from "@/lib/account";
import { CHAIN_LABEL, type WalletChain } from "@/lib/auth/message";
import { discoverEvmWallets, evmWallets, type EvmWallet } from "@/lib/wallets/evm";
import { signInWithWallet, walletErrorMessage, type SignInIntent, type WalletChoice } from "@/lib/wallets/signin";
import { solanaWallets, watchSolanaWallets, type SolanaWallet } from "@/lib/wallets/solana";
import { PLUGIN_CHAINS, PLUGIN_WALLETS } from "@/lib/wallets/plugins";
import type { ClientWallet } from "@/lib/auth/chains/types";
import type { PluginChain } from "@/lib/auth/message";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface DetectedWallets {
  evm: EvmWallet[];
  solana: SolanaWallet[];
  plugins: Record<PluginChain, ClientWallet[]>;
}

const NO_PLUGINS = Object.fromEntries(PLUGIN_CHAINS.map((chain) => [chain, []])) as unknown as Record<PluginChain, ClientWallet[]>;
const NONE: DetectedWallets = { evm: [], solana: [], plugins: NO_PLUGINS };
let snapshot: DetectedWallets = NONE;

function sameIds(a: { id: string }[], b: { id: string }[]) {
  return a.length === b.length && a.every((w, i) => w.id === b[i]?.id);
}

function readWallets(): DetectedWallets {
  const evm = evmWallets();
  const solana = solanaWallets();
  const plugins = Object.fromEntries(PLUGIN_CHAINS.map((chain) => [chain, safeList(chain)])) as Record<PluginChain, ClientWallet[]>;
  const same =
    sameIds(evm, snapshot.evm) &&
    sameIds(solana, snapshot.solana) &&
    PLUGIN_CHAINS.every((chain) => sameIds(plugins[chain], snapshot.plugins[chain]));
  if (!same) snapshot = { evm, solana, plugins };
  return snapshot;
}

function safeList(chain: PluginChain): ClientWallet[] {
  try {
    return PLUGIN_WALLETS[chain].list();
  } catch {
    return [];
  }
}

function subscribeWallets(onChange: () => void) {
  const stopEvm = discoverEvmWallets(onChange);
  const stopSolana = watchSolanaWallets(onChange);
  const stops = PLUGIN_CHAINS.map((chain) => PLUGIN_WALLETS[chain].watch(onChange));
  // Some extensions inject their globals a moment after load.
  const late = window.setTimeout(onChange, 800);
  return () => {
    stopEvm();
    stopSolana();
    stops.forEach((stop) => stop());
    window.clearTimeout(late);
  };
}

/** Wallets installed in this browser, kept current as extensions announce themselves. */
function useDetectedWallets(): DetectedWallets {
  return useSyncExternalStore(subscribeWallets, readWallets, () => NONE);
}

export function WalletDialog({
  open,
  onOpenChange,
  intent,
  onSignedIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intent: SignInIntent;
  onSignedIn: (account: AccountView) => void;
}) {
  const wallets = useDetectedWallets();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clear the last attempt when reopened
    if (open) setError(null);
  }, [open]);

  async function choose(key: string, choice: WalletChoice) {
    setPending(key);
    setError(null);
    try {
      const account = await signInWithWallet(choice, intent);
      onSignedIn(account);
      onOpenChange(false);
    } catch (err) {
      setError(walletErrorMessage(err));
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{intent === "link" ? "Link another wallet" : "Sign in with a wallet"}</DialogTitle>
          <DialogDescription>
            {intent === "link"
              ? "Sign one message with the wallet to prove you own it. It joins this account and you can sign in with it too."
              : "Your wallet is your account. The first sign-in creates it; after that, the same wallet signs you back in. You sign one message: no transaction, no gas."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <WalletGroup chain="evm" empty="No EVM wallet found in this browser. Install MetaMask, Rabby or another EVM wallet.">
            {wallets.evm.map((wallet) => (
              <WalletButton
                key={wallet.id}
                name={wallet.name}
                icon={wallet.icon}
                hint={wallet.id === "walletconnect" ? "Scan with a phone wallet: MetaMask, Rainbow, Trust and more" : undefined}
                pending={pending === wallet.id}
                disabled={busy}
                onClick={() => choose(wallet.id, { chain: "evm", wallet })}
              />
            ))}
          </WalletGroup>

          <WalletGroup chain="solana" empty="No Solana wallet found in this browser. Install Phantom, Solflare or Backpack.">
            {wallets.solana.map((wallet) => (
              <WalletButton
                key={wallet.id}
                name={wallet.name}
                icon={wallet.icon}
                pending={pending === wallet.id}
                disabled={busy}
                onClick={() => choose(wallet.id, { chain: "solana", wallet })}
              />
            ))}
          </WalletGroup>

          <WalletGroup chain="near" empty="">
            <WalletButton
              name="Choose a NEAR wallet"
              hint="HOT, Meteor, Intear, MyNearWallet and more"
              pending={pending === "near"}
              disabled={busy}
              onClick={() => choose("near", { chain: "near" })}
            />
          </WalletGroup>

          {PLUGIN_CHAINS.filter((chain) => wallets.plugins[chain].length > 0).map((chain) => (
            <WalletGroup key={chain} chain={chain} empty="">
              {wallets.plugins[chain].map((wallet) => (
                <WalletButton
                  key={wallet.id}
                  name={wallet.name}
                  icon={wallet.icon}
                  pending={pending === wallet.id}
                  disabled={busy}
                  onClick={() => choose(wallet.id, { chain, wallet })}
                />
              ))}
            </WalletGroup>
          ))}

          {PLUGIN_CHAINS.some((chain) => wallets.plugins[chain].length === 0) ? (
            <section className="grid gap-2">
              <button
                type="button"
                className="justify-self-start text-xs text-azure hover:underline"
                aria-expanded={showAll}
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll ? "Hide other chains" : "Wallets for other chains"}
              </button>
              {showAll ? (
                <ul className="grid gap-1 text-xs text-muted-foreground">
                  {PLUGIN_CHAINS.filter((chain) => wallets.plugins[chain].length === 0).map((chain) => (
                    <li key={chain}>
                      <span className="font-medium text-foreground">{CHAIN_LABEL[chain]}:</span> {PLUGIN_WALLETS[chain].installHint}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function WalletGroup({ chain, empty, children }: { chain: WalletChain; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <section className="grid gap-2">
      <h3 className="text-xs tracking-[0.14em] text-muted-foreground uppercase">{CHAIN_LABEL[chain]}</h3>
      {items.length ? children : <p className="text-xs text-muted-foreground">{empty}</p>}
    </section>
  );
}

function WalletButton({
  name,
  icon,
  hint,
  pending,
  disabled,
  onClick,
}: {
  name: string;
  icon?: string;
  hint?: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" className="h-auto justify-start gap-3 px-3 py-2" disabled={disabled} onClick={onClick}>
      {icon ? (
        // Wallet icons are data: URIs supplied by the extension itself.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={icon} alt="" className="size-6 rounded" />
      ) : (
        <WalletIcon className="size-6 text-muted-foreground" />
      )}
      <span className="flex flex-col items-start text-left">
        <span>{name}</span>
        {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
      </span>
      <span className="ml-auto text-xs text-muted-foreground">{pending ? "Check your wallet…" : ""}</span>
    </Button>
  );
}
