import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { PositionsPanel } from "@/components/PositionsPanel";
import { WalletForm } from "@/components/WalletForm";

export const instant = false;

export default async function WalletPage({
  params,
}: PageProps<"/w/[address]">) {
  const { address } = await params;
  if (!isAddress(address)) notFound();
  const checksummed = getAddress(address);

  return (
    <div className="py-12 sm:py-16">
      <p className="eyebrow mb-4">Wallet</p>
      <h1 className="font-mono text-xl sm:text-3xl break-all">{checksummed}</h1>

      <div className="hairline mt-10" />

      <div className="mt-10">
        <PositionsPanel key={checksummed} address={checksummed} />
      </div>

      <div className="mt-20 max-w-3xl">
        <p className="eyebrow mb-4">Look up a different address</p>
        <WalletForm />
      </div>
    </div>
  );
}
