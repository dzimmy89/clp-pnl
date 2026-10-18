"use client";

import {
  formatAmount,
  formatHealth,
  formatLeverage,
  formatPercent,
  formatRatio,
  formatUsd,
  shortAddress,
  signedUsd,
} from "@/lib/format";
import type { DeskAlert } from "@/lib/alerts";
import { ShieldAlertIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "cn";
import { portfolioMetrics } from "@/lib/metrics";
import {
  PROTOCOLS,
  type BookResponse,
  type Position,
  type ProtocolId,
  type SpotHolding,
  type Thresholds,
} from "@/lib/types";
import { filterByWallet, walletKey, type TrackedWallet } from "@/lib/wallet-set";
import { WALLET_KIND_LABEL } from "@/lib/address-detect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Underlying assets in the book, largest exposure first. BTC and ETH are always offered. */
export function underlyingList(positions: Position[], spot: SpotHolding[], stables: boolean): string[] {
  const exposure = new Map<string, number>();
  const add = (underlying: string, usd: number) => exposure.set(underlying, (exposure.get(underlying) ?? 0) + Math.abs(usd));
  for (const position of positions) {
    for (const leg of position.legs) {
      if ((leg.kind === "stable") === stables) add(leg.underlying, leg.usd);
    }
  }
  for (const holding of spot) {
    if ((holding.kind === "stable") === stables) add(holding.underlying, holding.usd);
  }
  if (!stables) {
    add("BTC", 0);
    add("ETH", 0);
  }
  return [...exposure].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

/** How many asset moves the scenario shows before folding the rest away. */
const SHOCK_FIELDS = 8;

function ShockField({ symbol, value, onShock }: { symbol: string; value: string; onShock: (key: string, value: string) => void }) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={`shock-${symbol}`}>{symbol} move</Label>
      <div className="flex items-center gap-2">
        <Input id={`shock-${symbol}`} inputMode="decimal" value={value} onChange={(event) => onShock(symbol, event.target.value)} placeholder="0" />
        <span className="text-sm text-muted-foreground">%</span>
      </div>
    </div>
  );
}

export function notionalOf(book: ReturnType<typeof portfolioMetrics>): number | null {
  let supply = 0;
  let borrow = 0;
  for (const row of book.active) {
    supply += row.metrics.volatileSupplyUsd;
    borrow += row.metrics.volatileBorrowUsd;
  }
  return supply > 0 ? borrow / supply : null;
}

/** Net value a wallet holds across every protocol and spot: supplied − borrowed + spot. */
export function walletNetUsd(wallet: string, positions: Position[], spot: SpotHolding[]): number {
  let net = 0;
  for (const position of filterByWallet(positions, wallet)) {
    for (const leg of position.legs) net += leg.side === "supply" ? leg.usd : -leg.usd;
  }
  for (const holding of filterByWallet(spot, wallet)) net += holding.usd;
  return net;
}

export function WalletFilter({
  wallets,
  positions,
  spot,
  active,
  onSelect,
}: {
  wallets: TrackedWallet[];
  positions: Position[];
  spot: SpotHolding[];
  active: string | null;
  onSelect: (wallet: string | null) => void;
}) {
  const total = wallets.reduce((sum, w) => sum + walletNetUsd(w.address, positions, spot), 0);
  const chip = "flex min-w-36 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors";
  const on = "border-primary bg-primary/10";
  const off = "border-border hover:bg-muted";
  return (
    <nav aria-label="Filter by wallet" className="flex gap-2 overflow-x-auto pb-1">
      <button type="button" className={`${chip} ${active === null ? on : off}`} aria-pressed={active === null} onClick={() => onSelect(null)}>
        <span className="text-xs text-muted-foreground">All wallets · {wallets.length}</span>
        <span className="font-mono text-sm">{formatUsd(total)}</span>
        <span className="mt-1 h-1 w-full rounded-full bg-gold/70" aria-hidden />
      </button>
      {wallets.map((wallet) => {
        const key = walletKey(wallet.address);
        const kindLabel = WALLET_KIND_LABEL[wallet.kind];
        const net = walletNetUsd(wallet.address, positions, spot);
        return (
          <button
            key={`${wallet.kind}:${key}`}
            type="button"
            className={`${chip} ${active === key ? on : off}`}
            aria-pressed={active === key}
            title={wallet.address}
            onClick={() => onSelect(key)}
          >
            <span className="text-xs text-muted-foreground">
              {kindLabel} · {wallet.label || shortAddress(wallet.address)}
              {wallet.source === "pasted" ? " · pasted" : ""}
            </span>
            <span className="font-mono text-sm">{formatUsd(net)}</span>
            <span className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
              <span className="block h-full rounded-full bg-gold/70" style={{ width: `${total > 0 ? Math.max(0, Math.min(1, net / total)) * 100 : 0}%` }} />
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function ProtocolRow({
  live,
  loading,
  onManual,
}: {
  live: BookResponse | null;
  loading: boolean;
  onManual: (id: ProtocolId) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {PROTOCOLS.map((meta) => {
        const row = live?.protocols.find((protocol) => protocol.id === meta.id);
        const status = loading && !row ? "loading" : (row?.status ?? "skipped");
        const tone =
          status === "error" ? "destructive" : status === "ok" ? "secondary" : "outline";
        return (
          <div key={meta.id} className="flex items-start justify-between gap-2 rounded-lg border border-border px-3 py-2">
            <div>
              <p className="text-sm font-medium">{meta.name}</p>
              <p className="text-xs text-muted-foreground">{meta.chain}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {row?.message ?? (row ? "Loaded." : loading ? "Checking…" : "Not queried yet")}
              </p>
            </div>
            <div className="grid justify-items-end gap-1">
              <Badge variant={tone}>{status}</Badge>
              {(status === "error" || status === "manual" || meta.id === "alpend") && meta.id !== "zerion" ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => onManual(meta.id)}>
                  Add manually
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ScenarioPanel(props: {
  volatileUnderlyings: string[];
  stableUnderlyings: string[];
  shocks: Record<string, string>;
  onShock: (key: string, value: string) => void;
  equity: number;
  pnl: number;
  leverage: number | null;
  hedge: number | null;
  health: number | null;
  delta: number;
  beforeApy: number | null;
  multi: boolean;
  rows: Array<{ label: string; pnl: number; leverage: number | null; hedge: number | null; health: number | null; distance: number | null }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Price scenario</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          APYs stay constant. This does not reprice borrow or supply rates. Enter a percent move, negative for a drop.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {props.volatileUnderlyings.slice(0, SHOCK_FIELDS).map((symbol) => (
            <ShockField key={symbol} symbol={symbol} value={props.shocks[symbol] ?? ""} onShock={props.onShock} />
          ))}
        </div>
        {props.volatileUnderlyings.length > SHOCK_FIELDS ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Move {props.volatileUnderlyings.length - SHOCK_FIELDS} smaller holdings
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {props.volatileUnderlyings.slice(SHOCK_FIELDS).map((symbol) => (
                <ShockField key={symbol} symbol={symbol} value={props.shocks[symbol] ?? ""} onShock={props.onShock} />
              ))}
            </div>
          </details>
        ) : null}
        {props.stableUnderlyings.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Shock a stable (left alone unless you type a move)</summary>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {props.stableUnderlyings.map((symbol) => (
                <div key={symbol} className="grid gap-1">
                  <Label htmlFor={`shock-${symbol}`}>{symbol} move</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`shock-${symbol}`}
                      inputMode="decimal"
                      value={props.shocks[symbol] ?? ""}
                      onChange={(event) => props.onShock(symbol, event.target.value)}
                      placeholder="0"
                    />
                    <span className="text-sm text-muted-foreground">%</span>
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
        <Separator />
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div><dt className="text-xs text-muted-foreground">Equity after</dt><dd className="font-mono">{formatUsd(props.equity)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">PnL</dt><dd className="font-mono">{signedUsd(props.pnl)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Leverage</dt><dd className="font-mono">{props.leverage == null ? "Underwater" : formatLeverage(props.leverage)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Notional hedge</dt><dd className="font-mono">{props.hedge == null ? "—" : formatRatio(props.hedge)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">BTC delta</dt><dd className="font-mono">{formatAmount(props.delta)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Net APY</dt><dd className="font-mono">{props.beforeApy == null ? "—" : formatPercent(props.beforeApy)}</dd></div>
          {!props.multi ? (
            <div><dt className="text-xs text-muted-foreground">Health factor</dt><dd className="font-mono">{props.health == null ? "—" : formatHealth(props.health)}</dd></div>
          ) : null}
        </dl>
        {props.multi ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Book</TableHead>
                <TableHead>PnL</TableHead>
                <TableHead>Lev</TableHead>
                <TableHead>HF</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.rows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell className="font-mono">{signedUsd(row.pnl)}</TableCell>
                  <TableCell className="font-mono">{row.leverage == null ? "Underwater" : formatLeverage(row.leverage)}</TableCell>
                  <TableCell className="font-mono">{row.health == null ? "—" : formatHealth(row.health)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Unit hedge ratios do not change, because token amounts are unchanged when both legs are the same asset. Notional hedge moves only if a shock hits volatile legs unevenly.
        </p>
        <p className="text-xs text-muted-foreground">
          Health factor after the shock is approximated as collateral USD × liquidation threshold ÷ debt USD, with shocked prices. Before the shock, a protocol-reported health factor is shown when the adapter returns one.
        </p>
      </CardContent>
    </Card>
  );
}

export function AlertsPanel({
  alerts,
  thresholds,
  onChange,
  onOpen,
}: {
  alerts: DeskAlert[];
  thresholds: Thresholds;
  onChange: (thresholds: Thresholds) => void;
  /** Scrolls to the position an alert is about. */
  onOpen?: (positionId: string) => void;
}) {
  function setNumber(key: keyof Thresholds, raw: string, scale = 1) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    onChange({ ...thresholds, [key]: value / scale });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Alerts</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No threshold is breached on this book.</p>
        ) : (
          <ul className="grid gap-2">
            {alerts.map((alert) => (
              <AlertRow key={alert.id} alert={alert} onOpen={onOpen ? () => onOpen(alert.positionId) : undefined} />
            ))}
          </ul>
        )}
        <Separator />
        <div className="grid grid-cols-2 gap-2">
          <ThresholdField id="th-warn" label="Health warning" value={thresholds.healthWarning} onBlur={(value) => setNumber("healthWarning", value)} />
          <ThresholdField id="th-crit" label="Health critical" value={thresholds.healthCritical} onBlur={(value) => setNumber("healthCritical", value)} />
          <ThresholdField id="th-apy" label="Min net APY %" value={thresholds.minNetApy * 100} onBlur={(value) => setNumber("minNetApy", value, 100)} />
          <ThresholdField id="th-lev" label="Max leverage" value={thresholds.maxLeverage} onBlur={(value) => setNumber("maxLeverage", value)} />
          <ThresholdField id="th-hedge" label="Hedge tolerance" value={thresholds.hedgeTolerance} onBlur={(value) => setNumber("hedgeTolerance", value)} />
          <ThresholdField id="th-liq" label="Liq. proximity %" value={thresholds.liquidationProximity * 100} onBlur={(value) => setNumber("liquidationProximity", value, 100)} />
        </div>
        <p className="text-xs text-muted-foreground">
          Hedge tolerance is an absolute ratio. 0.05 means the hedge can drift five percentage points from the per-position target before it alerts. Thresholds are saved in this browser, and on your account when you sign in.
        </p>
      </CardContent>
    </Card>
  );
}

/** One alert: a coloured stripe and icon for how urgent it is, then the sentence. */
export function AlertRow({ alert, onOpen }: { alert: DeskAlert; onOpen?: () => void }) {
  const critical = alert.severity === "critical";
  const Icon = critical ? ShieldAlertIcon : TriangleAlertIcon;
  return (
    <li
      className={cn(
        "relative flex gap-3 overflow-hidden rounded-xl border py-2.5 pr-3 pl-4 text-sm",
        critical ? "border-destructive/40 bg-destructive/5" : "border-gold/30 bg-gold/5",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", critical ? "bg-destructive" : "bg-gold")} aria-hidden />
      <Icon className={cn("mt-0.5 size-4 shrink-0", critical ? "text-destructive" : "text-gold")} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className={cn("text-[11px] font-semibold tracking-[0.12em] uppercase", critical ? "text-destructive" : "text-gold")}>
          {critical ? "Critical" : "Warning"}
        </p>
        <p className="mt-0.5 leading-snug">{alert.sentence}</p>
        {onOpen ? (
          <button type="button" className="mt-1 text-xs text-azure hover:underline" onClick={onOpen}>
            View position
          </button>
        ) : null}
      </div>
    </li>
  );
}

function ThresholdField({
  id,
  label,
  value,
  onBlur,
}: {
  id: string;
  label: string;
  value: number;
  onBlur: (value: string) => void;
}) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        defaultValue={String(Number(value.toFixed(4)))}
        key={`${id}-${value}`}
        onBlur={(event) => onBlur(event.target.value)}
      />
    </div>
  );
}
