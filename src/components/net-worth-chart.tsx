"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatUsd } from "@/lib/format";
import type { HistoryPoint } from "@/lib/history";

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 24, left: 8 };

function dateLabel(t: number, withTime = false): string {
  const d = new Date(t);
  const date = d.toLocaleDateString("en-US", { day: "2-digit", month: "short" });
  return withTime ? `${date} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : date;
}

/** Single-series area chart of net worth over time, with a crosshair tooltip. */
export function NetWorthChart({ points }: { points: HistoryPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    let lo = Math.min(...points.map((p) => p.usd));
    let hi = Math.max(...points.map((p) => p.usd));
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.02 || 1;
    lo -= pad;
    hi += pad;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * (width - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (HEIGHT - PAD.top - PAD.bottom);
    const xy = points.map((p) => [x(p.t), y(p.usd)] as const);
    const line = xy.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
    const base = HEIGHT - PAD.bottom;
    const area = `${line}L${xy[xy.length - 1][0].toFixed(1)},${base}L${xy[0][0].toFixed(1)},${base}Z`;
    const count = width < 480 ? 3 : 5;
    const ticks = Array.from({ length: count }, (_, i) => t0 + ((t1 - t0) * i) / (count - 1));
    return { xy, line, area, ticks, x, base };
  }, [points, width]);

  if (!geometry) {
    return (
      <div ref={ref} className="grid h-[220px] place-items-center rounded-xl border border-dashed border-border text-center text-sm text-muted-foreground">
        <p className="max-w-xs">
          {points.length === 1
            ? `First reading saved ${dateLabel(points[0].t, true)}. The chart fills in each time you open the app.`
            : "Your net worth chart fills in each time you open the app."}
        </p>
      </div>
    );
  }

  const active = hover == null ? null : points[hover];
  const [hx, hy] = hover == null ? [0, 0] : geometry.xy[hover];

  return (
    <div ref={ref} className="relative">
      <svg
        role="img"
        aria-label={`Net worth from ${formatUsd(points[0].usd)} on ${dateLabel(points[0].t)} to ${formatUsd(points[points.length - 1].usd)} on ${dateLabel(points[points.length - 1].t)}`}
        width={width}
        height={HEIGHT}
        className="block touch-none"
        onPointerMove={(event) => {
          const left = event.currentTarget.getBoundingClientRect().left;
          const px = event.clientX - left;
          let best = 0;
          for (let i = 1; i < geometry.xy.length; i++) {
            if (Math.abs(geometry.xy[i][0] - px) < Math.abs(geometry.xy[best][0] - px)) best = i;
          }
          setHover(best);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--azure)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--azure)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={PAD.left} x2={width - PAD.right} y1={geometry.base} y2={geometry.base} stroke="var(--border)" strokeWidth="1" />
        <path d={geometry.area} fill={`url(#${gradient})`} />
        <path d={geometry.line} fill="none" stroke="var(--azure)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {geometry.ticks.map((t, i) => (
          <text
            key={t}
            x={geometry.x(t)}
            y={HEIGHT - 6}
            textAnchor={i === 0 ? "start" : i === geometry.ticks.length - 1 ? "end" : "middle"}
            className="fill-muted-foreground font-mono text-[10px]"
          >
            {dateLabel(t)}
          </text>
        ))}
        {active ? (
          <g>
            <line x1={hx} x2={hx} y1={PAD.top} y2={geometry.base} stroke="var(--muted-foreground)" strokeOpacity="0.5" strokeWidth="1" />
            <circle cx={hx} cy={hy} r="4" fill="var(--azure)" stroke="var(--card)" strokeWidth="2" />
          </g>
        ) : null}
      </svg>
      {active ? (
        <div
          className="pointer-events-none absolute top-0 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(hx - 60, 0), width - 130) }}
        >
          <p className="text-muted-foreground">{dateLabel(active.t, true)}</p>
          <p className="font-mono tabular-nums">{formatUsd(active.usd)}</p>
        </div>
      ) : null}
    </div>
  );
}
