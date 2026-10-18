"use client";

import { useEffect } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "cn";

export default function Error({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <BrandMark className="size-12" />
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground">This page hit an error. Your wallets and account are fine. Try again in a moment.</p>
      <div className="flex gap-2">
        <Button className="rounded-full" onClick={() => retry()}>
          Try again
        </Button>
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "rounded-full")}>
          Home
        </Link>
      </div>
    </main>
  );
}
