/**
 * Per-chain sign-in plugins. Each non-EVM/Solana/NEAR chain lives in its own file under
 * `src/lib/auth/chains/<chain>.ts` (server verifier) and `src/lib/wallets/<chain>.ts`
 * (browser signer), so chains can be added without touching each other.
 */

/** What the server has when it checks a sign-in for one chain. */
export interface ChainProof {
  /** Address as the client sent it. Run it through `normalize` before trusting it. */
  address: string;
  /**
   * The canonical sign-in text the server rebuilt with its own host and the nonce.
   * Whatever the wallet signed must contain or commit to exactly this text (or, for chains
   * whose wallets sign a fixed envelope such as TON Connect, bind the nonce and domain).
   */
  message: string;
  /** Signature in the chain's usual encoding (documented per chain). */
  signature: string;
  /** Public key, when the chain's signature doesn't let you recover it. Encoding per chain. */
  publicKey?: string;
  /**
   * The exact bytes or envelope the wallet signed when it wraps our text
   * (e.g. Aptos `fullMessage`, a TON Connect proof JSON). Encoding per chain.
   */
  signedMessage?: string;
  /** Any other chain-specific fields, as strings. */
  extra?: Record<string, string>;
  /** Host the server serves (e.g. `omnifolio.vercel.app`); the proof must be bound to it. */
  domain: string;
  /** 64-hex server nonce, single use. */
  nonce: string;
}

export interface ChainVerifyDeps {
  /** For verifiers that must read chain state (key lookups). Swappable in tests. */
  fetch?: typeof fetch;
}

export interface ChainVerifier {
  /** Canonical address used as the unique key; throws on an invalid address. */
  normalize(address: string): string;
  /** True only when the proof shows control of `normalize(address)` over this message. */
  verify(proof: ChainProof, deps?: ChainVerifyDeps): Promise<boolean>;
}

/** What a browser signer hands back. Mirrors the optional fields of ChainProof. */
export interface ClientSigned {
  address: string;
  signature: string;
  publicKey?: string;
  signedMessage?: string;
  extra?: Record<string, string>;
}

export interface ClientWallet {
  /** Stable per wallet, e.g. `sui:Slush`. */
  id: string;
  name: string;
  /** data: URI or https URL, when the wallet supplies one. */
  icon?: string;
}

export interface ClientChainModule {
  /** Wallets detected in this browser right now. Must not throw during SSR (return []). */
  list(): ClientWallet[];
  /** Calls `onChange` when wallets appear or disappear. Returns an unsubscribe. */
  watch(onChange: () => void): () => void;
  /**
   * Connects, then signs. `build(address)` returns the exact sign-in text for the address the
   * wallet connected with; `nonce` and `domain` are there for envelopes like TON Connect.
   */
  signIn(wallet: ClientWallet, build: (address: string) => string, ctx: { nonce: string; domain: string }): Promise<ClientSigned>;
  /** Shown when no wallet for this chain is installed. */
  installHint: string;
}
