# LP Ledger

PnL, impermanent loss, fees and gas for Uniswap V3 and V4 concentrated liquidity positions, read live from the chain for any wallet address. Built for [DeFi University](https://defiuniversity.xyz).

## Stack

Next.js (App Router) · TypeScript · Tailwind v4 · viem. Deployed on Vercel.

## Develop

```bash
npm install
npm run dev
```

## Chains

Ethereum, Base, Arbitrum, BNB Chain, Robinhood Chain, Arc. Position reading is enabled per chain in `src/lib/chains.ts`.

## Disclaimer

DeFi University LLC provides educational content only. We do not provide financial advice, investment recommendations, or portfolio management services.
