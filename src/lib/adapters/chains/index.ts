import type { ChainReader } from "@/lib/adapters/chains/common";
import { readAptos } from "@/lib/adapters/chains/aptos";
import { readCardano } from "@/lib/adapters/chains/cardano";
import { readCosmos } from "@/lib/adapters/chains/cosmos";
import { readKaspa } from "@/lib/adapters/chains/kaspa";
import { readSolanaApps } from "@/lib/adapters/chains/solana-apps";
import { readStarknet } from "@/lib/adapters/chains/starknet";
import { readSui } from "@/lib/adapters/chains/sui";
import { readTon } from "@/lib/adapters/chains/ton";
import { readTron } from "@/lib/adapters/chains/tron";
import type { ProtocolId, WalletKind } from "@/lib/types";

export type ChainReaderId = Extract<
  ProtocolId,
  "solana-apps" | "sui" | "aptos" | "ton" | "tron" | "cosmos" | "starknet" | "cardano" | "kaspa"
>;

/** Each whole-chain reader and the kind of wallet it reads. */
export const CHAIN_READERS: Record<ChainReaderId, { kind: WalletKind; read: ChainReader; connectHint: string }> = {
  "solana-apps": { kind: "solana", read: readSolanaApps, connectHint: "Add a Solana wallet." },
  sui: { kind: "sui", read: readSui, connectHint: "Connect a Sui wallet." },
  aptos: { kind: "aptos", read: readAptos, connectHint: "Connect an Aptos wallet." },
  ton: { kind: "ton", read: readTon, connectHint: "Connect a TON wallet." },
  tron: { kind: "tron", read: readTron, connectHint: "Connect a Tron wallet." },
  cosmos: { kind: "cosmos", read: readCosmos, connectHint: "Connect a Cosmos wallet." },
  starknet: { kind: "starknet", read: readStarknet, connectHint: "Connect a Starknet wallet." },
  cardano: { kind: "cardano", read: readCardano, connectHint: "Connect a Cardano wallet." },
  kaspa: { kind: "kaspa", read: readKaspa, connectHint: "Connect a Kaspa wallet." },
};
