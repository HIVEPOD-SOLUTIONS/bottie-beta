import { AppKit, Blockchain, BridgeChain, UnifiedBalanceChain } from "@circle-fin/app-kit";

export const arcKit = new AppKit();

// ── Network mode flag ─────────────────────────────────────────────────────────
// true = Solana mainnet is active (Solana bridge option is enabled, balance queries use mainnet).
// Arc AppKit supports Solana bridge on mainnet only.
export const SOLANA_ARC_MAINNET_ENABLED = true;

// ── Agent chain ───────────────────────────────────────────────────────────────
// Base mainnet — where the user's EVM wallet holds USDC for payments.
// This is the default chain for direct ArcKit sends (e.g. usdc_base).
// Payment methods on other chains (Ethereum, Polygon, Arbitrum, BSC)
// pass their own Blockchain value via the BITREFILL_EVM_CHAINS map.
export const AGENT_CHAIN = Blockchain.Base;

// ── Solana chain constants ────────────────────────────────────────────────────
// All on mainnet. Arc AppKit supports Solana bridge on mainnet only.
export const SOLANA_ARC_CHAIN        = Blockchain.Solana;
export const SOLANA_ARC_BRIDGE_CHAIN = BridgeChain.Solana;
// Always "Solana" (mainnet) — SOLANA_ARC_MAINNET_ENABLED = true
export const SOLANA_ARC_BALANCE_CHAIN = "Solana" as const;

// ── Bridge source options ─────────────────────────────────────────────────────
// Mainnet chains only. Solana requires the Solana adapter (NonEVMChainDefinition).
export const BRIDGE_SOURCE_OPTIONS = [
  { value: BridgeChain.Ethereum, label: "Ethereum",  icon: "⟠",  disabled: false },
  { value: BridgeChain.Arbitrum, label: "Arbitrum",  icon: "🔵", disabled: false },
  { value: BridgeChain.Optimism, label: "Optimism",  icon: "🔴", disabled: false },
  { value: BridgeChain.Avalanche,label: "Avalanche", icon: "🔺", disabled: false },
  { value: BridgeChain.Polygon,  label: "Polygon",   icon: "🟣", disabled: false },
  { value: BridgeChain.Linea,    label: "Linea",     icon: "⬜", disabled: false },
  { value: BridgeChain.Base,     label: "Base",      icon: "🔷", disabled: false },
  { value: BridgeChain.Solana,   label: "Solana",    icon: "◎",  disabled: !SOLANA_ARC_MAINNET_ENABLED },
] as const;

export type BridgeSourceOption = (typeof BRIDGE_SOURCE_OPTIONS)[number];
export type BridgeSourceChain  = BridgeSourceOption["value"];
