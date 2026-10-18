import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <BrandMark className="size-12" />
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-muted-foreground">That page doesn&apos;t exist. Your portfolio is one click away.</p>
      <div className="flex gap-2">
        <Link href="/app" className={cn(buttonVariants(), "rounded-full")}>
          Open app
        </Link>
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }), "rounded-full")}>
          Home
        </Link>
      </div>
    </main>
  );
}
