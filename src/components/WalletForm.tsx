"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { isAddress } from "viem";

export function WalletForm({ initial = "" }: { initial?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const addr = value.trim();
    if (!isAddress(addr)) {
      setError("That does not look like an EVM address (0x followed by 40 hex characters).");
      return;
    }
    setError(null);
    router.push(`/w/${addr}`);
  }

  return (
    <form onSubmit={submit} className="w-full">
      <label htmlFor="wallet" className="eyebrow block mb-3">
        Wallet address
      </label>
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          id="wallet"
          name="wallet"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-surface border border-line px-4 py-3 font-mono text-sm text-foreground placeholder:text-faint focus:outline-none focus:border-gold"
        />
        <button
          type="submit"
          className="eyebrow bg-gold text-[var(--charcoal)] px-6 py-3 hover:opacity-90 transition-opacity"
        >
          Read positions
        </button>
      </div>
      {error ? (
        <p className="text-negative text-sm mt-3">{error}</p>
      ) : (
        <p className="text-faint text-sm mt-3">
          Read-only. Any address works; no wallet connection or signature is needed.
        </p>
      )}
    </form>
  );
}
