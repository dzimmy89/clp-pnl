"use client";

import { useState } from "react";
import { ChevronDownIcon, LogOutIcon, PlusIcon, Trash2Icon, WalletIcon } from "lucide-react";
import { removeAccountWallet, renameAccountWallet, type AccountState, type AccountWallet } from "@/lib/account";
import { CHAIN_LABEL, shortAddress } from "@/lib/auth/message";
import { signOut, walletErrorMessage, type SignInIntent } from "@/lib/wallets/signin";
import { WalletDialog } from "@/components/wallet-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Top-bar control: sign in with a wallet, or jump to the signed-in account's wallets. */
export function AccountControl({ state, onManage }: { state: AccountState; onManage: () => void }) {
  const { account, accountsEnabled, loading, setAccount } = state;
  const [open, setOpen] = useState(false);

  if (loading) return <Button variant="outline" disabled>Loading…</Button>;

  if (!accountsEnabled) {
    return (
      <Button variant="outline" disabled title="The server has no database. Set DATABASE_URL on the Cloud Run service; /api/health shows the status.">
        <WalletIcon /> Accounts unavailable
      </Button>
    );
  }

  if (account) {
    return (
      <Button variant="outline" className="rounded-full" onClick={onManage}>
        <span className="size-2 rounded-full bg-azure" aria-hidden />
        <span className="font-mono text-xs">{shortAddress(account.wallets[0]?.address ?? "")}</span>
        {account.wallets.length > 1 ? <span className="text-xs text-muted-foreground">+{account.wallets.length - 1}</span> : null}
        <ChevronDownIcon className="text-muted-foreground" />
      </Button>
    );
  }

  return (
    <>
      <Button className="rounded-full" onClick={() => setOpen(true)}>
        <WalletIcon /> Sign in with wallet
      </Button>
      <WalletDialog open={open} onOpenChange={setOpen} intent="signin" onSignedIn={setAccount} />
    </>
  );
}

/** The account's wallets with label, remove, link another, and sign out. */
export function AccountWallets({ state }: { state: AccountState }) {
  const { account, accountsEnabled, setAccount } = state;
  const [intent, setIntent] = useState<SignInIntent | null>(null);

  if (!accountsEnabled) {
    return <p className="text-sm text-muted-foreground">Wallet accounts are off on this server. Paste addresses below instead.</p>;
  }

  return (
    <div className="grid gap-4">
      {account ? (
        <>
          <ul className="grid gap-2">
            {account.wallets.map((wallet) => (
              <WalletRow key={wallet.id} wallet={wallet} removable={account.wallets.length > 1} onChange={setAccount} />
            ))}
          </ul>
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="outline" onClick={() => setIntent("link")}>
              <PlusIcon /> Link another wallet
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                await signOut().catch(() => {});
                setAccount(null);
              }}
            >
              <LogOutIcon /> Sign out
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border p-4">
          <p className="text-sm text-muted-foreground">
            Sign in with a wallet to save it to an account. Link wallets on other chains and they all load together, on any device.
          </p>
          <Button className="rounded-full" onClick={() => setIntent("signin")}>
            <WalletIcon /> Sign in with wallet
          </Button>
        </div>
      )}
      <WalletDialog
        open={intent !== null}
        onOpenChange={(open) => !open && setIntent(null)}
        intent={intent ?? "signin"}
        onSignedIn={setAccount}
      />
    </div>
  );
}

function WalletRow({
  wallet,
  removable,
  onChange,
}: {
  wallet: AccountWallet;
  removable: boolean;
  onChange: AccountState["setAccount"];
}) {
  const [label, setLabel] = useState(wallet.label);
  const [error, setError] = useState<string | null>(null);

  async function saveLabel() {
    if (label.trim() === wallet.label) return;
    try {
      onChange(await renameAccountWallet(wallet.id, label));
    } catch (err) {
      setError(walletErrorMessage(err));
    }
  }

  async function remove() {
    try {
      onChange(await removeAccountWallet(wallet.id));
    } catch (err) {
      setError(walletErrorMessage(err));
    }
  }

  return (
    <li className="grid gap-1 rounded-xl border border-border bg-background/40 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-md bg-azure/15 px-2 py-0.5 text-xs font-medium text-azure">{CHAIN_LABEL[wallet.chain]}</span>
        <span className="truncate font-mono text-sm" title={wallet.address}>
          {shortAddress(wallet.address)}
        </span>
        <Input
          value={label}
          placeholder="Add a label"
          aria-label={`Label for ${wallet.address}`}
          maxLength={40}
          className="ml-auto h-8 w-44"
          onChange={(event) => setLabel(event.target.value)}
          onBlur={saveLabel}
          onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${wallet.address}`}
          title={removable ? "Remove wallet" : "Your only sign-in wallet can't be removed"}
          disabled={!removable}
          onClick={remove}
        >
          <Trash2Icon />
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </li>
  );
}
