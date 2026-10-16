/**
 * The DeFi University "Keystone" mark: an arch of stones with a single gold
 * keystone at the top. Stones take the current foreground colour; only the
 * keystone is gold. Never recolour the stones, add gradients or round corners.
 */
const STONE_ANGLES = [-72, -48, -24, 24, 48, 72];

export function Keystone({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size * 0.9}
      viewBox="0 0 120 108"
      fill="none"
      aria-hidden="true"
    >
      {/* keystone */}
      <rect x="49" y="2" width="22" height="20" fill="var(--gold)" />
      {/* voussoirs rotated around the arch centre */}
      {STONE_ANGLES.map((a) => (
        <rect
          key={a}
          x="50"
          y="4"
          width="20"
          height="18"
          fill="currentColor"
          transform={`rotate(${a} 60 62)`}
        />
      ))}
      {/* pillars */}
      <rect x="4" y="60" width="18" height="46" fill="currentColor" />
      <rect x="98" y="60" width="18" height="46" fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`display uppercase tracking-[0.28em] text-sm sm:text-base ${className}`}
    >
      DeFi University
    </span>
  );
}
