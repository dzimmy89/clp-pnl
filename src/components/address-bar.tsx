"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { parseAddressList, WALLET_KIND_LABEL, type ParsedAddress } from "@/lib/address-detect";
import { shortAddress } from "@/lib/format";
import type { PastedWallet, WalletKind } from "@/lib/types";
import { MAX_WALLETS_PER_KIND, walletKey, type TrackedWallet } from "@/lib/wallet-set";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CHAIN_LIST = "EVM, Solana, NEAR, Sui, Aptos, TON, Tron, Cosmos, Starknet, Cardano, Kaspa or Canton";

const sameWallet = (a: { kind: WalletKind; address: string }, b: { kind: WalletKind; address: string }) =>
  a.kind === b.kind && walletKey(a.address) === walletKey(b.address);

/**
 * Adds `candidates` to `pasted`, skipping repeats of a tracked wallet and anything past the
 * per-chain cap. Account wallets count toward the cap because the book reads them too.
 */
function addWallets(pasted: PastedWallet[], account: TrackedWallet[], candidates: PastedWallet[]) {
  const next = [...pasted];
  const full: string[] = [];
  let repeats = 0;
  for (const candidate of candidates) {
    const address = candidate.kind === "near" ? candidate.address.toLowerCase() : candidate.address;
    const wallet = { kind: candidate.kind, address };
    if ([...account, ...next].some((other) => sameWallet(other, wallet))) {
      repeats += 1;
      continue;
    }
    const used = account.filter((w) => w.kind === wallet.kind).length + next.filter((w) => w.kind === wallet.kind).length;
    if (used >= MAX_WALLETS_PER_KIND) {
      full.push(shortAddress(address));
      continue;
    }
    next.push(wallet);
  }
  return { next, added: next.length - pasted.length, repeats, full };
}

export function AddressBar({
  accountWallets,
  pasted,
  disabled,
  loading,
  onChange,
  onRefresh,
}: {
  /** Wallets linked to the signed-in account; they are read already and count toward the cap. */
  accountWallets: TrackedWallet[];
  pasted: PastedWallet[];
  disabled: boolean;
  loading: boolean;
  /** `reload` is true when the set of addresses changed, false for a label edit. */
  onChange: (pasted: PastedWallet[], reload: boolean) => void;
  onRefresh: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<ParsedAddress[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  function add(candidates: PastedWallet[], extra: string[] = []) {
    const { next, added, repeats, full } = addWallets(pasted, accountWallets, candidates);
    const out = [...extra];
    if (repeats) out.push(`${repeats === 1 ? "1 address was" : `${repeats} addresses were`} already tracked.`);
    if (full.length) out.push(`Up to ${MAX_WALLETS_PER_KIND} wallets per chain, so these were left out: ${full.join(", ")}.`);
    setNotes(out);
    if (added) onChange(next, true);
  }

  function submit() {
    const parsed = parseAddressList(text);
    if (!parsed.length) return;
    const unknown = parsed.filter((p) => p.kinds.length === 0).map((p) => p.address);
    const ambiguous = parsed.filter((p) => p.kinds.length > 1);
    setPending([...pending.filter((p) => !ambiguous.some((a) => a.address === p.address)), ...ambiguous]);
    setText(unknown.join("\n"));
    add(
      parsed.filter((p) => p.kinds.length === 1).map((p) => ({ kind: p.kinds[0], address: p.address })),
      unknown.length
        ? [`Not recognised as an address on any supported chain: ${unknown.map(shortAddress).join(", ")}. They are left in the box to fix.`]
        : [],
    );
  }

  function pick(item: ParsedAddress, kind: WalletKind | null) {
    setPending(pending.filter((p) => p !== item));
    if (kind) add([{ kind, address: item.address }]);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Track addresses without linking</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {accountWallets.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            The {accountWallets.length === 1 ? "wallet" : `${accountWallets.length} wallets`} on your account {accountWallets.length === 1 ? "is" : "are"} read
            automatically. Paste more addresses below to track them without linking.
          </p>
        ) : null}

        <div className="grid gap-1.5">
          <Label htmlFor="paste-addresses">Paste addresses</Label>
          <textarea
            id="paste-addresses"
            value={text}
            rows={4}
            placeholder={"0x…\nname.near\nTQn9…, cosmos1…, addr1…, kaspa:…"}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
            className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
          <p className="text-xs text-muted-foreground">
            Any number at once, one per line or separated by commas or spaces, on {CHAIN_LIST}. The chain is detected from each
            address. Write <span className="font-mono">aptos:0x…</span> to pick the chain yourself.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={submit} disabled={!text.trim()}>
            Add addresses
          </Button>
          <Button type="button" variant="outline" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh live book"}
          </Button>
          <p className="text-xs text-muted-foreground">
            {disabled ? "Adding switches you to Live. " : ""}Pasted addresses are saved in this browser, and on your account when you sign in.
          </p>
        </div>

        {notes.length ? (
          <div className="grid gap-1" role="status">
            {notes.map((note) => (
              <p key={note} className="text-xs text-gold">
                {note}
              </p>
            ))}
          </div>
        ) : null}

        {pending.length ? (
          <div className="grid gap-2">
            <p className="text-sm">This address format is used by more than one chain. Which one is it on?</p>
            {pending.map((item) => (
              <div key={item.address} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2">
                <span className="font-mono text-xs" title={item.address}>
                  {shortAddress(item.address)}
                </span>
                {item.kinds.map((kind) => (
                  <Button key={kind} type="button" size="sm" variant="outline" onClick={() => pick(item, kind)}>
                    {WALLET_KIND_LABEL[kind]}
                  </Button>
                ))}
                <Button type="button" size="sm" variant="ghost" onClick={() => pick(item, null)}>
                  Skip
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        {pasted.length ? (
          <div className="grid gap-2">
            <p className="text-sm font-medium">
              Tracking {pasted.length} pasted {pasted.length === 1 ? "address" : "addresses"}
            </p>
            <ul className="grid gap-2">
              {pasted.map((wallet, index) => (
                <li
                  key={`${wallet.kind}:${walletKey(wallet.address)}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <Badge variant="outline">{WALLET_KIND_LABEL[wallet.kind]}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={wallet.address}>
                    {wallet.address}
                  </span>
                  <Input
                    aria-label={`Label for ${wallet.address}`}
                    value={wallet.label ?? ""}
                    placeholder="Label"
                    className="h-7 w-32"
                    onChange={(event) =>
                      onChange(
                        pasted.map((w, i) => (i === index ? { ...w, label: event.target.value } : w)),
                        false,
                      )
                    }
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Stop tracking ${wallet.address}`}
                    onClick={() => onChange(pasted.filter((_, i) => i !== index), true)}
                  >
                    <XIcon />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
