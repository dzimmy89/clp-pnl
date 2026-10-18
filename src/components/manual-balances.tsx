"use client";

import { useState } from "react";
import { PencilIcon, XIcon } from "lucide-react";
import { assetKind, underlyingOf } from "@/lib/assets";
import { formatAmount, formatPrice, formatUsd, shortAddress } from "@/lib/format";
import { fetchLivePrices } from "@/lib/manual-prices";
import type { AssetKind, SpotHolding } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Draft {
  chain: string;
  wallet: string;
  symbol: string;
  kind: AssetKind;
  /** False until the class is picked by hand; until then it follows the symbol. */
  kindPicked: boolean;
  amount: string;
  price: string;
}

const KIND_LABELS: Record<AssetKind, string> = { volatile: "Volatile", stable: "Stable", btc: "BTC-like" };

const EMPTY: Draft = { chain: "Canton", wallet: "", symbol: "", kind: "volatile", kindPicked: false, amount: "", price: "" };

function draftOf(holding: SpotHolding): Draft {
  return {
    chain: holding.chain,
    wallet: holding.wallet === "manual" ? "" : holding.wallet,
    symbol: holding.symbol,
    kind: holding.kind,
    kindPicked: true,
    amount: String(holding.amount),
    price: holding.fixedPrice ? String(holding.priceUsd) : "",
  };
}

function priceAge(at: number | undefined): string {
  if (!at) return "";
  return ` at ${new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
}

/** Wallet balances typed in by hand, for chains with no public balance read such as Canton. */
export function ManualBalances({
  balances,
  missing,
  priceError,
  onChange,
}: {
  balances: SpotHolding[];
  /** Tickers with no live price found; their balances keep the last price. */
  missing: string[];
  priceError: string | null;
  onChange: (next: SpotHolding[]) => void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pricing, setPricing] = useState(false);

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    const symbol = draft.symbol.trim().toUpperCase();
    const amount = Number(draft.amount);
    const fixedPrice = draft.price.trim() !== "";
    let price = Number(draft.price);
    let priceName: string | undefined;
    if (!symbol) return setError("Enter the token ticker.");
    if (!(amount > 0)) return setError("Amount has to be above zero.");
    if (fixedPrice && !(price >= 0)) return setError("Price has to be a number (0 is allowed), or blank for the live price.");
    if (!fixedPrice) {
      setPricing(true);
      try {
        const live = (await fetchLivePrices([symbol])).prices[symbol];
        if (!live) return setError(`No live price found for ${symbol}. Type a price to enter it by hand.`);
        price = live.usd;
        priceName = live.name;
      } catch (failure) {
        return setError(`${failure instanceof Error ? failure.message : "Price lookup failed"}. Type a price to enter it by hand.`);
      } finally {
        setPricing(false);
      }
    }
    const holding: SpotHolding = {
      id: editing ?? `manual-spot:${crypto.randomUUID()}`,
      wallet: draft.wallet.trim() || "manual",
      chain: draft.chain.trim() || "Manual",
      symbol,
      underlying: underlyingOf(symbol),
      kind: draft.kindPicked ? draft.kind : assetKind(symbol),
      amount,
      usd: amount * price,
      priceUsd: price,
      source: "manual",
      ...(fixedPrice ? { fixedPrice: true } : { pricedAt: Date.now(), priceName }),
    };
    onChange(editing ? balances.map((item) => (item.id === editing ? holding : item)) : [...balances, holding]);
    setDraft({ ...EMPTY, chain: holding.chain, wallet: draft.wallet });
    setEditing(null);
    setError(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Balances entered by hand</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          For wallets the app can&apos;t read, like Canton. They count in net worth, spot holdings, BTC beta and the Advisor. Leave
          the price blank and it follows the market price for the ticker, refreshed every few minutes. Type a price to fix it.
        </p>

        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-1">
            <Label htmlFor="spot-chain">Chain</Label>
            <Input id="spot-chain" value={draft.chain} onChange={(event) => update({ chain: event.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="spot-wallet">Wallet or party id</Label>
            <Input id="spot-wallet" value={draft.wallet} placeholder="Optional" onChange={(event) => update({ wallet: event.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="spot-symbol">Token</Label>
            <Input
              id="spot-symbol"
              value={draft.symbol}
              placeholder="CC"
              onChange={(event) => update({ symbol: event.target.value, ...(draft.kindPicked ? {} : { kind: assetKind(event.target.value.trim().toUpperCase()) }) })}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="spot-kind">Class</Label>
            <Select
              items={KIND_LABELS}
              value={draft.kind}
              onValueChange={(value) => {
                if (value === "volatile" || value === "stable" || value === "btc") update({ kind: value, kindPicked: true });
              }}
            >
              <SelectTrigger id="spot-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="volatile">Volatile</SelectItem>
                <SelectItem value="stable">Stable</SelectItem>
                <SelectItem value="btc">BTC-like</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="spot-amount">Amount</Label>
            <Input id="spot-amount" inputMode="decimal" value={draft.amount} onChange={(event) => update({ amount: event.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="spot-price">Price USD</Label>
            <Input
              id="spot-price"
              inputMode="decimal"
              value={draft.price}
              placeholder="Live"
              onChange={(event) => update({ price: event.target.value })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-6">
            <Button type="submit" disabled={pricing}>
              {pricing ? "Finding price…" : editing ? "Save balance" : "Add balance"}
            </Button>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setDraft(EMPTY);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        </form>

        {missing.length ? (
          <p className="text-xs text-gold" role="status">
            No live price found for {missing.join(", ")}, so {missing.length === 1 ? "it keeps" : "they keep"} the last price. Edit the
            balance to type a price.
          </p>
        ) : priceError ? (
          <p className="text-xs text-gold" role="status">
            Live prices couldn&apos;t be refreshed ({priceError}). Showing the last prices found.
          </p>
        ) : null}

        {balances.length ? (
          <ul className="grid gap-2">
            {balances.map((holding) => (
              <li key={holding.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{holding.symbol}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {holding.chain}
                    {holding.wallet !== "manual" ? ` · ${shortAddress(holding.wallet)}` : ""}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {holding.fixedPrice
                      ? "Price entered by hand"
                      : `Live price${holding.priceName ? ` (${holding.priceName})` : ""}${priceAge(holding.pricedAt)}`}
                  </span>
                </span>
                <span className="font-mono text-sm">
                  {formatAmount(holding.amount)} × {formatPrice(holding.priceUsd)}
                </span>
                <span className="font-mono text-sm text-gold">{formatUsd(holding.usd)}</span>
                <span className="flex gap-1">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit ${holding.symbol} balance`}
                    onClick={() => {
                      setEditing(holding.id);
                      setDraft(draftOf(holding));
                      setError(null);
                    }}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Remove ${holding.symbol} balance`}
                    onClick={() => onChange(balances.filter((item) => item.id !== holding.id))}
                  >
                    <XIcon />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
