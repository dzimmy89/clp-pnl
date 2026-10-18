import Link from "next/link";
import { cn } from "cn";

export const SITE_NAME = "Omnifolio";
export const SITE_TAGLINE = "Every wallet, one portfolio";

/** Gold ring with a blue core, the same mark as the favicon. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn("size-8", className)}>
      <rect width="64" height="64" rx="14" className="fill-card" />
      <circle cx="32" cy="32" r="17" fill="none" className="stroke-gold" strokeWidth="7" />
      <circle cx="32" cy="32" r="5" className="fill-azure" />
    </svg>
  );
}

/** `compact` drops the name on phones, where the dashboard's top bar needs the room. */
export function BrandLink({ href = "/", compact = false }: { href?: string; compact?: boolean }) {
  return (
    <Link href={href} className="flex items-center gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
      <BrandMark />
      <span className={cn("text-lg font-semibold tracking-tight", compact && "sr-only sm:not-sr-only")}>{SITE_NAME}</span>
    </Link>
  );
}
