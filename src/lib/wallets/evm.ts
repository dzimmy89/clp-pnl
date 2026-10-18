"use client";

/** EIP-1193 provider, the shape every injected EVM wallet exposes. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface EvmWallet {
  id: string;
  name: string;
  icon: string;
  provider: Eip1193Provider;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

const found = new Map<string, EvmWallet>();
let listening = false;

/**
 * EIP-6963: each installed wallet (MetaMask, Rabby, Coinbase, Phantom, OKX…) announces
 * itself, so several can coexist without fighting over window.ethereum.
 */
export function discoverEvmWallets(onChange: () => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail;
    if (!detail?.info?.rdns || !detail.provider) return;
    found.set(detail.info.rdns, {
      id: detail.info.rdns,
      name: detail.info.name,
      icon: detail.info.icon,
      provider: detail.provider,
    });
    onChange();
  };
  window.addEventListener("eip6963:announceProvider", handler);
  listening = true;
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => {
    window.removeEventListener("eip6963:announceProvider", handler);
    listening = false;
  };
}

export function evmWallets(): EvmWallet[] {
  const list = [...found.values()];
  // Older wallets that only set window.ethereum.
  const legacy = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!list.length && legacy && listening) {
    list.push({ id: "injected", name: "Browser wallet", icon: "", provider: legacy });
  }
  const walletConnect = walletConnectWallet();
  if (walletConnect) list.push(walletConnect);
  return list;
}

const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
let walletConnectEntry: EvmWallet | null = null;

/**
 * WalletConnect: a QR code (or a deep link on a phone) for mobile wallets such as MetaMask
 * Mobile, Rainbow, Trust and Uniswap. Needs a free project id from cloud.reown.com, set as
 * NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID. The SDK is only downloaded when someone picks it.
 */
function walletConnectWallet(): EvmWallet | null {
  if (!WALLETCONNECT_PROJECT_ID) return null;
  if (walletConnectEntry) return walletConnectEntry;
  type WcProvider = Eip1193Provider & { enable(): Promise<string[]>; disconnect(): Promise<void>; session?: unknown };
  let ready: Promise<WcProvider> | null = null;
  const load = () =>
    (ready ??= import("@walletconnect/ethereum-provider").then(({ EthereumProvider }) =>
      EthereumProvider.init({
        projectId: WALLETCONNECT_PROJECT_ID,
        chains: [1],
        optionalChains: [10, 56, 137, 8453, 42161, 43114, 59144, 534352, 999],
        showQrModal: true,
        metadata: {
          name: "Omnifolio",
          description: "Every wallet, one portfolio",
          url: window.location.origin,
          icons: [`${window.location.origin}/apple-icon`],
        },
      }) as unknown as Promise<WcProvider>,
    ));
  walletConnectEntry = {
    id: "walletconnect",
    name: "WalletConnect",
    icon: "",
    provider: {
      async request(args) {
        const provider = await load();
        if (args.method === "eth_requestAccounts") {
          // Start from a fresh pairing so the QR always appears for a new sign-in.
          if (provider.session) await provider.disconnect().catch(() => {});
          return provider.enable();
        }
        return provider.request(args);
      },
    },
  };
  return walletConnectEntry;
}

export async function connectEvm(wallet: EvmWallet): Promise<{ address: string; chainId: number }> {
  const accounts = (await wallet.provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("The wallet returned no account");
  const chainHex = (await wallet.provider.request({ method: "eth_chainId" })) as string;
  return { address: accounts[0], chainId: Number.parseInt(chainHex, 16) || 1 };
}

export async function signEvm(wallet: EvmWallet, address: string, message: string): Promise<string> {
  const hex = `0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return (await wallet.provider.request({ method: "personal_sign", params: [hex, address] })) as string;
}
