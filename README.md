# Omnifolio

Every wallet, one portfolio. Connect EVM, Solana and NEAR wallets and see every lending position, every Uniswap V3 and V4 liquidity position and every spot balance in one dashboard. Built for [DeFi University](https://defiuniversity.xyz).

This repository is the merge of two apps: **Omnifolio** (the multi-chain portfolio tracker and leverage desk) and **LP Ledger** (the Uniswap concentrated-liquidity PnL reader, `clp-pnl`). The LP reader lives in `src/lib/lp`, joins the book as the `uniswap` protocol, and has its own **Liquidity** tab.

`/` is the landing page; the dashboard lives at `/app`. It deploys to Google Cloud Run straight from this GitHub repository (see **Deploy**).

## What it reads

Paste addresses, or sign in with a wallet to keep them on an account. Every wallet is read and merged into one book, so net worth, per-asset exposure, BTC beta, alerts and the net worth chart all include every position together.

| Protocol | Chain | Read |
| --- | --- | --- |
| Uniswap V3 and V4 liquidity | Ethereum, Base, Arbitrum, BNB Chain, Robinhood Chain, Arc | Live, position managers and pools over JSON-RPC (`ALCHEMY_API_KEY` recommended) |
| Aave | Ethereum | Live, Aave v3 GraphQL |
| Kamino Finance | Solana | Live, main market on `api.kamino.finance` |
| Hyperlend | HyperEVM | Live, Aave v3-style pool over the public HyperEVM RPC |
| Venus Protocol | BNB Chain | Live, Venus API plus on-chain vToken balances |
| Rhea Finance | NEAR | Live, Burrow account API (Rhea still serves it) |
| Alpend | Canton | Manual only. No public position API |
| GMX V2 perpetuals | Arbitrum | Live, positions straight from the GMX DataStore over the public Arbitrum RPC (`ARBITRUM_RPC_URL` overrides) |

With `ZERION_API_KEY` set, each EVM wallet is also read through the Zerion API: token balances and DeFi positions (lending, staking, liquidity pools, vaults, rewards) on every EVM chain Zerion indexes, grouped into one row per app and chain (one per pool for LPs). Solana wallets get balances from Zerion; Zerion has no Solana protocol positions yet, so Kamino stays a direct read. Aave on Ethereum, Venus on BNB Chain, Hyperlend, and Uniswap V3/V4 on the chains the direct reader covers keep their direct readers, and Zerion's copy of them is dropped so nothing counts twice. Zerion reports no APYs, so those rows show "—" and estimated health, and they are left out of blended APY.

GMX perps are not tokens, so Zerion only sees GM pool tokens and rewards. Each open long or short is read from the GMX DataStore instead and shown as a book: the position size as a leg in the index asset (supplied for a long, borrowed for a short), the entry notional as a USD leg, and the collateral as a supply, so equity is collateral plus unrealised PnL. Health is collateral plus PnL over GMX's maintenance collateral (its `minCollateralFactor` share of size, before fees, funding and price impact), and the liquidation price is where that reaches 1, which the joint-move solve recovers exactly for both sides. Prices come from GMX's own oracle tickers with DefiLlama as the fallback.

Wallets on other chains are read by one reader per chain (`src/lib/adapters/chains/`), each returning balances plus app positions. A failing app becomes a note on that chain's row in Wallets; the rest still loads.

| Chain | Balances | Apps and positions |
| --- | --- | --- |
| Solana | Zerion or RPC (above) | Kamino (direct), marginfi, Drift, Save, Jupiter Lend Earn, native SOL staking |
| Sui | Sui JSON-RPC | Suilend, NAVI, Scallop, native staking |
| Aptos | Aptos indexer | Aries, Echelon, delegated staking |
| TON | tonapi (toncenter fallback) | EVAA, STON.fi liquidity, nominator pools |
| Tron | TronGrid | JustLend DAO, Stake 2.0, voting rewards |
| Cosmos | cosmos.directory REST, 13 chains from one address | Staking, unbonding, rewards |
| Starknet | Starknet RPC | Vesu, Nostra |
| Cardano | Koios | Delegation and rewards |
| Kaspa | api.kaspa.org | KRC-20 tokens (Kasplex) |

Prices for these come from DefiLlama. Optional keys raise free-tier rate limits: `TONAPI_KEY`, `TONCENTER_API_KEY`, `TRONGRID_API_KEY`, `APTOS_API_KEY`, `KOIOS_API_KEY`, `JUPITER_API_KEY`. RPC overrides: `SOLANA_RPC_URL`, `SUI_RPC_URL`, `STARKNET_RPC_URL`.

If a live call fails, that protocol shows the error and the rest of the desk keeps working. Add the book by hand. Example positions are labeled and never mix into Live totals.

## Uniswap liquidity (the LP Ledger)

Every EVM wallet on the book is read for open Uniswap V3 and V4 positions on Ethereum, Base, Arbitrum, BNB Chain, Robinhood Chain and Arc (`src/lib/lp/chains.ts` lists the contracts, from Uniswap's deployment pages). V3 positions are enumerated from the NonfungiblePositionManager; V4's PositionManager is a plain ERC-721, so its positions are discovered from Transfer logs and confirmed with `ownerOf`, which needs an RPC that allows wide log queries: set `ALCHEMY_API_KEY` (Ethereum, Base, Arbitrum, BNB Chain) or a per-chain `RPC_URL_<CHAIN>`. Amounts, uncollected fees and the pool price come from exact BigInt ports of the Uniswap tick and fee-growth math (`src/lib/lp/uniswap/math.ts`, unit tested). USD prices come from DefiLlama, with the other side of a pool inferred through the pool price when one side is a stablecoin.

Each position is one **liquidity** row in the book (app "Uniswap V3" or "Uniswap V4", one supply leg per token, uncollected fees included), so it counts in net worth, the per-asset breakdown, BTC delta and beta, the wallet filter and the CSV export like any other position. The **Liquidity** tab shows the LP detail: value, uncollected fees, the price range with where the pool price sits, and for each position its history read from the position manager's events (V3: IncreaseLiquidity, DecreaseLiquidity and Collect; V4: the PoolManager's ModifyLiquidity events, with amounts recomputed from the pool price at that block and fees measured from the token transfers out of the PoolManager), priced at the time with DefiLlama:

- Net PnL = current value + uncollected fees + withdrawals + fees collected − deposits − gas
- HODL value = the net deposited tokens valued at today's prices; impermanent loss = current principal value − HODL value
- vs. holding = net PnL − HODL PnL (= total fees + impermanent loss − gas)
- Fee APR = total fees ÷ deposits, annualised over the position's age

Gas counts every mint, add, remove and collect, once per transaction, including the L1 data fee on Base. History is read once per position and reused for ten minutes (or until its liquidity changes); PnL is recomputed against every live refresh. `POST /api/lp/history` and `GET /api/lp/positions?address=&chain=` expose the same reads for scripts.

## Run

```bash
npm install
npm run dev
```

The dev server listens on `0.0.0.0:43127`. Open `http://127.0.0.1:43127`. Copy `.env.example` to `.env.local` for keys.

```bash
npm test        # unit tests: leverage, hedge, BTC delta, net APY, price shocks, alerts, Uniswap math and PnL
npm run lint
npm run build
```

## Layout

Five tabs, black with gold and blue: gold marks headline numbers and debt, blue marks supply. The interface was audited against the [UI/UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) rule set; `docs/ui-ux-review.md` records what passed, what changed and what was deliberately kept.

- **Overview**: net worth, supplied, borrowed, lowest health factor and net APY across every wallet; your supplies and your borrows side by side; every app position (Uniswap pools included) by app; spot holdings.
- **Portfolio**: net worth over time (7D, 30D, 90D, All), borrowing power used, liquidation prices, a per-asset breakdown, the lending position cards with hedge targets, the price-shock scenario and alerts.
- **Liquidity**: the Uniswap V3 and V4 positions in view with PnL, impermanent loss, fees, gas, fee APR and the transaction list per position.
- **Advisor**: sized changes to reach your health, leverage, hedge and BTC beta targets.
- **Wallets**: the account's wallets (label, remove, link another, sign out), pasted addresses, balances entered by hand, and each protocol's read status.

The net worth chart has no indexer behind it. Each time the live book loads, the app saves a reading (at most one per 15 minutes) for the whole book and for each wallet, so the chart starts empty and fills in as you use the app. Readings are kept in the browser, and on the account when signed in (`/api/account/history`). The example book shows a fixed illustrative series.

## Wallet accounts

Connect a wallet on EVM (MetaMask, Rabby and other injected wallets), Solana (Phantom, Solflare, Backpack) or NEAR (HOT, Meteor, Intear, MyNearWallet via NEAR Connect) and sign one message. The first sign-in creates an account; the same wallet signs you back in. There is no email or password. Once signed in, link wallets on other chains to the same account; any linked wallet can sign in.

The message is a login proof, not a transaction: EVM uses Sign-In with Ethereum (EIP-4361), Solana signs the same text with the wallet key, and NEAR uses NEP-413 and checks that the key is a full-access key of the account. Every message names the site's host and carries a single-use server nonce that expires after 10 minutes. Canton has no browser wallet, so Alpend stays paste-in.

Every wallet on the account is read and merged into one book, together with any address pasted on this device. Live mode shows a wallet row above the totals: "All wallets" with the combined net value, then one chip per wallet (net value = supplied − borrowed + spot). Pick a chip to narrow every number, position and spot row to that wallet; manual books only show under "All wallets". The book API takes repeated keys, e.g. `/api/book?evm=0xa&evm=0xb&solana=…`, up to 12 wallets per chain.

Signed in, the account also keeps the rest of the desk (`/api/account/desk`): pasted addresses, manual books, balances entered by hand, hedge and leverage targets, alert thresholds and Advisor goals, plus net worth history. Every edit is saved to the account, and signing in on another device loads it. The first time a browser meets an account, anything that browser already had is merged in rather than dropped. Signing out clears the account's data from that browser.

Wallets with no public balance read (Canton, for one) can be entered under Wallets → Balances entered by hand: chain, wallet or party id, token, class, amount and USD price. Leave the price blank and it follows the market price for the token's ticker (`/api/prices`: known tickers map to a CoinGecko id and wrapped tickers such as CBTC or WETH to their base asset, dollar stables read $1, any other ticker is looked up with CoinGecko search, taking the largest coin by market cap with that exact ticker, and DefiLlama supplies the price). Prices refresh on load, on each book refresh and every five minutes, and the last price found is kept if a lookup fails. Type a price to fix it instead. They count in net worth, spot holdings, BTC beta and the Advisor, under "All wallets". Alpend positions are entered as manual books, whose legs price the same way: leave a leg's price blank to follow the market, or type one to fix it.

To track addresses without linking them, paste any number at once in Wallets → Track addresses without linking (one per line, or separated by commas or spaces). Each address's chain is detected from its format (`src/lib/address-detect.ts`): 0x + 40 hex is EVM, base58 decoding to 32 bytes is Solana and to a 0x41-prefixed 25 bytes is Tron, `*.near`/`*.tg` or 64 hex is NEAR, `EQ…`/`UQ…` or `0:<hex>` is TON, `addr1…`/`stake1…` is Cardano, `kaspa:…` is Kaspa, other bech32 is Cosmos, and `::` marks a Canton party. 0x + 64 hex fits Sui, Aptos and Starknet, so the app asks which; `aptos:0x…` picks the chain up front. Pasted addresses, with optional labels, stay in this browser.

Accounts need Postgres. Set `DATABASE_URL` (any Postgres, e.g. a free Neon database) in `.env.local`; tables are created on first use. Without it the rest of the desk works and the sign-in button reads "Accounts unavailable". In production the signed message must name the public host, and pinning it stops a request with a forged `Host` header from accepting a signature another site collected. Set `AUTH_DOMAIN` to the public host (e.g. `omnifolio.xyz`); `deploy/gcp-setup.sh` sets it to the Cloud Run host for you.

## Deploy (Google Cloud Run, from GitHub)

The app runs as one Cloud Run service built from the `Dockerfile` (Next.js standalone output, listens on `$PORT`), with Postgres on Cloud SQL and keys in Secret Manager. CI builds the same image on every push and checks that it starts and serves `/`, `/app` and `/api/health`, so what reaches Google Cloud is already known to run. Pick one of the four paths; they all end in the same service.

### A. The Cloud Run console, no CLI

1. In [Cloud Run](https://console.cloud.google.com/run), **Deploy container → Service → Continuously deploy from a repository (source or function)**, then **Set up with Cloud Build**.
2. Connect GitHub and pick `dzimmy89/clp-pnl`, the branch to deploy (`main`), build type **Dockerfile**, location `/Dockerfile`.
3. Allow unauthenticated invocations, 1 vCPU, 1 GiB, request timeout 300 s, max instances 3.
4. Under **Variables & Secrets** add `AUTH_DOMAIN` (the service's host once known, e.g. `omnifolio-xxxx-uc.a.run.app`), and reference secrets for `DATABASE_URL`, `ZERION_API_KEY`, `ALCHEMY_API_KEY`, `OWNER_WALLETS` (create them in Secret Manager first; `.env.example` lists every name). Under **Connections** attach the Cloud SQL instance when the database is Cloud SQL.

Every push to that branch then builds and deploys. `deploy/gcp-setup.sh` can still be run afterwards to create the database and secrets for you.

### B. The button

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/dzimmy89/clp-pnl)

Opens Cloud Shell signed in as you (`hello@defiuniversity.xyz`), asks for the project, region and the keys in `app.json`, builds the `Dockerfile` and deploys. Its post-create step runs `deploy/gcp-setup.sh` with `SKIP_BUILD=1` to add the secrets (the database URL included), the runtime service account, the `AUTH_DOMAIN` pin and the Cloud Build trigger. To deploy a branch other than `main`, add `&revision=<branch>` to the button URL.

### C. The script

From a machine with the [gcloud CLI](https://cloud.google.com/sdk/docs/install), signed in as the project owner:

```bash
gcloud auth login hello@defiuniversity.xyz
# A project to deploy into (create one if needed and link billing):
gcloud projects create defi-university-omnifolio --name="Omnifolio"

PROJECT_ID=defi-university-omnifolio \
BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX \
ZERION_API_KEY=... ALCHEMY_API_KEY=... \
OWNER_WALLETS=0xYourWallet,YourSolanaWallet \
./deploy/gcp-setup.sh
```

The script (safe to run again) links billing and adds a budget with email alerts at 10%, 50% and 100% of `BUDGET_USD` (default $15) when `BILLING_ACCOUNT` is set, enables the APIs, creates an Artifact Registry repository that keeps only the newest three images, creates a Cloud SQL Postgres 16 `db-f1-micro` instance with daily backups (about $10 a month; pass `DATABASE_URL` to use another Postgres instead), stores every key you exported as a secret, creates the runtime service account, builds and deploys the service with `cloudbuild.yaml`, pins `AUTH_DOMAIN` to the service's host, and creates the Cloud Build trigger on `main` (`BRANCH=` picks another). The trigger needs the Cloud Build GitHub App connected to `dzimmy89/clp-pnl`; if it is not yet, the script prints the console link, and running it again finishes the step.

To bring accounts across from an old database (the earlier Neon one, for example), run this once after the setup, before signing in. It replaces the tables on Cloud SQL with the old database's:

```bash
SOURCE_DATABASE_URL='postgresql://...' PROJECT_ID=defi-university-omnifolio ./deploy/gcp-import-db.sh
```

### D. GitHub Actions

`.github/workflows/deploy.yml` builds and deploys through Cloud Build on every push to `main` (and on demand from the Actions tab) using the repository's own GitHub identity, so no key is stored. After path C, run once:

```bash
PROJECT_ID=defi-university-omnifolio ./deploy/gcp-github-actions.sh
```

It creates a deployer service account and a Workload Identity pool restricted to this repository and prints the three secrets to add (`GCP_PROJECT_ID`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`). Until they exist the workflow skips itself. Optional repository variables: `GCP_REGION`, `CLOUD_RUN_SERVICE`, `ARTIFACT_REPOSITORY`, `WALLETCONNECT_PROJECT_ID`.

### After the first deploy

Check `https://<service>.run.app/api/health`: it reports the database, the sign-in host, whether Zerion and Alchemy keys are present, and the platform. Secrets the service reads (all optional except the database): `DATABASE_URL`, `ZERION_API_KEY`, `ALCHEMY_API_KEY`, `COINGECKO_API_KEY`, `OWNER_WALLETS`, `OWNER_READ_TOKEN`, the per-source keys and RPC overrides listed in `.env.example`. Add or rotate one later with:

```bash
printf '%s' "$KEY" | gcloud secrets versions add ZERION_API_KEY --data-file=-
gcloud run services update omnifolio --region=us-central1 --update-secrets=ZERION_API_KEY=ZERION_API_KEY:latest
```

A custom domain: map it in Cloud Run (`gcloud beta run domain-mappings create --service omnifolio --domain portfolio.defiuniversity.xyz --region us-central1`, then add the DNS records it prints) and set `AUTH_DOMAIN` to it (`--update-env-vars=AUTH_DOMAIN=portfolio.defiuniversity.xyz`), since the signed-in message must name the host the browser is on. `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is inlined at build time, so it is a Cloud Build substitution (`_WALLETCONNECT_PROJECT_ID`) rather than a runtime secret; the console path (A) has no build arguments, so the WalletConnect button stays off there.

A free `*.web.app` address in front of the service: `firebase.json` sends every path on a Firebase Hosting site to the Cloud Run service (edit `serviceId` if you renamed it). Run `firebase projects:addfirebase <project>`, `firebase hosting:sites:create <site> --project <project>`, `firebase target:apply hosting app <site> --project <project>` and `firebase deploy --only hosting:app --project <project>`, then set `AUTH_DOMAIN=<site>.web.app`. Firebase Hosting forwards only the `__session` cookie, which is the name the app uses, and it cuts requests off at 60 seconds, so a first read of a wallet with many Uniswap V4 positions can time out there while the `run.app` address keeps the 300 s limit. Firebase Hosting also takes a custom domain with free certificates, in any region.

Cost: Cloud SQL `db-f1-micro` is the one bill, about $10 a month with its backups. Everything else stays in the free tier: Cloud Run's (2 million requests, 180,000 vCPU-seconds and 360,000 GiB-seconds a month) covers one person's use while instances scale to zero; builds run on the default `e2-standard-2` machine, the one the 2,500 free Cloud Build minutes cover; Artifact Registry keeps three images inside its free 0.5 GB; Secret Manager is free for six active secret versions, a few cents a month per extra one. A minimum instance above 0, `--no-cpu-throttling` or a bigger Cloud SQL tier would each add to the bill.

Resources: 1 vCPU, 1 GiB, 0 to 3 instances, 300 s request timeout (a wallet with many V4 positions can take a while on first read). Sign-in and book endpoints are rate limited per IP in memory, per instance, and every response carries basic security headers (`next.config.ts`).

### Settings

Each is a Secret Manager secret on the service (see above to add or rotate one):

- `ZERION_API_KEY` (free key from dashboard.zerion.io): every EVM chain and protocol.
- `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (free at cloud.reown.com): the WalletConnect button for phone wallets. It is baked in at build time, so it is the `_WALLETCONNECT_PROJECT_ID` Cloud Build substitution, not a secret.
- `COINGECKO_API_KEY` (free demo key from coingecko.com/en/api): set it if live prices for hand-entered tokens come back missing, since CoinGecko rate-limits keyless search from shared cloud hosts.
- `OWNER_WALLETS`: your wallet addresses, separated by commas, to make the site yours alone. Only those wallets can sign in, other accounts count as signed out, and the book, price and beta endpoints answer only the owner, so nobody else can use your Zerion key. Once signed in you can still link any other wallet. Leave it empty to keep the site open.
- `OWNER_READ_TOKEN` (24+ random characters, with `OWNER_WALLETS` set): lets a script read your whole book, risk figures included, from `GET /api/owner/book` with `Authorization: Bearer <token>`.

The database connection uses `prepare: false`, so a pooled (PgBouncer) connection string works too.

## Formulas

Equity = Σ supply USD − Σ borrow USD. If equity is at or below zero the book is underwater: leverage and net APY are not computed.

- Leverage = Σ supply USD / equity
- Hedge ratio for an underlying = volatile units borrowed / volatile units supplied of that same underlying. Stables are not hedge notionals.
- Notional hedge = Σ volatile borrow USD / Σ volatile supply USD
- Net units of an asset = supply amount − borrow amount
- BTC delta = Σ net units. WBTC, cbBTC, tBTC, BTCB, UBTC, and CBTC count 1:1 as BTC. Other volatile assets convert as net units × price / BTC price. Stables are left out.
- Position net APY = (Σ supply USD × supply APY − Σ borrow USD × borrow APY) / equity. APYs are decimals in the math and percents on screen.
- Blended net APY = Σ position net income / Σ equity, using only books with equity above zero.
- Blended leverage = Σ supply USD / Σ equity for those same books. Underwater books are listed and excluded.

A price shock multiplies that asset's supply USD and borrow USD by `1 + shock`. Stables stay put unless you type a shock for them. Token amounts do not change, so a same-asset unit hedge is unchanged. APYs are held constant and are not repriced. PnL is new equity minus old equity.

Health factor is estimated as Σ (collateral USD × liquidation threshold) / Σ borrow USD. Aave, Kamino, and Hyperlend show the protocol figure when the adapter returns one; Venus, Rhea and Zerion-read books are estimated. Positions without a published threshold use 75% (78% for BTC-like collateral, 80% for stables) and the position note says so. Where a protocol reports a health factor, the thresholds are scaled so the estimate meets it (scale = reported ÷ estimated), which folds in e-mode and thresholds the reader never saw; the liquidation price, the health factor after a shock and the borrowing-power limit all use that scale, so they agree with the figure the protocol shows.

Liquidation price moves every crypto asset in the book together, supplied and borrowed alike, by the same fraction while stables stay at their marks. With k the multiplier on every crypto price, Wv and Dv the crypto collateral (weighted by its scaled thresholds) and crypto debt at today's marks, and Ws and Ds the same for stables, the line is k·Wv + Ws = k·Dv + Ds, so k = (Ds − Ws) / (Wv − Dv); each crypto asset's liquidation price is today's price × k. A net long (Wv > Dv) is liquidated by a fall, a net short by a rise, and a book whose crypto borrows are covered by its crypto supplies with stables covering the rest has no move that liquidates it; the Portfolio tab says so and shows its health factor, which that move does not change. Units borrowed move with their price just as units supplied do, which is why a same-asset borrow nets out instead of counting as fixed debt, and why a book supplying ETH and BTC against ETH, BTC and stable debt is liquidated by crypto falling together long before either asset alone reaches its single-asset line. That single-asset line (the main asset moving with everything else held, P = (Do − Wo) / (S·lt − B)) is shown as "alone" beside the joint figure when the book holds more than one crypto asset, and for a staked or wrapped token against its base asset it is the depeg case; alerts use whichever line is nearer.

## BTC beta and the Advisor

BTC beta of an asset = cov(asset, BTC) / var(BTC) over 90 days of daily log returns from DefiLlama (`/api/betas`, cached 6 hours). BTC-like assets are 1 and stables 0 by definition, staked tokens (stETH, JitoSOL, haSUI…) use their base asset, and an asset with no history is assumed to be 1 and marked with `*`.

- Beta-weighted USD = Σ net USD of each asset × its beta. Beta-weighted BTC = that ÷ BTC price.
- Position or portfolio BTC beta = beta-weighted USD ÷ equity (or net worth): how many percent it moves for a 1% BTC move.

The Advisor tab turns your goals into sized changes, each with before and after values recomputed on the changed legs. A protocol-reported health factor is kept on its own scale by multiplying it by the change in the estimated one.

- Health under target T: repay x = D − W/T, or add collateral y = (T·D − W)/lt, or sell collateral to repay x = (T·D − W)/(T − lt), where W is Σ collateral × liquidation threshold and D is debt.
- Leverage to target L: sell collateral and repay x = S − L·E (equity unchanged), or borrow and resupply.
- Hedge to target h: borrow h × supplied units − borrowed units of the collateral asset, sell it, repay stable debt and supply any rest as stables.
- Portfolio beta to target b: change beta-weighted USD by (b − current) × net worth, by trimming the highest-beta wallet balance, borrowing BTC against stables, or shorting BTC.
- Portfolio leverage to target: unwind the most levered positions first, none below the target.

Goals and per-position targets are kept in this browser.

## Alerts

Checked on each refresh, against thresholds stored in the browser:

- Health factor under 1.50 (warning) or 1.20 (critical): add collateral or repay
- Net APY under your minimum (default 0): carry has flipped
- Leverage above your maximum (default 3.5×)
- Hedge ratio farther than your tolerance (default 0.05) from the per-position target
- Spot within your proximity (default 15%) of the estimated liquidation price

Each alert names the position, the breach, and one action.

The tab title carries the alert count for the whole book, e.g. `(2!) Dashboard · Omnifolio`
(`!` when one is critical). The bell in the top bar turns on browser notifications for alerts
that start firing after the page opened; they need the page open, so turning them on also keeps
auto-refresh running in a background tab.

## Viewing options

Saved per browser in `hedge-ledger.prefs.v1`, never on the account:

- **Auto-refresh**: re-reads every wallet every 5 minutes while the page is open (the Auto box next to Refresh).
- **Hide amounts** (eye icon): dollar values and token amounts show as dots for screen sharing; prices, rates and health factors stay visible.
- **Hide small balances**: spot balances under $1 and unpriced tokens leave the spot table. Hand-entered balances always show.

Also: the open tab is kept in the address (`/app#portfolio`), Overview shows net worth change
against the reading nearest 24 hours ago, the spot table has a search box, and **CSV** downloads
every leg and balance in the current view in raw numbers.
