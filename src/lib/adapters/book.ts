import { fetchAave } from "@/lib/adapters/aave";
import { CHAIN_READERS, type ChainReaderId } from "@/lib/adapters/chains";
import { fetchAlpend } from "@/lib/adapters/alpend";
import { fetchGmx } from "@/lib/adapters/gmx";
import { fetchHyperlend } from "@/lib/adapters/hyperlend";
import { fetchKamino } from "@/lib/adapters/kamino";
import { fetchPriceBook } from "@/lib/adapters/prices";
import { fetchRhea } from "@/lib/adapters/rhea";
import { fetchSpot } from "@/lib/adapters/spot";
import { fetchUniswap, readDirectly, type CoveredKey } from "@/lib/adapters/uniswap";
import { fetchVenus } from "@/lib/adapters/venus";
import { fetchZerion, zerionConfigured } from "@/lib/adapters/zerion";
import { mergeProtocolFetches, shortAddress, uniqueAddresses } from "@/lib/wallet-set";
import { WALLET_KINDS, protocolMeta, type Addresses, type BookResponse, type ProtocolFetch, type SpotHolding, type WalletSet } from "@/lib/types";

async function settle(task: Promise<ProtocolFetch>, fallback: ProtocolFetch): Promise<ProtocolFetch> {
  try {
    return await task;
  } catch (error) {
    return {
      ...fallback,
      status: "error",
      message: error instanceof Error ? error.message : "Request failed",
    };
  }
}

/** Runs one protocol adapter once per wallet and folds the results into one fetch. */
async function perWallet(
  id: ProtocolFetch["id"],
  addresses: string[],
  fetcher: (address: string) => Promise<ProtocolFetch>,
): Promise<ProtocolFetch> {
  // With no wallet, call once with "" so the adapter reports its own "skipped" status.
  const targets = addresses.length ? addresses : [""];
  const fetches = await Promise.all(
    targets.map(async (address) => ({ address, fetch: await settle(fetcher(address), empty(id)) })),
  );
  return mergeProtocolFetches(fetches);
}

export async function loadLiveBook(input: Partial<WalletSet>): Promise<BookResponse> {
  const wallets = Object.fromEntries(
    WALLET_KINDS.map((kind) => [kind, uniqueAddresses(input[kind] ?? [], kind)]),
  ) as unknown as WalletSet;
  // Zerion covers balances on every EVM chain and on Solana. Wallets it read cleanly skip the
  // built-in spot reader; wallets it couldn't read (or every wallet, without a key) fall back to it.
  const zerionTargets = zerionConfigured() ? [...wallets.evm, ...wallets.solana] : [];
  const zerionPromise = Promise.all(
    zerionTargets.map(async (address) => ({ address, fetch: await settle(fetchZerion(address), empty("zerion")) })),
  );
  const spotPromise = zerionPromise.then((reads) => {
    const covered = new Set(reads.filter((read) => read.fetch.status === "ok").map((read) => read.address));
    const targets = [
      ...wallets.evm.filter((evm) => !covered.has(evm)).map((evm) => ({ ...EMPTY_ADDRESSES, evm })),
      ...wallets.solana.filter((solana) => !covered.has(solana)).map((solana) => ({ ...EMPTY_ADDRESSES, solana })),
      ...wallets.near.map((near) => ({ ...EMPTY_ADDRESSES, near })),
    ];
    return Promise.all(targets.map((addresses) => fetchSpot(addresses))).then((packs) => ({ targets, packs }));
  });
  const chainIds = Object.keys(CHAIN_READERS) as ChainReaderId[];
  const chainPromise = Promise.all(
    chainIds.map((id) => perWallet(id, wallets[CHAIN_READERS[id].kind], (address) => fetchChain(id, address))),
  );
  // Uniswap V3/V4 positions are read straight from the chain, with range and fee detail
  // Zerion doesn't carry; Zerion's copy of those pools is dropped below so nothing counts twice.
  const uniswapPromise = Promise.all(
    (wallets.evm.length ? wallets.evm : [""]).map(async (address) => {
      try {
        return { address, ...(await fetchUniswap(address)) };
      } catch (error) {
        return { address, fetch: { ...empty("uniswap"), message: error instanceof Error ? error.message : "Request failed" }, covered: new Set<CoveredKey>() };
      }
    }),
  );
  const [aave, kamino, hyperlend, venus, rhea, alpend, gmx, zerionReads, spotRead, prices, chains, uniswapReads] = await Promise.all([
    perWallet("aave", wallets.evm, fetchAave),
    perWallet("kamino", wallets.solana, fetchKamino),
    perWallet("hyperlend", wallets.evm, fetchHyperlend),
    perWallet("venus", wallets.evm, fetchVenus),
    perWallet("rhea", wallets.near, fetchRhea),
    perWallet("alpend", wallets.canton, fetchAlpend),
    perWallet("gmx", wallets.evm, fetchGmx),
    zerionPromise,
    spotPromise,
    fetchPriceBook(),
    chainPromise,
    uniswapPromise,
  ]);
  const uniswap = mergeProtocolFetches(uniswapReads);
  const coveredByWallet = new Map(uniswapReads.map((read) => [read.address.toLowerCase(), read.covered]));
  const zerion = zerionReads.length ? mergeProtocolFetches(zerionReads) : await fetchZerion("");
  zerion.positions = zerion.positions.filter((position) => !readDirectly(position, coveredByWallet.get(position.wallet.toLowerCase()) ?? new Set()));
  const { targets: spotTargets, packs: spotPacks } = spotRead;
  // Jupiter Lend Earn receipts (jlUSDC…) also sit in the wallet; the Earn position already counts them.
  const earnWallets = new Set(chains.flatMap((read) => read.positions).filter((p) => p.app === "Jupiter Lend").map((p) => p.wallet));
  const notReceipt = (holding: SpotHolding) => !(earnWallets.has(holding.wallet) && /^jl[A-Z]/.test(holding.symbol));
  return {
    fetchedAt: new Date().toISOString(),
    btcPrice: prices.btc,
    priceTimestamp: prices.timestamp,
    priceError: prices.error,
    protocols: [zerion, aave, kamino, hyperlend, venus, rhea, alpend, gmx, uniswap, ...chains],
    spot: [...zerion.spot, ...spotPacks.flatMap((pack) => pack.spot), ...chains.flatMap((chain) => chain.spot)].filter(notReceipt),
    spotNotes: spotNotes(spotTargets, spotPacks),
  };
}

/** One wallet through a whole-chain reader. App failures become the message; the rest still shows. */
async function fetchChain(id: ChainReaderId, address: string): Promise<ProtocolFetch> {
  const { name, chain } = protocolMeta(id);
  const base = { id, name, chain };
  if (!address) return { ...base, status: "skipped", message: CHAIN_READERS[id].connectHint, positions: [], spot: [] };
  const read = await CHAIN_READERS[id].read(address);
  return {
    ...base,
    status: "ok",
    message: read.notes.length ? read.notes.join(" · ") : undefined,
    positions: read.positions,
    spot: read.spot,
  };
}

/**
 * One note per problem. RPC errors carry the request dump on later lines, so keep the first
 * line, and with several wallets say which wallet a failure was for.
 */
function spotNotes(targets: Addresses[], packs: { notes: string[] }[]): string[] {
  const notes = packs.flatMap((pack, i) => {
    const wallet = targets[i].evm || targets[i].solana || targets[i].near;
    return pack.notes.map((note) => {
      const status = /Status: (\d{3})/.exec(note)?.[1];
      const line = note.split("\n")[0].trim() + (status && !note.split("\n")[0].includes(status) ? ` (HTTP ${status})` : "");
      return targets.length > 1 && /failed|skipped/i.test(line) ? `${shortAddress(wallet)}: ${line}` : line;
    });
  });
  return [...new Set(notes)];
}

const EMPTY_ADDRESSES: Addresses = { evm: "", solana: "", near: "", canton: "" };

function empty(id: ProtocolFetch["id"]): ProtocolFetch {
  const { name, chain } = protocolMeta(id);
  return { id, name, chain, status: "error", positions: [], spot: [] };
}
