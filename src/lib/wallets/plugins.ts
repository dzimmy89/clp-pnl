"use client";

import type { PluginChain } from "@/lib/auth/message";
import type { ClientChainModule } from "@/lib/auth/chains/types";
import { aptosWallets } from "./aptos";
import { cardanoWallets } from "./cardano";
import { cosmosWallets } from "./cosmos";
import { kaspaWallets } from "./kaspa";
import { starknetWallets } from "./starknet";
import { suiWallets } from "./sui";
import { tonWallets } from "./ton";
import { tronWallets } from "./tron";

/** Browser signers for the plugin chains, in the order the wallet picker shows them. */
export const PLUGIN_WALLETS: Record<PluginChain, ClientChainModule> = {
  sui: suiWallets,
  aptos: aptosWallets,
  ton: tonWallets,
  tron: tronWallets,
  cosmos: cosmosWallets,
  starknet: starknetWallets,
  cardano: cardanoWallets,
  kaspa: kaspaWallets,
};

export const PLUGIN_CHAINS = Object.keys(PLUGIN_WALLETS) as PluginChain[];
