import { createPublicClient, encodeAbiParameters, formatUnits, http, keccak256, parseAbi, type Address, type Hex } from "viem";
import { arbitrum } from "viem/chains";
import { isEvmAddress } from "@/lib/addresses";
import { underlyingOf } from "@/lib/assets";
import { gmxPositionBook, type GmxMarket, type GmxPosition, type GmxTokenInfo } from "@/lib/adapters/gmx-book";
import { fetchPriceBook, priceForSymbol, type PriceBook } from "@/lib/adapters/prices";
import { protocolMeta, type Position, type ProtocolFetch } from "@/lib/types";

/**
 * GMX V2 perpetuals on Arbitrum, read straight from the protocol's DataStore: every open
 * long and short of a wallet with its size, collateral, entry price and the maintenance
 * rule that liquidates it. Perps aren't tokens, so no indexer carries them.
 *
 * Each position becomes a book like Drift's: the index asset as a leg (supplied for a
 * long, borrowed for a short) plus a USD leg for the entry notional and the collateral as a
 * supply, so equity is collateral plus unrealised PnL and the joint liquidation math lands on
 * GMX's own line. GMX liquidates when collateral + PnL < size × minCollateralFactor (fees,
 * funding and price impact aside). For a long that is P·S·(1 − f) + C ≥ E, which the index
 * leg's threshold (1 − f) expresses directly; for a short it is C + E ≥ P·S·(1 + f), which
 * the reported health factor (C + E) / (P·S·(1 + f)) puts on the protocol's scale.
 */

const DATA_STORE = "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8" as const;
const API = "https://arbitrum-api.gmxinfra.io";
const PRICE_DECIMALS = 30;
const CACHE_MS = 30_000;

const dataStoreAbi = parseAbi([
  "function getUint(bytes32 key) view returns (uint256)",
  "function getAddress(bytes32 key) view returns (address)",
  "function getBool(bytes32 key) view returns (bool)",
  "function getBytes32Count(bytes32 setKey) view returns (uint256)",
  "function getBytes32ValuesAt(bytes32 setKey, uint256 start, uint256 end) view returns (bytes32[])",
]);

const erc20Abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

/** `keccak256(abi.encode("NAME"))`, the way gmx-synthetics' Keys.sol names every stored value. */
function nameKey(name: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }], [name]));
}

/** `keccak256(abi.encode(key, NAME))`: a named field of a position or market. */
function fieldKey(key: Hex | Address, name: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [key as Hex, nameKey(name)]));
}

function accountPositionListKey(account: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [nameKey("ACCOUNT_POSITION_LIST"), account]));
}

function minCollateralFactorKey(market: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [nameKey("MIN_COLLATERAL_FACTOR"), market]));
}

/** Address stored in a bytes32 slot: `abi.encode(address)` pads it to 32 bytes on the left. */
function addressKey(address: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [address]);
}

const client = createPublicClient({
  chain: arbitrum,
  transport: http(process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc", { timeout: 20_000 }),
});

const globalForGmx = globalThis as unknown as {
  omnifolioGmxTokens?: Map<string, GmxTokenInfo>;
  omnifolioGmxMarkets?: Map<string, GmxMarket>;
  omnifolioGmxTickers?: { at: number; prices: Map<string, number> };
  omnifolioGmxTokenList?: Promise<void>;
};
const tokenCache = (globalForGmx.omnifolioGmxTokens ??= new Map());
const marketCache = (globalForGmx.omnifolioGmxMarkets ??= new Map());

function toFloat(value: bigint, decimals: number): number {
  return Number(formatUnits(value, decimals));
}

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`${new URL(url).host} returned ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GMX's token list names every market's index token, including the synthetic ones (BTC,
 * DOGE, XRP…) that have no ERC-20 to ask. Loaded once; a failure just means asking on-chain.
 */
function loadTokenList(): Promise<void> {
  return (globalForGmx.omnifolioGmxTokenList ??= getJson<{ tokens?: { symbol?: string; address?: string; decimals?: number }[] }>(`${API}/tokens`)
    .then((body) => {
      for (const token of body.tokens ?? []) {
        if (token.address && token.symbol && typeof token.decimals === "number") {
          tokenCache.set(token.address.toLowerCase(), { symbol: token.symbol, decimals: token.decimals });
        }
      }
    })
    .catch(() => {
      globalForGmx.omnifolioGmxTokenList = undefined;
    }));
}

async function tokenInfo(addresses: Address[]): Promise<Map<string, GmxTokenInfo>> {
  await loadTokenList();
  const missing = addresses.filter((address) => !tokenCache.has(address.toLowerCase()));
  if (missing.length) {
    const results = await client.multicall({
      contracts: missing.flatMap((address) => [
        { address, abi: erc20Abi, functionName: "symbol" } as const,
        { address, abi: erc20Abi, functionName: "decimals" } as const,
      ]),
      allowFailure: true,
    });
    missing.forEach((address, index) => {
      const symbol = results[index * 2];
      const decimals = results[index * 2 + 1];
      tokenCache.set(address.toLowerCase(), {
        symbol: symbol.status === "success" ? String(symbol.result) : `${address.slice(0, 6)}…`,
        decimals: decimals.status === "success" ? Number(decimals.result) : 18,
      });
    });
  }
  return new Map(addresses.map((address) => [address.toLowerCase(), tokenCache.get(address.toLowerCase())!]));
}

async function markets(addresses: Address[]): Promise<Map<string, GmxMarket>> {
  const missing = addresses.filter((address) => !marketCache.has(address.toLowerCase()));
  if (missing.length) {
    const results = await client.multicall({
      contracts: missing.flatMap((market) => [
        { address: DATA_STORE, abi: dataStoreAbi, functionName: "getAddress", args: [fieldKey(addressKey(market), "INDEX_TOKEN")] } as const,
        { address: DATA_STORE, abi: dataStoreAbi, functionName: "getUint", args: [minCollateralFactorKey(market)] } as const,
      ]),
      allowFailure: false,
    });
    const indexTokens = missing.map((_, index) => results[index * 2] as Address);
    const tokens = await tokenInfo(indexTokens);
    missing.forEach((market, index) => {
      const indexToken = indexTokens[index];
      const info = tokens.get(indexToken.toLowerCase())!;
      marketCache.set(market.toLowerCase(), {
        market,
        indexToken,
        indexSymbol: info.symbol,
        indexDecimals: info.decimals,
        minCollateralFactor: toFloat(results[index * 2 + 1] as bigint, PRICE_DECIMALS),
      });
    });
  }
  return new Map(addresses.map((address) => [address.toLowerCase(), marketCache.get(address.toLowerCase())!]));
}

/** Every open position of the account, straight from the DataStore's per-account position list. */
export async function readGmxPositions(account: Address): Promise<GmxPosition[]> {
  const listKey = accountPositionListKey(account);
  const count = await client.readContract({ address: DATA_STORE, abi: dataStoreAbi, functionName: "getBytes32Count", args: [listKey] });
  if (count === 0n) return [];
  const keys = (await client.readContract({
    address: DATA_STORE,
    abi: dataStoreAbi,
    functionName: "getBytes32ValuesAt",
    args: [listKey, 0n, count > 50n ? 50n : count],
  })) as readonly Hex[];
  const fields = ["MARKET", "COLLATERAL_TOKEN", "SIZE_IN_USD", "SIZE_IN_TOKENS", "COLLATERAL_AMOUNT", "IS_LONG"] as const;
  const results = (await client.multicall({
    contracts: keys.flatMap((key) => [
      { address: DATA_STORE, abi: dataStoreAbi, functionName: "getAddress", args: [fieldKey(key, "MARKET")] } as const,
      { address: DATA_STORE, abi: dataStoreAbi, functionName: "getAddress", args: [fieldKey(key, "COLLATERAL_TOKEN")] } as const,
      { address: DATA_STORE, abi: dataStoreAbi, functionName: "getUint", args: [fieldKey(key, "SIZE_IN_USD")] } as const,
      { address: DATA_STORE, abi: dataStoreAbi, functionName: "getUint", args: [fieldKey(key, "SIZE_IN_TOKENS")] } as const,
      { address: DATA_STORE, abi: dataStoreAbi, functionName: "getUint", args: [fieldKey(key, "COLLATERAL_AMOUNT")] } as const,
      { address: DATA_STORE, abi: dataStoreAbi, functionName: "getBool", args: [fieldKey(key, "IS_LONG")] } as const,
    ]),
    allowFailure: false,
  })) as (Address | bigint | boolean)[];
  const raw = keys.map((key, index) => {
    const at = (field: (typeof fields)[number]) => results[index * fields.length + fields.indexOf(field)];
    return {
      key,
      market: at("MARKET") as Address,
      collateralToken: at("COLLATERAL_TOKEN") as Address,
      sizeInUsd: at("SIZE_IN_USD") as bigint,
      sizeInTokens: at("SIZE_IN_TOKENS") as bigint,
      collateralAmount: at("COLLATERAL_AMOUNT") as bigint,
      isLong: at("IS_LONG") as boolean,
    };
  });
  const open = raw.filter((row) => row.sizeInUsd > 0n);
  const [marketInfo, collateral] = await Promise.all([
    markets([...new Set(open.map((row) => row.market))]),
    tokenInfo([...new Set(open.map((row) => row.collateralToken))]),
  ]);
  return open.map((row) => ({
    key: row.key,
    market: row.market,
    collateralToken: row.collateralToken,
    isLong: row.isLong,
    sizeUsd: toFloat(row.sizeInUsd, PRICE_DECIMALS),
    sizeInTokens: toFloat(row.sizeInTokens, marketInfo.get(row.market.toLowerCase())!.indexDecimals),
    collateralAmount: toFloat(row.collateralAmount, collateral.get(row.collateralToken.toLowerCase())!.decimals),
  }));
}

/** GMX's own oracle marks by token address, from its public ticker feed. Empty when it fails. */
async function gmxTickers(): Promise<Map<string, number>> {
  const cached = globalForGmx.omnifolioGmxTickers;
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.prices;
  const prices = new Map<string, number>();
  try {
    const body = await getJson<{ tokenAddress?: string; minPrice?: string; maxPrice?: string }[]>(`${API}/prices/tickers`);
    for (const row of body) {
      const address = row.tokenAddress?.toLowerCase();
      const decimals = address ? tokenCache.get(address)?.decimals : undefined;
      if (!address || decimals == null || !row.minPrice || !row.maxPrice) continue;
      // Ticker prices are USD × 1e30 per smallest token unit.
      const mid = (BigInt(row.minPrice) + BigInt(row.maxPrice)) / 2n;
      prices.set(address, toFloat(mid, PRICE_DECIMALS - decimals));
    }
  } catch {}
  globalForGmx.omnifolioGmxTickers = { at: Date.now(), prices };
  return prices;
}

function priceOf(token: string, symbol: string, tickers: Map<string, number>, book: PriceBook): number {
  return (
    tickers.get(token.toLowerCase()) ??
    book.byKey[`arbitrum:${token.toLowerCase()}`] ??
    priceForSymbol(book, symbol) ??
    priceForSymbol(book, underlyingOf(symbol)) ??
    0
  );
}

export async function fetchGmx(address: string): Promise<ProtocolFetch> {
  const meta = protocolMeta("gmx");
  const base = { id: meta.id, name: meta.name, chain: meta.chain, positions: [] as Position[], spot: [] };
  const wallet = address.trim();
  if (!wallet) return { ...base, status: "skipped", message: "No EVM wallet saved." };
  if (!isEvmAddress(wallet)) return { ...base, status: "error", message: "That does not look like an EVM address." };
  try {
    const open = await readGmxPositions(wallet as Address);
    if (!open.length) return { ...base, status: "ok", message: "No open GMX positions for this wallet." };
    const marketInfo = await markets([...new Set(open.map((row) => row.market as Address))]);
    const collateral = await tokenInfo([...new Set(open.map((row) => row.collateralToken as Address))]);
    const [tickers, book] = await Promise.all([
      gmxTickers(),
      fetchPriceBook([...new Set(open.flatMap((row) => [row.collateralToken, marketInfo.get(row.market.toLowerCase())!.indexToken]))].map((token) => `arbitrum:${token.toLowerCase()}`)),
    ]);
    const positions: Position[] = open.map((position) => {
      const market = marketInfo.get(position.market.toLowerCase())!;
      const collateralToken = collateral.get(position.collateralToken.toLowerCase())!;
      const indexPrice = priceOf(market.indexToken, market.indexSymbol, tickers, book);
      const collateralPrice = priceOf(position.collateralToken, collateralToken.symbol, tickers, book);
      const { legs, healthFactor, entryPrice, leverage, pnlUsd } = gmxPositionBook({ position, market, collateral: collateralToken, indexPrice, collateralPrice });
      const side = position.isLong ? "long" : "short";
      return {
        id: `gmx:${wallet.toLowerCase()}:${position.key}`,
        protocol: "gmx",
        app: "GMX",
        category: "other",
        chain: meta.chain,
        wallet,
        label: `GMX ${market.indexSymbol}/USD ${side} · ${meta.chain}`,
        source: "live",
        legs,
        healthFactor,
        healthFactorSource: "protocol",
        note: [
          `${side === "long" ? "Long" : "Short"} ${position.sizeInTokens.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${market.indexSymbol} ($${Math.round(position.sizeUsd).toLocaleString("en-US")}) from $${entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}${leverage ? `, ${leverage.toFixed(1)}x` : ""}, PnL ${pnlUsd < 0 ? "−" : "+"}$${Math.abs(Math.round(pnlUsd)).toLocaleString("en-US")}.`,
          `The index leg is the position size (supplied for a long, borrowed for a short) and the USD leg its entry notional, so equity is collateral plus unrealised PnL.`,
          `Health is collateral plus PnL over GMX's maintenance collateral (${(market.minCollateralFactor * 100).toFixed(2)}% of size), before fees, funding and price impact; the liquidation price is where it reaches 1.`,
        ].join(" "),
        fetchedAt: new Date().toISOString(),
      };
    });
    return { ...base, status: "ok", positions };
  } catch (error) {
    const message = error instanceof Error ? error.message : "GMX request failed";
    return { ...base, status: "error", message: `GMX could not be loaded. ${message}` };
  }
}
