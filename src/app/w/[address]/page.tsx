import { notFound } from "next/navigation";
import { isAddress } from "viem";
import { ChainTabs } from "@/components/ChainTabs";
import { WalletForm } from "@/components/WalletForm";
import { CHAINS } from "@/lib/chains";

export const instant = false;

export default async function WalletPage({
  params,
}: PageProps<"/w/[address]">) {
  const { address } = await params;
  if (!isAddress(address)) notFound();

  const short = `${address.slice(0, 6)}…${address.slice(-4)}`;

  return (
    <div className="py-12 sm:py-16">
      <p className="eyebrow mb-4">Wallet</p>
      <h1 className="display text-4xl sm:text-6xl break-all">
        <span className="font-mono text-2xl sm:text-3xl tracking-normal">{address}</span>
      </h1>

      <div className="mt-10">
        <ChainTabs />
      </div>

      <div className="hairline mt-14" />

      <div className="mt-10 border border-line-soft p-8 sm:p-12 text-center">
        <p className="eyebrow mb-4">Positions</p>
        <p className="display text-3xl sm:text-4xl">
          Position reading lands in the next step.
        </p>
        <p className="text-muted mt-4 max-w-xl mx-auto leading-relaxed">
          This page will list every Uniswap V3 and V4 position {short} owns on{" "}
          {CHAINS.filter((c) => c.chainId).map((c) => c.name).join(", ")}, with
          live value, fees and range status.
        </p>
      </div>

      <div className="mt-14 max-w-3xl">
        <p className="eyebrow mb-4">Look up a different address</p>
        <WalletForm />
      </div>
    </div>
  );
}
