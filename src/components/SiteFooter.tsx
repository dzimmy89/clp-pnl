export function SiteFooter() {
  return (
    <footer className="w-full mt-24">
      <div className="max-w-6xl mx-auto px-4 sm:px-8 pb-10">
        <div className="h-px bg-line-soft" />
        <p className="text-xs text-faint leading-relaxed pt-6 max-w-3xl">
          DeFi University LLC provides educational content only. We do not
          provide financial advice, investment recommendations, or portfolio
          management services. All digital asset education involves high risk.
          Past performance is not indicative of future results. This tool reads
          public on-chain data for the address you enter; nothing is stored.
        </p>
        <div className="flex flex-wrap justify-between gap-4 pt-6">
          <span className="eyebrow">DeFi University LLC</span>
          <a href="https://defiuniversity.xyz" className="eyebrow">
            defiuniversity.xyz
          </a>
          <span className="eyebrow">Education only · not financial advice</span>
        </div>
      </div>
    </footer>
  );
}
