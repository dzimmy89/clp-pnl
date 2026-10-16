import Link from "next/link";
import { Keystone, Wordmark } from "./Keystone";
import { ThemeToggle } from "./ThemeToggle";

export function SiteHeader() {
  return (
    <header className="w-full">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 pt-6">
        <div className="hairline" />
        <div className="flex items-center justify-between py-5">
          <Link href="/" className="flex items-center gap-3">
            <Keystone size={34} />
            <Wordmark />
          </Link>
          <div className="flex items-center gap-6">
            <span className="eyebrow hidden sm:inline">LP Ledger</span>
            <ThemeToggle />
          </div>
        </div>
        <div className="h-px bg-line-soft" />
      </div>
    </header>
  );
}
