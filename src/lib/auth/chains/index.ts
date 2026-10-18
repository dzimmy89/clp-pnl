import type { PluginChain } from "@/lib/auth/message";
import type { ChainVerifier } from "./types";
import { aptos } from "./aptos";
import { cardano } from "./cardano";
import { cosmos } from "./cosmos";
import { kaspa } from "./kaspa";
import { starknet } from "./starknet";
import { sui } from "./sui";
import { ton } from "./ton";
import { tron } from "./tron";

const VERIFIERS: Record<PluginChain, ChainVerifier> = { sui, aptos, ton, tron, cosmos, starknet, cardano, kaspa };

export function chainVerifier(chain: PluginChain): ChainVerifier {
  return VERIFIERS[chain];
}
