import { CHAIN_BY_KEY } from "@/lib/chains";
import { fmtAmount, fmtFee, fmtPrice, fmtUsd } from "@/lib/format";
import type { Position } from "@/lib/types";

/** Where the current price sits inside the range, 0..1, clamped. */
function rangePosition(p: Position): number {
  const span = p.tickUpper - p.tickLower;
  if (span <= 0) return 0.5;
  return Math.min(1, Math.max(0, (p.currentTick - p.tickLower) / span));
}

export function PositionCard({ p }: { p: Position }) {
  const chain = CHAIN_BY_KEY[p.chain];
  const pos = rangePosition(p);
  const pair = `${p.token0.symbol} / ${p.token1.symbol}`;

  return (
    <article className="border border-line-soft bg-surface p-5 sm:p-6 flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="eyebrow">{chain.name}</span>
            <span className="eyebrow text-faint">·</span>
            <span className="eyebrow">{p.protocol.toUpperCase()}</span>
            <span className="eyebrow text-faint">·</span>
            <span className="eyebrow">{fmtFee(p.fee)}</span>
            {p.hooks && (
              <>
                <span className="eyebrow text-faint">·</span>
                <span className="eyebrow" title={p.hooks}>hooked</span>
              </>
            )}
          </div>
          <h3 className="display text-2xl sm:text-3xl mt-2">{pair}</h3>
        </div>
        <div className="text-right">
          <div className="eyebrow mb-1">Value</div>
          <div className="display text-2xl sm:text-3xl text-gold tabular">{fmtUsd(p.valueUsd)}</div>
        </div>
      </header>

      <div>
        <div className="flex justify-between text-xs font-mono text-muted mb-2">
          <span>{fmtPrice(p.price.lower)}</span>
          <span className={p.inRange ? "text-positive" : "text-negative"}>
            {p.inRange ? "in range" : "out of range"} · {fmtPrice(p.price.current)} {p.token1.symbol} per {p.token0.symbol}
          </span>
          <span>{fmtPrice(p.price.upper)}</span>
        </div>
        <div className="relative h-1.5 bg-surface-2">
          <div className="absolute inset-y-0 left-0 right-0 bg-line" />
          <div
            className={`absolute -top-1 h-3.5 w-0.5 ${p.inRange ? "bg-gold" : "bg-negative"}`}
            style={{ left: `calc(${pos * 100}% - 1px)` }}
            title="current price"
          />
        </div>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
        <div>
          <dt className="eyebrow mb-1">{p.token0.symbol}</dt>
          <dd className="tabular">{fmtAmount(p.amount0)}</dd>
        </div>
        <div>
          <dt className="eyebrow mb-1">{p.token1.symbol}</dt>
          <dd className="tabular">{fmtAmount(p.amount1)}</dd>
        </div>
        <div>
          <dt className="eyebrow mb-1">Uncollected fees</dt>
          <dd className="tabular">
            {fmtUsd(p.feesUsd)}
            <div className="text-xs text-muted mt-0.5">
              {fmtAmount(p.fees0, p.token0.symbol)} · {fmtAmount(p.fees1, p.token1.symbol)}
            </div>
          </dd>
        </div>
        <div>
          <dt className="eyebrow mb-1">Position</dt>
          <dd>
            <a href={p.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-xs underline decoration-line underline-offset-4">
              #{p.tokenId}
            </a>
          </dd>
        </div>
      </dl>
    </article>
  );
}
