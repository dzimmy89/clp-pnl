import { cn } from "cn";
import type { AssetKind } from "@/lib/types";

/** The rounded dark surface every block on the page sits in. */
export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("min-w-0 rounded-2xl border border-border bg-card/90 p-5", className)} {...props} />;
}

export function SectionLabel({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("text-[11px] font-semibold tracking-[0.16em] text-muted-foreground uppercase", className)}
      {...props}
    />
  );
}

export function Num({ className, ...props }: React.ComponentProps<"span">) {
  return <span className={cn("font-mono tabular-nums", className)} {...props} />;
}

const KIND_STYLE: Record<AssetKind, string> = {
  btc: "bg-gold/15 text-gold ring-gold/30",
  stable: "bg-azure/15 text-azure ring-azure/30",
  volatile: "bg-foreground/10 text-foreground ring-foreground/20",
};

/** Round token mark, like Alpend's asset icons: gold for BTC, blue for stables. */
export function AssetBadge({ symbol, kind }: { symbol: string; kind: AssetKind }) {
  const letters = symbol.replace(/^(w|c|t|u)(?=[A-Z])/, "").slice(0, 3);
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full text-[10px] font-bold tracking-tight ring-1",
        KIND_STYLE[kind],
      )}
    >
      {letters}
    </span>
  );
}

/** Thin progress track used for health, utilization and share bars. */
export function Meter({ value, tone, className }: { value: number; tone: "gold" | "azure" | "destructive"; className?: string }) {
  const color = tone === "gold" ? "bg-gold" : tone === "azure" ? "bg-azure" : "bg-destructive";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}
