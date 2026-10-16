/**
 * The DeFi University "Keystone" mark: an arch of stones with a single gold
 * keystone at the top. Stones take the current foreground colour; only the
 * keystone is gold. Never recolour the stones, add gradients or round corners.
 */
export function Keystone({ size = 40 }: { size?: number }) {
  const stone = "currentColor";
  const gold = "var(--gold)";
  return (
    <svg
      width={size}
      height={size * 0.9}
      viewBox="0 0 120 108"
      fill="none"
      aria-hidden="true"
    >
      {/* keystone */}
      <path d="M50 2 L70 2 L74 20 L46 20 Z" fill={gold} />
      {/* right stones */}
      <path d="M78 22 L95 10 L104 26 L86 36 Z" fill={stone} />
      <path d="M90 40 L107 31 L114 50 L96 55 Z" fill={stone} />
      <rect x="98" y="60" width="18" height="46" fill={stone} />
      {/* left stones */}
      <path d="M42 22 L25 10 L16 26 L34 36 Z" fill={stone} />
      <path d="M30 40 L13 31 L6 50 L24 55 Z" fill={stone} />
      <rect x="4" y="60" width="18" height="46" fill={stone} />
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
