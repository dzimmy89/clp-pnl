import { hash } from "starknet";
import {
  getJson,
  legOf,
  llamaPrices,
  positionOf,
  readApp,
  rpc,
  spotRow,
  units,
  type ChainDeps,
  type ChainRead,
  type ChainReader,
} from "@/lib/adapters/chains/common";
import type { Leg, Position, SpotHolding } from "@/lib/types";

/**
 * Starknet reader.
 * - Balances: ERC-20 `balanceOf` for a list of known tokens over Starknet JSON-RPC (`starknet_call`,
 *   batched). Default RPC is the same keyless endpoint sign-in uses; override with STARKNET_RPC_URL.
 * - Vesu: positions from api.vesu.xyz/positions (supply, debt, health, prices), rates from /markets.
 * - Nostra Money Market: balances of Nostra's interest-bearing and collateral tokens (they rebase in
 *   underlying units) and debt tokens; rates from Nostra's interest rate model.
 * Prices from DefiLlama (`starknet:<address>`, CoinGecko ids for the majors).
 */

const CHAIN = "Starknet";
const DEFAULT_RPC_URL = "https://api.zan.top/public/starknet-mainnet/rpc/v0_10";
const VESU_API = "https://api.vesu.xyz";
const NOSTRA_IRM = "0x059a943ca214c10234b9a3b61c558ac20c005127d183b86a99a8f3c60a08b4ff";
const BATCH = 40;
const TIMEOUT_MS = 8_000;

interface Token {
  symbol: string;
  address: string;
  decimals: number;
  cg?: string;
}

const t = (symbol: string, address: string, decimals: number, cg?: string): Token => ({ symbol, address, decimals, cg });

const ETH = t("ETH", "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", 18, "ethereum");
const STRK = t("STRK", "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", 18, "starknet");
const USDC_E = t("USDC.e", "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8", 6, "usd-coin");
const USDT = t("USDT", "0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8", 6, "tether");
const WBTC = t("WBTC", "0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac", 8, "wrapped-bitcoin");
const DAI = t("DAI", "0x05574eb6b8789a91466f902c380d978e472db68170ff82a5b650b95a58ddf4ad", 18, "dai");
const DAI_V0 = t("DAI", "0x00da114221cb83fa859dbdb4c44beeaa0bb37c7537ad5ae66fe5e0efd20e6eb3", 18, "dai");
const WSTETH_LEGACY = t("wstETH", "0x042b8f0484674ca266ac5d08e4ac6a3fe65bd3129795def2dca5c34ecc5f96d2", 18, "wrapped-steth");
const LORDS = t("LORDS", "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49", 18, "lords");
const NST_STRK = t("nstSTRK", "0x04619e9ce4109590219c5263787050726be63382148538f3f936c22aa87d2fc2", 18);
const UNO = t("UNO", "0x0719b5092403233201aa822ce928bd4b551d0cdb071a724edd7dc5e5f57b7f34", 18);
const NSTR = t("NSTR", "0x00c530f2c0aa4c16a0806365b0898499fba372e5df7a7172dc6fe9ba777e8007", 18);
const EKUBO = t("EKUBO", "0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87", 18, "ekubo-protocol");
const XSTRK = t("xSTRK", "0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a", 18);
const BROTHER = t("BROTHER", "0x03b405a98c9e795d427fe82cdeeeed803f221b52471e3a757574a2b4180793ee", 18);
const SSTRK = t("sSTRK", "0x0356f304b154d29d2a8fe22f1cb9107a9b564a733cf6b4cc47fd121ac1af90c9", 18);

/** Wallet tokens. Liquid staking tokens held here are plain balances. */
const TOKENS: Token[] = [
  ETH,
  STRK,
  t("USDC", "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb", 6, "usd-coin"),
  USDC_E,
  USDT,
  WBTC,
  DAI,
  DAI_V0,
  t("wstETH", "0x0057912720381af14b0e5c87aa4718ed5e527eab60b3801ebf702ab09139e38b", 18, "wrapped-steth"),
  WSTETH_LEGACY,
  t("rETH", "0x0319111a5037cbec2b3e638cc34a3474e2d2608299f3e62866e9cc683208c610", 18, "rocket-pool-eth"),
  t("LBTC", "0x036834a40984312f7f7de8d31e3f6305b325389eaeea5b1c0664b2fb936461a4", 8, "lombard-staked-btc"),
  t("tBTC", "0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f", 18, "tbtc"),
  t("SolvBTC", "0x0593e034dda23eea82d2ba9a30960ed42cf4a01502cc2351dc9b9881f9931a68", 18, "solv-btc"),
  XSTRK,
  SSTRK,
  NST_STRK,
  t("vSTRK", "0x0782f0ddca11d9950bc3220e35ac82cf868778edb67a5e58b39838544bc4cd0f", 18),
  t("xWBTC", "0x06a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13", 8),
  t("xtBTC", "0x043a35c1425a0125ef8c171f1a75c6f31ef8648edcc8324b55ce1917db3f9b91", 18),
  t("xLBTC", "0x07dd3c80de9fcc5545f0cb83678826819c79619ed7992cc06ff81fc67cd2efe0", 8),
  t("xsBTC", "0x0580f3dc564a7b82f21d40d404b3842d490ae7205e6ac07b1b7af2b4a5183dc9", 18),
  t("USN", "0x01e6545cab7ba4ac866768ba5e1bd540893762286ed3fea7f9c02bfa147e135b", 18),
  t("sUSN", "0x02411565ef1a14decfbe83d2e987cced918cd752508a3d9c55deb67148d14d17", 18),
  t("LUSD", "0x070a76fd48ca0ef910631754d77dd822147fe98a569b826ec85e3c33fde586ac", 18, "liquity-usd"),
  t("SOL", "0x01e70aedffd376afe33cebdf51ed5365131dccb2a5b2cb36d02b785442912b9b", 9, "solana"),
  EKUBO,
  LORDS,
  NSTR,
  UNO,
  BROTHER,
];

/** Nostra Money Market: per asset four supply tokens (n, i, n-c, i-c in that order) and one debt token. */
const NOSTRA: { asset: Token; supply: string[]; debt: string }[] = [
  { asset: WBTC, supply: ["0x0735d0f09a4e8bf8a17005fa35061b5957dcaa56889fc75df9e94530ff6991ea", "0x05b7d301fa769274f20e89222169c0fad4d846c366440afc160aafadd6f88f0c", "0x073132577e25b06937c64787089600886ede6202d085e6340242a5a32902e23e", "0x036b68238f3a90639d062669fdec08c4d0bdd09826b1b6d24ef49de6d8141eaa"], debt: "0x0491480f21299223b9ce770f23a2c383437f9fbf57abc2ac952e9af8cdb12c97" },
  { asset: ETH, supply: ["0x01fecadfe7cda2487c66291f2970a629be8eecdcb006ba4e71d1428c2b7605c7", "0x057146f6409deb4c9fa12866915dd952aa07c1eb2752e451d7f3b042086bdeb8", "0x07170f54dd61ae85377f75131359e3f4a12677589bb7ec5d61f362915a5c0982", "0x044debfe17e4d9a5a1e226dabaf286e72c9cc36abbe71c5b847e669da4503893"], debt: "0x00ba3037d968790ac486f70acaa9a1cab10cf5843bb85c986624b4d0e5a82e74" },
  { asset: USDC_E, supply: ["0x002fc2d4b41cc1f03d185e6681cbd40cced61915d4891517a042658d61cba3b1", "0x05dcd26c25d9d8fd9fc860038dcb6e4d835e524eb8a85213a8cda5b7fff845f6", "0x06eda767a143da12f70947192cd13ee0ccc077829002412570a88cd6539c1d85", "0x05f296e1b9f4cf1ab452c218e72e02a8713cee98921dad2d3b5706235e128ee4"], debt: "0x063d69ae657bd2f40337c39bf35a870ac27ddf91e6623c2f52529db4c1619a51" },
  { asset: DAI_V0, supply: ["0x022ccca3a16c9ef0df7d56cbdccd8c4a6f98356dfd11abc61a112483b242db90", "0x04f18ffc850cdfa223a530d7246d3c6fc12a5969e0aa5d4a88f470f5fe6c46e9", "0x02b5fd690bb9b126e3517f7abfb9db038e6a69a068303d06cf500c49c1388e20", "0x005c4676bcb21454659479b3cd0129884d914df9c9b922c1c649696d2e058d70"], debt: "0x066037c083c33330a8460a65e4748ceec275bbf5f28aa71b686cbc0010e12597" },
  { asset: USDT, supply: ["0x0360f9786a6595137f84f2d6931aaec09ceec476a94a98dcad2bb092c6c06701", "0x0453c4c996f1047d9370f824d68145bd5e7ce12d00437140ad02181e1d11dc83", "0x06669cb476aa7e6a29c18b59b54f30b8bfcfbb8444f09e7bbb06c10895bf5d7b", "0x0514bd7ee8c97d4286bd481c54aa0793e43edbfb7e1ab9784c4b30469dcf9313"], debt: "0x024e9b0d6bc79e111e6872bb1ada2a874c25712cf08dfc5bcf0de008a7cca55f" },
  { asset: WSTETH_LEGACY, supply: ["0x07e2c010c0b381f347926d5a203da0335ef17aefee75a89292ef2b0f94924864", "0x05eb6de9c7461b3270d029f00046c8a10d27d4f4a4c931a4ea9769c72ef4edbb", "0x00ca44c79a77bcb186f8cdd1a0cd222cc258bebc3bec29a0a020ba20fdca40e9", "0x009377fdde350e01e0397820ea83ed3b4f05df30bfb8cf8055d62cafa1b2106a"], debt: "0x0348cc417fc877a7868a66510e8e0d0f3f351f5e6b0886a86b652fcb30a3d1fb" },
  { asset: LORDS, supply: ["0x000d294e16a8d24c32eed65ea63757adde543d72bad4af3927f4c7c8969ff43d", "0x02530a305dd3d92aad5cf97e373a3d07577f6c859337fb0444b9e851ee4a2dd4", "0x0507eb06dd372cb5885d3aaf18b980c41cd3cd4691cfd3a820339a6c0cec2674", "0x0739760bce37f89b6c1e6b1198bb8dc7166b8cf21509032894f912c9d5de9cbd"], debt: "0x035778d24792bbebcf7651146896df5f787641af9e2a3db06480a637fbc9fff8" },
  { asset: STRK, supply: ["0x07c535ddb7bf3d3cb7c033bd1a4c3aac02927a4832da795606c0f3dbbc6efd17", "0x040f5a6b7a6d3c472c12ca31ae6250b462c6d35bbdae17bd52f6c6ca065e30cf", "0x026c5994c2462770bbf940552c5824fb0e0920e2a8a5ce1180042da1b3e489db", "0x07c2e1e733f28daa23e78be3a4f6c724c0ab06af65f6a95b5e0545215f1abc1b"], debt: "0x001258eae3eae5002125bebf062d611a772e8aea3a1879b64a19f363ebd00947" },
  { asset: NST_STRK, supply: ["0x04b11c750ae92c13fdcbe514f9c47ba6f8266c81014501baa8346d3b8ba55342", "0x0142af5b6c97f02cac9c91be1ea9895d855c5842825cb2180673796e54d73dc5", "0x078a40c85846e3303bf7982289ca7def68297d4b609d5f588208ac553cff3a18", "0x067a34ff63ec38d0ccb2817c6d3f01e8b0c4792c77845feb43571092dcf5ebb5"], debt: "0x0292be6baee291a148006db984f200dbdb34b12fb2136c70bfe88649c12d934b" },
  { asset: UNO, supply: ["0x01325caf7c91ee415b8df721fb952fa88486a0fc250063eafddd5d3c67867ce7", "0x02a3a9d7bcecc6d3121e3b6180b73c7e8f4c5f81c35a90c8dd457a70a842b723", "0x06757ef9960c5bc711d1ba7f7a3bff44a45ba9e28f2ac0cc63ee957e6cada8ea", "0x07d717fb27c9856ea10068d864465a2a8f9f669f4f78013967de06149c09b9af"], debt: "0x04b036839a8769c04144cc47415c64b083a2b26e4a7daa53c07f6042a0d35792" },
  { asset: NSTR, supply: ["0x02b674ffda238279de5550d6f996bf717228d316555f07a77ef0a082d925b782", "0x06f8ad459c712873993e9ffb9013a469248343c3d361e4d91a8cac6f98575834", "0x02589fc11f60f21af6a1dda3aeb7a44305c552928af122f2834d1c3b1a7aa626", "0x046ab56ec0c6a6d42384251c97e9331aa75eb693e05ed8823e2df4de5713e9a4"], debt: "0x03e0576565c1b51fcac3b402eb002447f21e97abb5da7011c0a2e0b465136814" },
  { asset: DAI, supply: ["0x0184dd6328115c2d5f038792e427f3d81d9552e40dd675e013ccbf74ba50b979", "0x036e722e04ef2ccadb9229b5415272353aaeb9554c989b83d4d932dba8dbe8f9", "0x065bde349f553cf4bdd873e54cd48317eda0542764ebe5ba46984cedd940a5e4", "0x000215cbd38a1e765cfd2c60bcb291c9d0b0bb7e7f56f682f0d3501303586185"], debt: "0x06726ec97bae4e28efa8993a8e0853bd4bad0bd71de44c23a1cd651b026b00e7" },
  { asset: EKUBO, supply: ["0x045863a5605ea7e77f2b043888a9efb1ff6e6b0fb9e62790ff987b2e084ca1f6", "0x06b1063a4d5c32fef3486bf29d1719eb09481b52d31f7d86a50c64b0b8d5defb", "0x006fd4a9efd0c884e0b29506169dd2fcad6b284d5bdbd46ede424abc26d71164", "0x02360bd006d42c1a17d23ebe7ae246a0764dea4ac86201884514f86754ccc7b8"], debt: "0x073fa792a8ad45303db3651c34176dc419bee98bfe45791ab12f884201a90ae2" },
  { asset: XSTRK, supply: ["0x06878fd475d5cea090934d690ecbe4ad78503124e4f80380a2e45eb417aafb9c", "0x01b8d8e31f9dd1bde7dc878dd871225504837c78c40ff01cbf03a255e2154bf0", "0x04d1125a716f547a0b69413c0098e811da3b799d173429c95da4290a00c139f7", "0x0257afe480da9255a026127cd3a295a580ef316b297a69be22b89729ae8c1d2a"], debt: "0x0424638c9060d08b4820aabbb28347fc7234e2b7aadab58ad0f101e2412ea42d" },
  { asset: BROTHER, supply: ["0x0674d79e17ae51cbf3b49d443266460dce15215277d9c3aedd7e1733112e9e52", "0x0296f271f5ec4f45c93c1fd351bd44117795f5ef80c5134137d7dc9fce3dc364", "0x00f7c7bf6267b4c19d531ccd959cc4fb6ca39bc04af8b173f8255567b5688636", "0x021bb27bc057be40e31752c53e7e8867b6d1b155ce46ae32454619adff0be777"], debt: "0x025a079284c3cd58bbed989250a169e7e52929070b4bcefaf8f0b9b7be77e5b1" },
  { asset: SSTRK, supply: ["0x0271f97bd18cdb2e7aff148db683be36891b0dbbffcd42024237a849ef7ad6cd", "0x01dd8cab616528ba64689a2b7f10bad1acd6bb4e2de3f4f5dab1839f7a89a82e", "0x024fbb2888e04b47f1bc1f3232528dcfc1ddf69d150b19241628e6d42b3545c6", "0x01fb33831f458b0786e1a041ac2e9df7603635a7caa88aa4ed30c23a787d4e3a"], debt: "0x004349ca3d519e1b1da9da5da3cf19e2039b1776a9fe98c529f95ead7964fe0d" },
];

/** Starknet addresses as 0x + 64 lowercase hex. */
export function starknetAddress(input: string): string {
  const value = input.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(value) || BigInt(value) >= 2n ** 251n) {
    throw new Error("That does not look like a Starknet address.");
  }
  return `0x${value.slice(2).padStart(64, "0")}`;
}

/** Hex felts compare by value. */
function felt(value: string): string {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function rpcUrl(): string {
  return process.env.STARKNET_RPC_URL || DEFAULT_RPC_URL;
}

const selectors = new Map<string, string>();
function selector(name: string): string {
  let value = selectors.get(name);
  if (!value) {
    value = hash.getSelectorFromName(name);
    selectors.set(name, value);
  }
  return value;
}

interface Call {
  contract: string;
  entrypoint: string;
  calldata?: string[];
}

function callParams(call: Call) {
  return {
    request: { contract_address: call.contract, entry_point_selector: selector(call.entrypoint), calldata: call.calldata ?? [] },
    block_id: "latest",
  };
}

/**
 * Many `starknet_call`s as JSON-RPC batches. A call that reverts comes back null. Falls back to
 * single calls when the node rejects batches; a timeout or unreachable node throws.
 */
async function callMany(calls: Call[], deps: ChainDeps): Promise<(string[] | null)[]> {
  const url = rpcUrl();
  const out: (string[] | null)[] = calls.map(() => null);
  const chunks: number[] = [];
  for (let i = 0; i < calls.length; i += BATCH) chunks.push(i);
  await Promise.all(
    chunks.map(async (start) => {
      const chunk = calls.slice(start, start + BATCH);
      let body: unknown = null;
      try {
        body = await getJson<unknown>(
          url,
          {
            method: "POST",
            body: JSON.stringify(chunk.map((call, i) => ({ jsonrpc: "2.0", id: start + i, method: "starknet_call", params: callParams(call) }))),
            timeoutMs: TIMEOUT_MS,
          },
          deps,
        );
      } catch (error) {
        if (error instanceof Error && /timed out|fetch failed|returned 429/i.test(error.message)) throw error;
      }
      if (Array.isArray(body)) {
        for (const item of body as { id?: number; result?: unknown }[]) {
          if (typeof item.id === "number" && Array.isArray(item.result)) out[item.id] = item.result as string[];
        }
        return;
      }
      const single = await Promise.all(
        chunk.map((call) => rpc<string[]>(url, "starknet_call", callParams(call), deps).catch(() => null)),
      );
      single.forEach((result, i) => (out[start + i] = Array.isArray(result) ? result : null));
    }),
  );
  return out;
}

/** A u256 returned as [low, high] (or a single felt). */
function u256(result: string[] | null): bigint {
  if (!result?.length) return 0n;
  const low = BigInt(result[0]);
  return result.length > 1 ? low + (BigInt(result[1]) << 128n) : low;
}

/** A Cairo short string (one felt) or ByteArray ([words, …, pending, pending_len]). */
function shortString(result: string[] | null): string {
  if (!result?.length) return "";
  const decode = (value: string, length?: number) => {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    if (length != null) hex = hex.padStart(length * 2, "0");
    return Buffer.from(hex, "hex").toString("latin1").replace(/\0/g, "");
  };
  if (result.length === 1) return decode(result[0]);
  const words = Number(BigInt(result[0]));
  if (result.length !== words + 3) return decode(result[0]);
  const full = result.slice(1, 1 + words).map((word) => decode(word, 31)).join("");
  const pendingLength = Number(BigInt(result[words + 2]));
  return full + (pendingLength ? decode(result[words + 1], pendingLength) : "");
}

function priceKeys(token: Token): string[] {
  return [`starknet:${token.address}`, ...(token.cg ? [`coingecko:${token.cg}`] : [])];
}

function priceOf(prices: Record<string, number>, token: Token): number | undefined {
  return prices[`starknet:${token.address}`] ?? (token.cg ? prices[`coingecko:${token.cg}`] : undefined);
}

// ---------- Wallet ----------

async function readBalances(owner: string, deps: ChainDeps): Promise<{ token: Token; amount: number }[]> {
  const results = await callMany(
    TOKENS.map((token) => ({ contract: token.address, entrypoint: "balanceOf", calldata: [owner] })),
    deps,
  );
  if (results.every((result) => result === null)) throw new Error("Starknet RPC returned no balances");
  return TOKENS.map((token, i) => ({ token, amount: units(u256(results[i]), token.decimals) })).filter((row) => row.amount > 0);
}

// ---------- Vesu ----------

interface VesuValue {
  value?: string;
  decimals?: number;
}

interface VesuToken extends VesuValue {
  address?: string;
  symbol?: string;
  usdPrice?: VesuValue;
}

interface VesuPosition {
  type?: "earn" | "borrow" | "multiply";
  pool?: { id?: string; name?: string };
  collateral?: VesuToken;
  debt?: VesuToken;
  ltv?: { max?: VesuValue; current?: VesuValue };
  healthFactor?: string | null;
}

interface VesuMarket {
  pool?: { id?: string };
  address?: string;
  stats?: { supplyApy?: VesuValue; borrowApr?: VesuValue };
}

function vesuNumber(value: VesuValue | undefined): number | undefined {
  if (!value?.value || value.decimals == null) return undefined;
  try {
    const n = units(BigInt(value.value), value.decimals);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    const n = Number(value.value) / 10 ** value.decimals;
    return Number.isFinite(n) ? n : undefined;
  }
}

function vesuHealth(position: VesuPosition): number | null {
  const reported = Number(position.healthFactor ?? NaN);
  if (Number.isFinite(reported) && reported > 0) return reported > 1e9 ? reported / 1e18 : reported;
  const max = vesuNumber(position.ltv?.max);
  const current = vesuNumber(position.ltv?.current);
  return max && current ? max / current : null;
}

async function readVesu(owner: string, deps: ChainDeps) {
  const [positions, markets] = await Promise.all([
    getJson<{ data?: VesuPosition[] }>(`${VESU_API}/positions?walletAddress=${owner}`, { timeoutMs: TIMEOUT_MS }, deps),
    getJson<{ data?: VesuMarket[] }>(`${VESU_API}/markets`, { timeoutMs: TIMEOUT_MS }, deps).catch(() => null),
  ]);
  const rates = new Map<string, { supply: number; borrow: number }>();
  for (const market of markets?.data ?? []) {
    if (!market.pool?.id || !market.address) continue;
    rates.set(`${felt(market.pool.id)}:${felt(market.address)}`, {
      supply: vesuNumber(market.stats?.supplyApy) ?? 0,
      borrow: vesuNumber(market.stats?.borrowApr) ?? 0,
    });
  }
  return { positions: positions.data ?? [], rates };
}

function vesuPositions(owner: string, read: Awaited<ReturnType<typeof readVesu>>): Position[] {
  const out: Position[] = [];
  for (const position of read.positions) {
    const pool = position.pool?.id;
    const { collateral, debt } = position;
    if (!pool || !collateral?.address) continue;
    const rate = (token: VesuToken) => read.rates.get(`${felt(pool)}:${felt(token.address ?? "0x0")}`);
    const leg = (token: VesuToken, side: Leg["side"]) =>
      legOf({
        id: `vesu:${pool}:${side}:${token.address}`,
        side,
        symbol: token.symbol ?? "?",
        amount: vesuNumber(token) ?? 0,
        price: vesuNumber(token.usdPrice),
        apy: side === "supply" ? rate(token)?.supply : rate(token)?.borrow,
        isCollateral: side === "supply" ? position.type !== "earn" : undefined,
      });
    const legs = [leg(collateral, "supply"), ...(debt?.address ? [leg(debt, "borrow")] : [])];
    const hasDebt = legs.some((l) => l.side === "borrow" && l.amount > 0);
    const entry = positionOf({
      protocol: "starknet",
      app: "Vesu",
      category: "lending",
      chain: CHAIN,
      wallet: owner,
      key: `${pool}:${collateral.address}:${debt?.address ?? "earn"}`,
      label: `Vesu${position.pool?.name ? ` ${position.pool.name}` : ""} · ${legs.map((l) => l.symbol).join("/")}`,
      legs,
      healthFactor: hasDebt ? vesuHealth(position) : null,
      note: position.type === "multiply" ? "Multiply position" : undefined,
    });
    if (entry) out.push(entry);
  }
  return out;
}

// ---------- Nostra ----------

interface NostraHolding {
  asset: Token;
  token: string;
  collateral: boolean;
  amount: number;
}

interface NostraRead {
  supply: NostraHolding[];
  debt: { asset: Token; amount: number }[];
  rates: Map<string, { supply: number; borrow: number }>;
}

async function readNostra(owner: string, deps: ChainDeps): Promise<NostraRead> {
  const tokens = NOSTRA.flatMap((market) => [
    ...market.supply.map((token, index) => ({ market, token, index, debt: false })),
    { market, token: market.debt, index: -1, debt: true },
  ]);
  const balances = await callMany(tokens.map((row) => ({ contract: row.token, entrypoint: "balanceOf", calldata: [owner] })), deps);
  if (balances.every((result) => result === null)) throw new Error("no token balances returned");
  const held = tokens
    .map((row, i) => ({ ...row, amount: units(u256(balances[i]), row.market.asset.decimals) }))
    .filter((row) => row.amount > 0);
  const supplyRows = held.filter((row) => !row.debt);
  const markets = [...new Set(held.map((row) => row.market))];
  const [symbols, states] = await Promise.all([
    supplyRows.length
      ? callMany(supplyRows.map((row) => ({ contract: row.token, entrypoint: "symbol" })), deps).catch(() => supplyRows.map(() => null))
      : Promise.resolve([]),
    markets.length
      ? callMany(markets.map((m) => ({ contract: NOSTRA_IRM, entrypoint: "getInterestState", calldata: [m.debt] })), deps).catch(() =>
          markets.map(() => null),
        )
      : Promise.resolve([]),
  ]);
  const rates = new Map<string, { supply: number; borrow: number }>();
  markets.forEach((market, i) => {
    const state = states[i];
    if (!state || state.length < 4) return;
    rates.set(market.debt, {
      supply: units(u256(state.slice(0, 2)), 18),
      borrow: units(u256(state.slice(2, 4)), 18),
    });
  });
  return {
    supply: supplyRows.map((row, i) => {
      const symbol = shortString(symbols[i] ?? null);
      return { asset: row.market.asset, token: row.token, collateral: symbol ? symbol.endsWith("-c") : row.index >= 2, amount: row.amount };
    }),
    debt: held.filter((row) => row.debt).map((row) => ({ asset: row.market.asset, amount: row.amount })),
    rates,
  };
}

function nostraDebt(asset: Token): string {
  return NOSTRA.find((market) => market.asset === asset)?.debt ?? "";
}

// ---------- Reader ----------

export const readStarknet: ChainReader = async (address, deps = {}) => {
  const owner = starknetAddress(address);
  const notes: string[] = [];
  const [balances, vesu, nostra] = await Promise.all([
    readBalances(owner, deps),
    readApp("Vesu", notes, () => readVesu(owner, deps)),
    readApp("Nostra", notes, () => readNostra(owner, deps)),
  ]);

  const priced = [...balances.map((row) => row.token), ...(nostra?.supply ?? []).map((row) => row.asset), ...(nostra?.debt ?? []).map((row) => row.asset)];
  const prices = await llamaPrices(priced.flatMap(priceKeys), deps);

  const spot = balances
    .map(({ token, amount }) =>
      spotRow({ protocol: "starknet", wallet: owner, chain: CHAIN, symbol: token.symbol, amount, price: priceOf(prices, token), tokenId: token.address }),
    )
    .filter((row): row is SpotHolding => row !== null)
    .sort((a, b) => b.usd - a.usd);

  const positions: Position[] = vesu ? vesuPositions(owner, vesu) : [];

  if (nostra) {
    const legs: Leg[] = [
      ...nostra.supply.map((row) =>
        legOf({
          id: `nostra:supply:${row.token}`,
          side: "supply",
          symbol: row.asset.symbol,
          amount: row.amount,
          price: priceOf(prices, row.asset),
          apy: nostra.rates.get(nostraDebt(row.asset))?.supply,
          isCollateral: row.collateral,
        }),
      ),
      ...nostra.debt.map((row) =>
        legOf({
          id: `nostra:borrow:${row.asset.address}`,
          side: "borrow",
          symbol: row.asset.symbol,
          amount: row.amount,
          price: priceOf(prices, row.asset),
          apy: nostra.rates.get(nostraDebt(row.asset))?.borrow,
        }),
      ),
    ];
    const position = positionOf({ protocol: "starknet", app: "Nostra", category: "lending", chain: CHAIN, wallet: owner, legs });
    if (position) positions.push(position);
  }

  return { positions, spot, notes } satisfies ChainRead;
};
