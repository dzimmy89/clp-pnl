"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, WalletIcon } from "lucide-react";
import { useAccount } from "@/lib/account";
import { WalletDialog } from "@/components/wallet-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "cn";

/**
 * Landing-page call to action. Signed out: opens the wallet picker and goes to the app
 * once signed in. Signed in, or no database on the server: goes straight to the app.
 */
export function ConnectWallet({ size = "lg", className }: { size?: "default" | "lg"; className?: string }) {
  const { account, accountsEnabled, loading } = useAccount();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const classes = cn("rounded-full", size === "lg" && "h-11 px-5 text-base", className);

  if (!loading && (account || !accountsEnabled)) {
    return (
      <Link href="/app" className={cn(buttonVariants({ size: "lg" }), classes)}>
        Open app <ArrowRightIcon />
      </Link>
    );
  }

  return (
    <>
      <Button size="lg" className={classes} disabled={loading} onClick={() => setOpen(true)}>
        <WalletIcon /> Connect wallet
      </Button>
      <WalletDialog open={open} onOpenChange={setOpen} intent="signin" onSignedIn={() => router.push("/app")} />
    </>
  );
}
