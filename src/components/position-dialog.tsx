"use client";

import { useState } from "react";
import { assetKind, assumedLiquidationThreshold, underlyingOf } from "@/lib/assets";
import { fetchLivePrices, type LivePrice } from "@/lib/manual-prices";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MANUAL_PROTOCOLS, type AssetKind, type Leg, type Position, type ProtocolId } from "@/lib/types";

interface DraftLeg {
  key: string;
  side: "supply" | "borrow";
  symbol: string;
  kind: AssetKind;
  amount: string;
  /** Blank follows the market price for the ticker. */
  price: string;
  apy: string;
  lt: string;
}

function blankLeg(side: "supply" | "borrow"): DraftLeg {
  return {
    key: crypto.randomUUID(),
    side,
    symbol: side === "supply" ? "WBTC" : "USDC",
    kind: side === "supply" ? "btc" : "stable",
    amount: "",
    price: "",
    apy: side === "supply" ? "1" : "5",
    lt: "78",
  };
}

function fromPosition(position: Position): DraftLeg[] {
  return position.legs.map((leg) => ({
    key: leg.id,
    side: leg.side,
    symbol: leg.symbol,
    kind: leg.kind,
    amount: String(leg.amount),
    price: leg.fixedPrice ? String(leg.priceUsd ?? (leg.amount > 0 ? leg.usd / leg.amount : 0)) : "",
    apy: String(leg.apy * 100),
    lt: String((leg.liquidationThreshold ?? assumedLiquidationThreshold(leg.kind)) * 100),
  }));
}

function draftFrom(initial: Position | null, presetProtocol: ProtocolId | null) {
  if (initial) {
    return {
      protocol: initial.protocol,
      wallet: initial.wallet,
      label: initial.label,
      target: String((initial.targetHedgeRatio ?? 0.3) * 100),
      legs: fromPosition(initial),
    };
  }
  return {
    protocol: presetProtocol ?? "alpend",
    wallet: "",
    label: "",
    target: "30",
    legs: [blankLeg("supply"), blankLeg("borrow")],
  };
}

export function PositionDialog({
  open,
  onOpenChange,
  initial,
  presetProtocol,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: Position | null;
  presetProtocol: ProtocolId | null;
  onSave: (position: Position) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <PositionForm
          key={initial?.id ?? presetProtocol ?? "new"}
          initial={initial}
          presetProtocol={presetProtocol}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

function PositionForm({
  initial,
  presetProtocol,
  onOpenChange,
  onSave,
}: {
  initial: Position | null;
  presetProtocol: ProtocolId | null;
  onOpenChange: (open: boolean) => void;
  onSave: (position: Position) => void;
}) {
  const draft = draftFrom(initial, presetProtocol);
  const [protocol, setProtocol] = useState<ProtocolId>(draft.protocol);
  const [wallet, setWallet] = useState(draft.wallet);
  const [label, setLabel] = useState(draft.label);
  const [target, setTarget] = useState(draft.target);
  const [legs, setLegs] = useState<DraftLeg[]>(draft.legs);
  const [error, setError] = useState<string | null>(null);
  const [pricing, setPricing] = useState(false);

  function updateLeg(key: string, patch: Partial<DraftLeg>) {
    setLegs((current) =>
      current.map((leg) => {
        if (leg.key !== key) return leg;
        const next = { ...leg, ...patch };
        if (patch.symbol && !patch.kind) next.kind = assetKind(patch.symbol);
        return next;
      }),
    );
  }

  async function save() {
    for (const leg of legs) {
      if (!leg.symbol.trim()) return setError("Every leg needs an asset symbol.");
      const fixed = leg.price.trim() !== "";
      if (!(Number(leg.amount) > 0) || (fixed && !(Number(leg.price) >= 0)) || !Number.isFinite(Number(leg.apy))) {
        return setError("Amount, price and APY need to be numbers, and amount has to be above zero. Leave price blank for the live price.");
      }
    }
    // Legs with no price typed take the live price for their ticker.
    const liveSymbols = [...new Set(legs.filter((leg) => leg.price.trim() === "").map((leg) => leg.symbol.trim().toUpperCase()))];
    let live: Record<string, LivePrice> = {};
    if (liveSymbols.length) {
      setPricing(true);
      try {
        live = (await fetchLivePrices(liveSymbols)).prices;
      } catch (failure) {
        return setError(`${failure instanceof Error ? failure.message : "Price lookup failed"}. Type the prices to enter them by hand.`);
      } finally {
        setPricing(false);
      }
      const missing = liveSymbols.filter((symbol) => !live[symbol]);
      if (missing.length) return setError(`No live price found for ${missing.join(", ")}. Type a price for ${missing.length === 1 ? "it" : "them"}.`);
    }
    const now = Date.now();
    const parsed: Leg[] = [];
    for (const leg of legs) {
      const amount = Number(leg.amount);
      const apy = Number(leg.apy) / 100;
      const lt = Number(leg.lt) / 100;
      const symbol = leg.symbol.trim().toUpperCase();
      const fixed = leg.price.trim() !== "";
      const price = fixed ? Number(leg.price) : live[symbol].usd;
      parsed.push({
        id: leg.key,
        side: leg.side,
        symbol,
        underlying: underlyingOf(symbol),
        kind: leg.kind,
        amount,
        usd: amount * price,
        apy,
        priceUsd: price,
        isCollateral: leg.side === "supply",
        liquidationThreshold: leg.side === "supply" && lt > 0 && lt <= 1 ? lt : undefined,
        liquidationThresholdSource: "assumed",
        ...(fixed ? { fixedPrice: true } : { pricedAt: now, priceName: live[symbol].name }),
      });
    }
    if (!parsed.some((leg) => leg.side === "supply")) {
      setError("Add at least one supply leg.");
      return;
    }
    const meta = MANUAL_PROTOCOLS.find((item) => item.id === protocol);
    const position: Position = {
      id: initial?.id ?? `manual:${crypto.randomUUID()}`,
      protocol,
      chain: meta?.chain ?? "Manual",
      wallet: wallet.trim() || "manual",
      label: label.trim() || "Manual book",
      source: "manual",
      legs: parsed,
      targetHedgeRatio: Number(target) / 100,
      healthFactor: null,
      healthFactorSource: "estimated",
      note: "Entered by hand. Prices left blank follow the market. Health factor is estimated from the liquidation thresholds on the supply legs.",
      fetchedAt: new Date().toISOString(),
    };
    onSave(position);
    onOpenChange(false);
  }

  return (
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{initial ? "Edit manual book" : "Add a manual book"}</DialogTitle>
          <DialogDescription>
            Use this for Alpend, or when a live read fails. APY is a percent. Price is USD per token: leave it blank to follow the
            market price for the asset&apos;s ticker, or type one to fix it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="manual-protocol">Protocol</Label>
            <Select
              value={protocol}
              onValueChange={(value) => {
                if (value) setProtocol(value as ProtocolId);
              }}
            >
              <SelectTrigger id="manual-protocol" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_PROTOCOLS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · {item.chain}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="manual-wallet">Wallet or party id</Label>
            <Input id="manual-wallet" value={wallet} onChange={(event) => setWallet(event.target.value)} placeholder="Optional label for the account" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="manual-label">Book name</Label>
            <Input id="manual-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="CBTC loop" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="manual-target">Target hedge ratio (%)</Label>
            <Input id="manual-target" inputMode="decimal" value={target} onChange={(event) => setTarget(event.target.value)} />
          </div>
        </div>
        <div className="grid gap-3">
          {legs.map((leg, index) => (
            <fieldset key={leg.key} className="grid gap-2 rounded-lg border border-border p-3">
              <legend className="px-1 text-xs text-muted-foreground">Leg {index + 1}</legend>
              <div className="grid gap-2 sm:grid-cols-6">
                <div className="grid gap-1">
                  <Label htmlFor={`${leg.key}-side`}>Side</Label>
                  <Select
                    value={leg.side}
                    onValueChange={(value) => {
                      if (value === "supply" || value === "borrow") updateLeg(leg.key, { side: value });
                    }}
                  >
                    <SelectTrigger id={`${leg.key}-side`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="supply">Supply</SelectItem>
                      <SelectItem value="borrow">Borrow</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${leg.key}-symbol`}>Asset</Label>
                  <Input
                    id={`${leg.key}-symbol`}
                    value={leg.symbol}
                    onChange={(event) => updateLeg(leg.key, { symbol: event.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${leg.key}-kind`}>Class</Label>
                  <Select
                    value={leg.kind}
                    onValueChange={(value) => {
                      if (value === "volatile" || value === "stable" || value === "btc") {
                        updateLeg(leg.key, { kind: value });
                      }
                    }}
                  >
                    <SelectTrigger id={`${leg.key}-kind`} className="w-full">
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
                  <Label htmlFor={`${leg.key}-amount`}>Amount</Label>
                  <Input id={`${leg.key}-amount`} inputMode="decimal" value={leg.amount} onChange={(event) => updateLeg(leg.key, { amount: event.target.value })} />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${leg.key}-price`}>Price USD</Label>
                  <Input
                    id={`${leg.key}-price`}
                    inputMode="decimal"
                    value={leg.price}
                    placeholder="Live"
                    onChange={(event) => updateLeg(leg.key, { price: event.target.value })}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`${leg.key}-apy`}>APY %</Label>
                  <Input id={`${leg.key}-apy`} inputMode="decimal" value={leg.apy} onChange={(event) => updateLeg(leg.key, { apy: event.target.value })} />
                </div>
              </div>
              {leg.side === "supply" ? (
                <div className="grid max-w-xs gap-1">
                  <Label htmlFor={`${leg.key}-lt`}>Liquidation threshold %</Label>
                  <Input id={`${leg.key}-lt`} inputMode="decimal" value={leg.lt} onChange={(event) => updateLeg(leg.key, { lt: event.target.value })} />
                </div>
              ) : null}
              <Button type="button" variant="ghost" className="justify-self-start" onClick={() => setLegs((current) => current.filter((item) => item.key !== leg.key))}>
                Remove leg
              </Button>
            </fieldset>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setLegs((current) => [...current, blankLeg("supply")])}>
              Add supply
            </Button>
            <Button type="button" variant="outline" onClick={() => setLegs((current) => [...current, blankLeg("borrow")])}>
              Add borrow
            </Button>
          </div>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={pricing}>
            {pricing ? "Finding prices…" : "Save book"}
          </Button>
        </DialogFooter>
      </DialogContent>
  );
}
