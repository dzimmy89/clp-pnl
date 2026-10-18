import { createPublicClient, defineChain, formatUnits, http, parseAbi } from "viem";
import { isEvmAddress } from "@/lib/addresses";
import { assetKind, assumedLiquidationThreshold, underlyingOf } from "@/lib/assets";
import { protocolMeta, type Leg, type Position, type ProtocolFetch } from "@/lib/types";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const hyperEvm = defineChain({
  id: 999,
  name: "HyperEVM",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid.xyz/evm"] } },
  contracts: { multicall3: { address: MULTICALL3 } },
});

const DATA_PROVIDER = "0x4f4d4cA1e0a8A21FE0B460613bEbe917f2eb4326" as const;
const POOL = "0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b" as const;
const ORACLE = "0xC9Fb4fbE842d57EAc1dF3e641a281827493A630e" as const;

type CallSuccess<T> = { status: "success"; result: T };
type CallFailure = { status: "failure"; error: Error };
type Call<T> = CallSuccess<T> | CallFailure;

type UserReserve = readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  number,
  boolean,
];
type ReserveConfig = readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean,
];
type ReserveData = readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  number,
];

const dataAbi = parseAbi([
  "function getAllReservesTokens() view returns ((string symbol, address tokenAddress)[])",
  "function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 reserveFactor, bool usageAsCollateralEnabled, bool borrowingEnabled, bool stableBorrowRateEnabled, bool isActive, bool isFrozen)",
  "function getReserveData(address asset) view returns (uint256 unbacked, uint256 accruedToTreasuryScaled, uint256 totalAToken, uint256 totalStableDebt, uint256 totalVariableDebt, uint256 liquidityRate, uint256 variableBorrowRate, uint256 stableBorrowRate, uint256 averageStableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex, uint40 lastUpdateTimestamp)",
]);

const poolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const oracleAbi = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)",
]);

function rayToApy(ray: bigint): number {
  const apr = Number(ray) / 1e27;
  if (!Number.isFinite(apr) || apr <= 0) return 0;
  const seconds = 31_536_000;
  const apy = (1 + apr / seconds) ** seconds - 1;
  return Number.isFinite(apy) ? apy : apr;
}

function units(value: bigint, decimals: number): number {
  const parsed = Number(formatUnits(value, decimals));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function fetchHyperlend(address: string): Promise<ProtocolFetch> {
  const meta = protocolMeta("hyperlend");
  const base = { id: meta.id, name: meta.name, chain: meta.chain, positions: [] as Position[], spot: [] };
  const wallet = address.trim();
  if (!wallet) return { ...base, status: "skipped", message: "No EVM address saved." };
  if (!isEvmAddress(wallet)) {
    return { ...base, status: "error", message: "That does not look like an EVM address." };
  }
  const client = createPublicClient({ chain: hyperEvm, transport: http(hyperEvm.rpcUrls.default.http[0]) });
  try {
    const user = wallet as `0x${string}`;
    const reserves = await client.readContract({
      address: DATA_PROVIDER,
      abi: dataAbi,
      functionName: "getAllReservesTokens",
    });
    if (reserves.length === 0) {
      return { ...base, status: "error", message: "Hyperlend pool returned no reserves." };
    }
    const userData = (await client.multicall({
      allowFailure: true,
      contracts: reserves.map((reserve) => ({
        address: DATA_PROVIDER,
        abi: dataAbi,
        functionName: "getUserReserveData" as const,
        args: [reserve.tokenAddress, user] as const,
      })),
    })) as Call<UserReserve>[];
    const active = reserves
      .map((reserve, index) => ({ reserve, result: userData[index] }))
      .filter((row) => {
        if (row.result.status !== "success") return false;
        const [supply, stableDebt, variableDebt] = row.result.result;
        return supply > 0n || stableDebt > 0n || variableDebt > 0n;
      });
    if (active.length === 0) {
      return { ...base, status: "ok", message: "No Hyperlend core-pool position for this address." };
    }
    const [configs, reserveData, prices, account] = await Promise.all([
      client.multicall({
        allowFailure: true,
        contracts: active.map((row) => ({
          address: DATA_PROVIDER,
          abi: dataAbi,
          functionName: "getReserveConfigurationData" as const,
          args: [row.reserve.tokenAddress] as const,
        })),
      }) as Promise<Call<ReserveConfig>[]>,
      client.multicall({
        allowFailure: true,
        contracts: active.map((row) => ({
          address: DATA_PROVIDER,
          abi: dataAbi,
          functionName: "getReserveData" as const,
          args: [row.reserve.tokenAddress] as const,
        })),
      }) as Promise<Call<ReserveData>[]>,
      client.multicall({
        allowFailure: true,
        contracts: active.map((row) => ({
          address: ORACLE,
          abi: oracleAbi,
          functionName: "getAssetPrice" as const,
          args: [row.reserve.tokenAddress] as const,
        })),
      }) as Promise<Call<bigint>[]>,
      client.readContract({
        address: POOL,
        abi: poolAbi,
        functionName: "getUserAccountData",
        args: [user],
      }),
    ]);
    const legs: Leg[] = [];
    active.forEach((row, index) => {
      if (row.result.status !== "success") return;
      const config = configs[index];
      const data = reserveData[index];
      const priceRow = prices[index];
      if (config.status !== "success" || data.status !== "success" || priceRow.status !== "success") return;
      const decimals = Number(config.result[0]);
      const thresholdRaw = Number(config.result[2]);
      const threshold = thresholdRaw > 0 ? thresholdRaw / 10_000 : null;
      const price = Number(priceRow.result) / 1e8;
      const [supplyBal, stableDebt, variableDebt] = row.result.result;
      const supplyApy = rayToApy(data.result[5]);
      const borrowApy = rayToApy(data.result[6]);
      const symbol = row.reserve.symbol;
      const kind = assetKind(symbol);
      const supplyAmount = units(supplyBal, decimals);
      if (supplyAmount > 0) {
        legs.push({
          id: `supply-${row.reserve.tokenAddress}`,
          side: "supply",
          symbol,
          underlying: underlyingOf(symbol),
          kind,
          amount: supplyAmount,
          usd: supplyAmount * price,
          apy: supplyApy,
          priceUsd: price,
          isCollateral: row.result.result[8],
          liquidationThreshold: threshold ?? assumedLiquidationThreshold(kind),
          liquidationThresholdSource: threshold != null ? "protocol" : "assumed",
        });
      }
      const borrowAmount = units(stableDebt + variableDebt, decimals);
      if (borrowAmount > 0) {
        legs.push({
          id: `borrow-${row.reserve.tokenAddress}`,
          side: "borrow",
          symbol,
          underlying: underlyingOf(symbol),
          kind,
          amount: borrowAmount,
          usd: borrowAmount * price,
          apy: borrowApy,
          priceUsd: price,
        });
      }
    });
    if (legs.length === 0) {
      return {
        ...base,
        status: "error",
        message: "Hyperlend balances were found, but reserve configuration could not be decoded.",
      };
    }
    const hfRaw = account[5];
    const hf = Number(formatUnits(hfRaw, 18));
    const health = Number.isFinite(hf) && hf > 0 && hf < 100 ? hf : null;
    const position: Position = {
      id: `hyperlend:${wallet.toLowerCase()}`,
      protocol: "hyperlend",
      chain: meta.chain,
      wallet,
      label: "Hyperlend core pool",
      source: "live",
      legs,
      healthFactor: health,
      healthFactorSource: health != null ? "protocol" : "estimated",
      fetchedAt: new Date().toISOString(),
      note: "HyperEVM Aave v3 fork. APY is compounded from the on-chain liquidity and variable borrow rates. Oracle prices use 8 decimals.",
    };
    return { ...base, status: "ok", positions: [position] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hyperlend RPC failed";
    return {
      ...base,
      status: "error",
      message: `Hyperlend could not be loaded from the public HyperEVM RPC. ${message}`,
    };
  }
}
