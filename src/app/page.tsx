import { ChainTabs } from "@/components/ChainTabs";
import { WalletForm } from "@/components/WalletForm";

const METRICS = [
  ["Net PnL", "Position value plus fees collected, minus deposits and gas."],
  ["Impermanent loss", "What the position is worth against simply holding the deposited tokens."],
  ["Fees earned", "Collected and still-uncollected fees, per position and in total."],
  ["Gas spent", "Every mint, add, remove and collect, priced at the time it happened."],
  ["Range status", "In range or out, and how far price sits from each bound."],
  ["APR", "Fee yield annualised over the position's life so far."],
];

export default function Home() {
  return (
    <div className="py-16 sm:py-24">
      <p className="eyebrow mb-6">01 · Concentrated liquidity ledger</p>
      <h1 className="display text-5xl sm:text-7xl max-w-3xl">
        Know what your <span className="text-gold italic">liquidity</span> is
        really earning.
      </h1>
      <p className="text-muted text-lg mt-8 max-w-2xl leading-relaxed">
        Paste any wallet address. We read its Uniswap V3 and V4 positions
        straight from the chain and work out PnL, impermanent loss, fees and
        gas, then set it all against simply holding the tokens.
      </p>

      <div className="mt-12 max-w-3xl">
        <WalletForm />
      </div>

      <div className="mt-10">
        <p className="eyebrow mb-3">Chains</p>
        <ChainTabs />
      </div>

      <div className="hairline mt-20" />
      <p className="eyebrow mt-10 mb-8">02 · What you will see</p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-line-soft border border-line-soft">
        {METRICS.map(([title, body]) => (
          <div key={title} className="bg-background p-6">
            <dt className="display text-2xl text-gold">{title}</dt>
            <dd className="text-muted text-sm mt-3 leading-relaxed">{body}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
