import Link from "next/link";
import { ActivityIcon, DropletsIcon, LayersIcon, ShieldCheckIcon } from "lucide-react";
import { BrandLink, SITE_NAME } from "@/components/brand";
import { ConnectWallet } from "@/components/connect-wallet";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";

const PROTOCOLS = [
  { name: "Uniswap V3 & V4", chain: "Ethereum · Base · Arbitrum · BNB · Robinhood · Arc" },
  { name: "Aave", chain: "Ethereum" },
  { name: "Kamino", chain: "Solana" },
  { name: "Hyperlend", chain: "HyperEVM" },
  { name: "Venus", chain: "BNB Chain" },
  { name: "Rhea", chain: "NEAR" },
  { name: "Alpend", chain: "Canton" },
];

const FEATURES = [
  {
    icon: LayersIcon,
    title: "Every chain in one place",
    body: "Link EVM, Solana and NEAR wallets to one account. Paste any other address, including Canton, and it joins the same view.",
  },
  {
    icon: ActivityIcon,
    title: "Lending, liquidity and spot together",
    body: "Supplies, borrows, health factor, Uniswap V3 and V4 positions and wallet balances, priced live and rolled into one net worth. Filter down to a single wallet at any time.",
  },
  {
    icon: DropletsIcon,
    title: "An LP ledger built in",
    body: "Every concentrated-liquidity position read straight from the chain: PnL, impermanent loss, fees earned and gas spent, set against simply holding the tokens.",
  },
  {
    icon: ShieldCheckIcon,
    title: "Read-only by design",
    body: "Signing in is a signed message, not a transaction. It costs no gas, and the app never asks to move your funds.",
  },
];

const STEPS = [
  { title: "Connect a wallet", body: "Pick MetaMask, Rabby, Phantom, Solflare, HOT or Meteor and sign one message. That wallet is your login." },
  { title: "Link the rest", body: "Add your other wallets from any supported chain. They stay on your account for next time." },
  { title: "See the whole book", body: "Positions and balances from every wallet load into one dashboard, refreshed whenever you open it." },
];

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <BrandLink />
          <div className="flex items-center gap-2">
            <Link href="/app" className={cn(buttonVariants({ variant: "ghost" }), "hidden rounded-full sm:inline-flex")}>
              Try the example
            </Link>
            <ConnectWallet size="default" />
          </div>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid w-full max-w-6xl gap-10 px-4 pt-16 pb-12 md:grid-cols-[1.1fr_1fr] md:items-center md:pt-24">
          <div>
            <p className="font-mono text-xs tracking-widest text-azure uppercase">EVM · Solana · NEAR</p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl md:text-6xl">
              Every wallet. <span className="text-gold">One portfolio.</span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-pretty text-muted-foreground">
              {SITE_NAME} reads your lending positions, Uniswap liquidity and spot holdings across chains and puts them in one
              dashboard. Sign in with a wallet. No email, no password, no gas.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ConnectWallet />
              <Link href="/app" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 rounded-full px-5 text-base")}>
                Try the example
              </Link>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 shadow-2xl shadow-black/40" aria-label="Example portfolio">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Example portfolio</span>
              <span className="rounded-full bg-azure/15 px-2 py-0.5 text-azure">4 wallets</span>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">Net worth</p>
            <p className="font-mono text-4xl font-semibold text-gold">$248,310</p>
            <dl className="mt-5 grid grid-cols-3 gap-3 text-sm">
              {[
                ["Supplied", "$312,400"],
                ["Borrowed", "$96,550"],
                ["Health", "2.41"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-muted/60 p-3">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-mono font-medium">{value}</dd>
                </div>
              ))}
            </dl>
            <ul className="mt-5 grid gap-2 text-sm">
              {[
                ["Aave", "Ethereum", "$142,900"],
                ["Kamino", "Solana", "$61,200"],
                ["Uniswap V3", "Base", "$23,700"],
                ["Spot", "All chains", "$20,510"],
              ].map(([name, chain, value]) => (
                <li key={name} className="flex items-center justify-between rounded-xl border border-border/70 px-3 py-2">
                  <span>
                    {name} <span className="text-muted-foreground">· {chain}</span>
                  </span>
                  <span className="font-mono">{value}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 py-12">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-2xl border border-border bg-card p-6">
                <Icon className="size-5 text-gold" aria-hidden />
                <h2 className="mt-4 font-semibold">{title}</h2>
                <p className="mt-2 text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 py-12">
          <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          <ol className="mt-6 grid gap-4 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li key={step.title} className="rounded-2xl border border-border p-6">
                <span className="grid size-8 place-items-center rounded-full bg-gold font-mono text-sm font-semibold text-primary-foreground">
                  {i + 1}
                </span>
                <h3 className="mt-4 font-semibold">{step.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 py-12">
          <h2 className="text-2xl font-semibold tracking-tight">Protocols it reads</h2>
          <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {PROTOCOLS.map((p) => (
              <li key={p.name} className="rounded-xl border border-border bg-card px-4 py-3">
                <p className="font-medium">{p.name}</p>
                <p className="text-xs text-azure">{p.chain}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mx-auto w-full max-w-6xl px-4 pt-6 pb-20">
          <div className="flex flex-col items-start gap-5 rounded-2xl border border-gold/30 bg-gold/5 p-8 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">See all your positions in one place</h2>
              <p className="mt-2 text-muted-foreground">One signature to start. Nothing leaves your wallet.</p>
            </div>
            <ConnectWallet />
          </div>
        </section>
      </main>

      <footer className="border-t border-border/70">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground">
          <span>
            © {new Date().getFullYear()} {SITE_NAME}
          </span>
          <span>Read-only. {SITE_NAME} never asks to move your funds.</span>
          <span className="w-full text-xs">
            DeFi University LLC provides educational content only. We do not provide financial advice, investment recommendations, or portfolio
            management services. All digital asset education involves high risk. Past performance is not indicative of future results.
          </span>
        </div>
      </footer>
    </div>
  );
}
