import { createPublicClient, defineChain, formatUnits, http, parseAbi, type Chain } from "viem";
import { bsc, mainnet } from "viem/chains";
import { isEvmAddress, isNearAccount, isSolanaAddress } from "@/lib/addresses";
import { assetKind, underlyingOf } from "@/lib/assets";
import { fetchJson } from "@/lib/http";
import { nearAccountBalance, nearView } from "@/lib/adapters/near";
import { fetchPriceBook, priceForSymbol, type PriceBook } from "@/lib/adapters/prices";
import type { Addresses, SpotHolding } from "@/lib/types";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const hyperEvm = defineChain({
  id: 999,
  name: "HyperEVM",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid.xyz/evm"] } },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

interface TokenSpec {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

const ETH_TOKENS: TokenSpec[] = [
  { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 },
  { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8 },
  { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  { symbol: "tBTC", address: "0x18084fbA666a33d37592fA2633fD49a74DD93a88", decimals: 18 },
  { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
];

const BSC_TOKENS: TokenSpec[] = [
  { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18 },
  { symbol: "BTCB", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18 },
  { symbol: "ETH", address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18 },
  { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
];

const HYPER_TOKENS: TokenSpec[] = [
  { symbol: "wHYPE", address: "0x5555555555555555555555555555555555555555", decimals: 18 },
  { symbol: "UBTC", address: "0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463", decimals: 8 },
  { symbol: "UETH", address: "0xBe6727B535545C67d5cAa73dEa54865B92CF7907", decimals: 18 },
  { symbol: "USDC", address: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", decimals: 6 },
  { symbol: "USDT0", address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", decimals: 6 },
];

const NEAR_TOKENS = [
  "wrap.near",
  "usdt.tether-token.near",
  "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",
];

function holding(
  wallet: string,
  chain: string,
  symbol: string,
  amount: number,
  prices: PriceBook,
): SpotHolding | null {
  if (!(amount > 0)) return null;
  const kind = assetKind(symbol);
  const price = priceForSymbol(prices, symbol) ?? priceForSymbol(prices, underlyingOf(symbol));
  return {
    id: `spot:${chain}:${wallet}:${symbol}`,
    wallet,
    chain,
    symbol,
    underlying: underlyingOf(symbol),
    kind,
    amount,
    usd: price ? amount * price : 0,
    priceUsd: price ?? 0,
    source: "live",
    unpriced: !price,
  };
}

async function evmSpot(
  chainName: string,
  wallet: string,
  nativeSymbol: string,
  rpc: string,
  chain: Chain,
  tokens: TokenSpec[],
  prices: PriceBook,
): Promise<SpotHolding[]> {
  const client = createPublicClient({ chain, transport: http(rpc) });
  const user = wallet as `0x${string}`;
  const [native, balances] = await Promise.all([
    client.getBalance({ address: user }),
    client.multicall({
      allowFailure: true,
      contracts: tokens.map((token) => ({
        address: token.address,
        abi: erc20,
        functionName: "balanceOf" as const,
        args: [user] as const,
      })),
    }),
  ]);
  const rows: SpotHolding[] = [];
  const nativeHolding = holding(wallet, chainName, nativeSymbol, Number(formatUnits(native, 18)), prices);
  if (nativeHolding) rows.push(nativeHolding);
  tokens.forEach((token, index) => {
    const result = balances[index];
    if (!result || result.status !== "success") return;
    const amount = Number(formatUnits(result.result, token.decimals));
    const row = holding(wallet, chainName, token.symbol, amount, prices);
    if (row) rows.push(row);
  });
  return rows;
}

async function solanaSpot(wallet: string, prices: PriceBook): Promise<SpotHolding[]> {
  const rpc = "https://api.mainnet-beta.solana.com";
  const [lamports, tokenAccounts, token2022] = await Promise.all([
    fetchJson<{ result?: { value?: number } }>(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [wallet],
      }),
    }),
    tokenAccountsOf(rpc, wallet, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    tokenAccountsOf(rpc, wallet, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
  ]);
  const rows: SpotHolding[] = [];
  const sol = (lamports.result?.value ?? 0) / 1e9;
  const solRow = holding(wallet, "Solana", "SOL", sol, prices);
  if (solRow) rows.push(solRow);
  const parsed = [...tokenAccounts, ...token2022]
    .map((account) => {
      const info = account.account?.data?.parsed?.info;
      const amount = Number(info?.tokenAmount?.uiAmount ?? 0);
      const mint = String(info?.mint ?? "");
      return { mint, amount };
    })
    .filter((row) => row.amount > 0 && row.mint)
    .slice(0, 48);
  if (parsed.length === 0) return rows;
  const keys = parsed.map((row) => `solana:${row.mint}`);
  const minted = await fetchPriceBook(keys);
  const merged: PriceBook = {
    ...prices,
    byKey: { ...prices.byKey, ...minted.byKey },
    bySymbol: { ...prices.bySymbol, ...minted.bySymbol },
    btc: prices.btc ?? minted.btc,
    timestamp: prices.timestamp ?? minted.timestamp,
  };
  for (const row of parsed) {
    const key = `solana:${row.mint}`;
    const price = merged.byKey[key];
    const symbol = minted.byKey[key] ? shortMint(row.mint) : shortMint(row.mint);
    const known = knownMint(row.mint);
    const display = known ?? symbol;
    const kind = assetKind(display);
    rows.push({
      id: `spot:solana:${wallet}:${row.mint}`,
      wallet,
      chain: "Solana",
      symbol: display,
      underlying: known ? underlyingOf(display) : display,
      kind: known ? kind : "volatile",
      amount: row.amount,
      usd: price ? row.amount * price : 0,
      priceUsd: price ?? 0,
      source: "live",
      unpriced: !price,
    });
  }
  return rows;
}

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function knownMint(mint: string): string | null {
  const map: Record<string, string> = {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
    So11111111111111111111111111111111111111112: "SOL",
  };
  return map[mint] ?? null;
}

interface TokenAccountResponse {
  result?: {
    value?: Array<{
      account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number } } } } };
    }>;
  };
}

async function tokenAccountsOf(rpc: string, wallet: string, programId: string) {
  const body = await fetchJson<TokenAccountResponse>(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [wallet, { programId }, { encoding: "jsonParsed" }],
    }),
  });
  return body.result?.value ?? [];
}

async function nearSpot(account: string, prices: PriceBook): Promise<SpotHolding[]> {
  const rows: SpotHolding[] = [];
  const native = await nearAccountBalance(account);
  const nearRow = holding(account, "NEAR", "NEAR", native, prices);
  if (nearRow) rows.push(nearRow);
  const balances = await Promise.all(
    NEAR_TOKENS.map(async (token) => {
      try {
        const [meta, balance] = await Promise.all([
          nearView<{ symbol?: string; decimals?: number }>(token, "ft_metadata", {}),
          nearView<string>(token, "ft_balance_of", { account_id: account }),
        ]);
        const decimals = meta.decimals ?? 18;
        const raw = BigInt(String(balance).replaceAll('"', "") || "0");
        const amount = Number(raw / 10n ** BigInt(Math.min(decimals, 12))) / 10 ** Math.max(decimals - 12, 0);
        return holding(account, "NEAR", meta.symbol || token, amount, prices);
      } catch {
        return null;
      }
    }),
  );
  for (const row of balances) {
    if (row) rows.push(row);
  }
  return rows;
}

export async function fetchSpot(addresses: Addresses): Promise<{ spot: SpotHolding[]; notes: string[] }> {
  const prices = await fetchPriceBook();
  const spot: SpotHolding[] = [];
  const notes: string[] = [];
  if (prices.error) notes.push(`DefiLlama prices: ${prices.error}`);
  const jobs: Promise<void>[] = [];
  if (addresses.evm.trim()) {
    if (!isEvmAddress(addresses.evm)) {
      notes.push("Spot scan skipped the EVM address because it is not a 20-byte hex address.");
    } else {
      jobs.push(
        evmSpot("Ethereum", addresses.evm.trim(), "ETH", "https://ethereum-rpc.publicnode.com", mainnet, ETH_TOKENS, prices)
          .then((rows) => { spot.push(...rows); })
          .catch((error: unknown) => {
            notes.push(`Ethereum spot balances failed: ${error instanceof Error ? error.message : "RPC error"}`);
          }),
        evmSpot("BNB Chain", addresses.evm.trim(), "BNB", "https://bsc-rpc.publicnode.com", bsc, BSC_TOKENS, prices)
          .then((rows) => { spot.push(...rows); })
          .catch((error: unknown) => {
            notes.push(`BNB Chain spot balances failed: ${error instanceof Error ? error.message : "RPC error"}`);
          }),
        evmSpot("HyperEVM", addresses.evm.trim(), "HYPE", hyperEvm.rpcUrls.default.http[0], hyperEvm, HYPER_TOKENS, prices)
          .then((rows) => { spot.push(...rows); })
          .catch((error: unknown) => {
            notes.push(`HyperEVM spot balances failed: ${error instanceof Error ? error.message : "RPC error"}`);
          }),
      );
    }
  }
  if (addresses.solana.trim()) {
    if (!isSolanaAddress(addresses.solana)) {
      notes.push("Spot scan skipped the Solana address because it is not a base58 public key.");
    } else {
      jobs.push(
        solanaSpot(addresses.solana.trim(), prices)
          .then((rows) => { spot.push(...rows); })
          .catch((error: unknown) => {
            notes.push(`Solana spot balances failed: ${error instanceof Error ? error.message : "RPC error"}`);
          }),
      );
    }
  }
  if (addresses.near.trim()) {
    if (!isNearAccount(addresses.near)) {
      notes.push("Spot scan skipped the NEAR account because the name looks invalid.");
    } else {
      jobs.push(
        nearSpot(addresses.near.trim().toLowerCase(), prices)
          .then((rows) => { spot.push(...rows); })
          .catch((error: unknown) => {
            notes.push(`NEAR spot balances failed: ${error instanceof Error ? error.message : "RPC error"}`);
          }),
      );
    }
  }
  if (addresses.canton.trim()) {
    notes.push("Canton balances are not public. Enter them under Wallets, Balances entered by hand, and Alpend positions as a manual book.");
  }
  await Promise.all(jobs);
  const meaningful = spot.filter((row) => row.usd >= 1);
  const omitted = spot.length - meaningful.length;
  if (omitted > 0) {
    notes.push(`${omitted} dust or unpriced balances were left out of spot inventory.`);
  }
  notes.push("Spot scan covers native gas plus a short list of major tokens, not every wallet asset.");
  return { spot: meaningful, notes };
}
