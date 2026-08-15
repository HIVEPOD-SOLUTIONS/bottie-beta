"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";
import { useSignTransaction } from "@privy-io/react-auth/solana";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { useChatSheet } from "@/contexts/chat-context";
import { getUserFirstName, getTimeBasedGreeting } from "@/lib/user-display-name";
import { useDemoState } from "@/contexts/demo-state-context";
import { MessageBubble } from "./message-bubble";
import { ThinkingIndicator } from "./thinking-indicator";
import { ToolApprovalCard } from "./tool-approval-card";
import { ToolResultCard } from "./tool-result-card";

const ER_RPC = "https://flash.magicblock.xyz";

// Perpetuals instructions target the MagicBlock ER validator directly.
// Everything else (WithAction: swap, liquidity, staking, rewards, migration, referral) goes to base Solana.
const ER_ACTIONS = new Set([
  "open_position", "close_position", "increase_position",
  "add_collateral", "remove_collateral",
  "limit_order", "trigger_order", "cancel_order", "cancel_all_triggers",
  "edit_limit_order", "edit_trigger_order",
]);

const FLASH_ACTION_LABELS: Record<string, string> = {
  open_position: "Open Position",
  close_position: "Close Position",
  limit_order: "Place Limit Order",
  trigger_order: "Place Trigger",
  cancel_order: "Cancel Order",
  add_collateral: "Add Collateral",
  remove_collateral: "Remove Collateral",
  swap: "Swap Tokens",
  add_liquidity: "Add Liquidity",
  remove_liquidity: "Remove Liquidity",
  add_compounding: "Add sFLP Liquidity",
  remove_compounding: "Remove sFLP Liquidity",
  stake_flash: "Stake FLASH",
  unstake_flash: "Unstake FLASH",
  cancel_unstake: "Cancel Unstake",
  withdraw_flash: "Withdraw FLASH",
  collect_stake_reward: "Collect Staking Rewards",
  collect_flp_reward: "Collect FLP Rewards",
  collect_rebate: "Collect Rebates",
  collect_revenue: "Collect Referral Revenue",
  cancel_all_triggers: "Cancel All Triggers",
  migrate_to_sflp: "Migrate FLP → sFLP",
  migrate_to_flp: "Migrate sFLP → FLP",
  deposit_to_vault: "Deposit to Trade Vault",
  withdraw_from_vault: "Withdraw from Trade Vault",
  increase_position: "Increase Position",
  edit_limit_order: "Edit Limit Order",
  edit_trigger_order: "Edit Trigger Order",
  revoke_session: "End Trading Session",
  create_referral: "Set Referral",
};

const SESSION_KEY = "flash_session_keypair";
const SOL_RPC = "https://api.mainnet-beta.solana.com";

function loadActiveSession(): { keypair: Keypair; expiresAt: number } | null {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(SESSION_KEY) : null;
    if (!raw) return null;
    const { secretKey, expiresAt } = JSON.parse(raw) as { secretKey: number[]; expiresAt: number };
    if (Date.now() >= expiresAt) return null;
    return { keypair: Keypair.fromSecretKey(new Uint8Array(secretKey)), expiresAt };
  } catch { return null; }
}

// ── Roaster chat cards ────────────────────────────────────────────────────────

function RoasterBondCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: { pendingRoasterBond: true; battle_id: string; bond_transaction: string; solanaAddress: string };
  addToolResult: (args: { toolCallId: string; result: unknown }) => void;
}) {
  const { signTransaction } = useSignTransaction();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setBusy(true); setError(null);
    try {
      const conn = new Connection(SOL_RPC, "confirmed");
      const raw = Buffer.from(output.bond_transaction, "base64");
      const signed: Uint8Array = await (signTransaction as any)({ transaction: raw });
      const sig = await conn.sendRawTransaction(signed, { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");
      setDone(true);
      addToolResult({ toolCallId, result: { success: true, battle_id: output.battle_id, signature: sig } });
    } catch (err: any) {
      const msg = err?.message ?? "Transaction failed";
      setError(msg);
      addToolResult({ toolCallId, result: { success: false, error: msg } });
    } finally { setBusy(false); }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, result: { success: false, error: "User cancelled" } });
    setDone(true);
  };

  if (done && !error) {
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
        ✓ Battle created on-chain — open Invest → Roaster to see it
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">🎤</span>
        <div>
          <p className="font-medium text-ink text-sm">Create Rap Battle</p>
          <p className="text-xs text-ink/50">Roaster · Solana · 10 USDC bond</p>
        </div>
      </div>
      <div className="rounded-lg bg-ink/5 p-2 text-xs space-y-1">
        <div className="flex justify-between gap-2">
          <span className="text-ink/50">Battle ID</span>
          <span className="text-ink font-mono">{output.battle_id.slice(0, 12)}…</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink/50">Creation bond</span>
          <span className="text-ink">10 USDC (non-refundable)</span>
        </div>
      </div>
      <p className="text-xs text-ink/40">This signs an on-chain transaction to deposit the 10 USDC creation bond into the battle vault.</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button onClick={handleReject} disabled={busy} className="flex-1 rounded-lg border border-border py-2 text-sm text-ink/60 hover:bg-ink/5 transition-colors">Cancel</button>
        <button onClick={handleApprove} disabled={busy} className="flex-1 rounded-lg bg-ink py-2 text-sm font-medium text-cream hover:opacity-80 transition-opacity disabled:opacity-50">
          {busy ? "Signing…" : "Pay Bond & Create"}
        </button>
      </div>
    </div>
  );
}

function RoasterBackCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: { pendingRoasterBack: true; battle_id: string; side: number; amount_usdc: number; platform_fee_usdc: number; time_weight: number; transaction: string; solanaAddress: string };
  addToolResult: (args: { toolCallId: string; result: unknown }) => void;
}) {
  const { signTransaction } = useSignTransaction();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setBusy(true); setError(null);
    try {
      const conn = new Connection(SOL_RPC, "confirmed");
      const raw = Buffer.from(output.transaction, "base64");
      const signed: Uint8Array = await (signTransaction as any)({ transaction: raw });
      const sig = await conn.sendRawTransaction(signed, { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");
      setDone(true);
      addToolResult({ toolCallId, result: { success: true, battle_id: output.battle_id, side: output.side, amount_usdc: output.amount_usdc, signature: sig } });
    } catch (err: any) {
      const msg = err?.message ?? "Transaction failed";
      setError(msg);
      addToolResult({ toolCallId, result: { success: false, error: msg } });
    } finally { setBusy(false); }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, result: { success: false, error: "User cancelled" } });
    setDone(true);
  };

  if (done && !error) {
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
        ✓ Backed Side {output.side === 0 ? "A" : "B"} with ${output.amount_usdc.toFixed(2)} USDC
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">💰</span>
        <div>
          <p className="font-medium text-ink text-sm">Back Side {output.side === 0 ? "A" : "B"}</p>
          <p className="text-xs text-ink/50">Roaster · Solana · Parimutuel pool</p>
        </div>
      </div>
      <div className="rounded-lg bg-ink/5 p-2 text-xs space-y-1">
        <div className="flex justify-between gap-2">
          <span className="text-ink/50">Amount</span>
          <span className="text-ink">${output.amount_usdc.toFixed(2)} USDC</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink/50">Platform fee (1.25%)</span>
          <span className="text-ink">-${(output.platform_fee_usdc ?? output.amount_usdc * 0.0125).toFixed(4)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink/50">Time weight</span>
          <span className="text-ink">{output.time_weight?.toFixed(3) ?? "—"}</span>
        </div>
      </div>
      <p className="text-xs text-ink/40">Earlier backing earns a higher time-weight and a larger share of winnings if your side wins.</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button onClick={handleReject} disabled={busy} className="flex-1 rounded-lg border border-border py-2 text-sm text-ink/60 hover:bg-ink/5 transition-colors">Cancel</button>
        <button onClick={handleApprove} disabled={busy} className="flex-1 rounded-lg bg-ink py-2 text-sm font-medium text-cream hover:opacity-80 transition-opacity disabled:opacity-50">
          {busy ? "Signing…" : "Confirm & Back"}
        </button>
      </div>
    </div>
  );
}

// ── Velvet EVM transaction approval card ─────────────────────────────────────

const VELVET_PENDING_LABELS: Record<string, string> = {
  pendingDeposit:          "Deposit into Vault",
  pendingWithdrawal:       "Withdraw from Vault",
  pendingRebalance:        "Rebalance Portfolio",
  pendingRemoveToken:      "Remove Token from Vault",
  pendingFeeProposal:      "Propose Fee Change",
  pendingFeeAction:        "Apply Fee Change",
  pendingWhitelistUpdate:  "Update Whitelist",
  pendingSettingsUpdate:   "Update Vault Settings",
  pendingCollateralUpdate: "Update Collateral",
  pendingBorrow:           "Borrow Against Vault",
  pendingClaim:            "Claim Removed Tokens",
  pendingWeightUpdate:     "Rebalance Vault Weights",
};

// ── Bitrefill payment card — handles actual USDC transfer for AI-initiated purchases ──

const BITREFILL_SMART_WALLET_TOKENS: Record<string, { contract: `0x${string}`; chainId: number }> = {
  usdc_base:     { contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chainId: 8453  },
  usdt_base:     { contract: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", chainId: 8453  },
  usdc_erc20:    { contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1     },
  usdt_erc20:    { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", chainId: 1     },
  usdc_polygon:  { contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", chainId: 137   },
  usdt_polygon:  { contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", chainId: 137   },
  usdc_arbitrum: { contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", chainId: 42161 },
  usdt_arbitrum: { contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", chainId: 42161 },
  usdc_optimism: { contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", chainId: 10    },
  usdt_optimism: { contract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", chainId: 10    },
};

function BitrefillPaymentCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: {
    invoiceId: string;
    paymentMethod: string;
    paymentAddress: string;
    paymentAmount: number | string;
    paymentCurrency: string;
    isTopup?: boolean;
    expiresInMinutes?: number;
  };
  addToolResult: (args: { toolCallId: string; result: unknown }) => void;
}) {
  const { wallets } = useWallets();
  const { client: smartWalletClient } = useSmartWallets();
  const [state, setState] = useState<"idle" | "paying" | "done" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Derive a human-readable currency label from paymentMethod when paymentCurrency is absent.
  // Bitrefill's invoice sometimes omits the currency string for EVM methods.
  const currencyLabel =
    output.paymentCurrency ||
    (output.paymentMethod?.includes("usdt") ? "USDT" : "USDC");

  const handlePay = async () => {
    setState("paying");
    setErrMsg(null);
    try {
      const pm = output.paymentMethod ?? "usdc_base";
      const isSolana = pm.includes("solana");

      if (isSolana) {
        const solWallet = wallets.find((w) => (w as any).chainType === "solana");
        if (!solWallet) throw new Error("No Solana wallet connected");
        const provider = await (solWallet as any).getSolanaProvider?.();
        if (!provider) throw new Error("Solana provider unavailable");
        const { createSolanaAdapterFromProvider } = await import("@circle-fin/adapter-solana");
        const { arcKit, SOLANA_ARC_CHAIN } = await import("@/lib/arc-kit");
        const adapter = await createSolanaAdapterFromProvider({ provider });
        const token = pm.includes("usdt") ? "USDT" : "USDC";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await arcKit.send({ from: { adapter: adapter as any, chain: SOLANA_ARC_CHAIN }, to: output.paymentAddress, amount: String(output.paymentAmount), token });
      } else {
        const swConfig = BITREFILL_SMART_WALLET_TOKENS[pm];
        let swSucceeded = false;

        if (swConfig && smartWalletClient) {
          try {
            const { encodeFunctionData, erc20Abi, parseUnits } = await import("viem");
            const calldata = encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [output.paymentAddress as `0x${string}`, parseUnits(String(output.paymentAmount), 6)],
            });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await smartWalletClient.sendTransaction({ calls: [{ to: swConfig.contract, data: calldata }], chain: { id: swConfig.chainId } as any });
            swSucceeded = true;
          } catch (swErr: unknown) {
            console.warn("[chat/bitrefill] Smart wallet failed, falling back to EOA:", (swErr as Error)?.message);
          }
        }

        if (!swSucceeded) {
          const { createViemAdapterFromProvider } = await import("@circle-fin/adapter-viem-v2");
          const { arcKit, AGENT_CHAIN } = await import("@/lib/arc-kit");
          const { Blockchain } = await import("@circle-fin/app-kit");
          const EVM_CHAIN_MAP: Record<string, typeof Blockchain[keyof typeof Blockchain]> = {
            usdc_base:     Blockchain.Base,
            usdc_erc20:    Blockchain.Ethereum,
            usdt_erc20:    Blockchain.Ethereum,
            usdc_polygon:  Blockchain.Polygon,
            usdt_polygon:  Blockchain.Polygon,
            usdc_arbitrum: Blockchain.Arbitrum,
            usdt_arbitrum: Blockchain.Arbitrum,
          };
          const privyWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
          if (!privyWallet) throw new Error("No EVM wallet connected");
          const provider = await privyWallet.getEthereumProvider();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const adapter = await createViemAdapterFromProvider({ provider: provider as any });
          const chain = EVM_CHAIN_MAP[pm] ?? AGENT_CHAIN;
          const token = pm.includes("usdt") ? "USDT" : "USDC";
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await arcKit.send({ from: { adapter, chain: chain as any }, to: output.paymentAddress, amount: String(output.paymentAmount), token });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((result as any)?.state && (result as any).state !== "success") throw new Error("Transfer did not complete");
        }
      }

      setState("done");
      addToolResult({
        toolCallId,
        result: {
          paid: true,
          invoiceId: output.invoiceId,
          isTopup: output.isTopup,
          tip: `USDC payment confirmed on-chain. Call poll_bitrefill_order(invoiceId="${output.invoiceId}", isTopup=${!!output.isTopup}) NOW. Keep retrying every ~3 s (up to 20 times) until status is complete/failed/expired. Do not ask the user anything.`,
        },
      });
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "Payment failed";
      const friendly =
        msg.toLowerCase().includes("cancel") || msg.toLowerCase().includes("reject") || msg.toLowerCase().includes("denied")
          ? "Payment cancelled."
          : msg;
      setErrMsg(friendly);
      setState("error");
      addToolResult({
        toolCallId,
        result: { paid: false, error: friendly, invoiceId: output.invoiceId },
      });
    }
  };

  const handleCancel = () => {
    addToolResult({
      toolCallId,
      result: { paid: false, error: "Cancelled by user", invoiceId: output.invoiceId },
    });
  };

  if (state === "done") {
    return (
      <div className="my-2 rounded-xl border border-green-700/30 bg-green-900/10 px-4 py-2">
        <p className="text-xs text-green-400">✓ Payment sent — confirming with Bitrefill…</p>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-[#F2F0E8]">Confirm Payment</p>
        {output.expiresInMinutes && (
          <span className="text-[10px] text-[#A7A79A]">Expires in {output.expiresInMinutes}m</span>
        )}
      </div>
      <div className="rounded-lg bg-[#141513] px-3 py-2 flex items-center justify-between">
        <span className="text-xs text-[#A7A79A]">Amount</span>
        <span className="font-mono text-sm font-bold text-[#F2F0E8]">
          {output.paymentAmount} {currencyLabel}
        </span>
      </div>
      {errMsg && <p className="text-xs text-red-400">{errMsg}</p>}
      <div className="flex gap-2">
        <button
          onClick={handleCancel}
          disabled={state === "paying"}
          className="flex-1 rounded-xl border border-[#2A2B27] py-2.5 text-xs font-medium text-[#A7A79A] hover:bg-white/[0.04] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handlePay}
          disabled={state === "paying"}
          className="flex-1 rounded-xl bg-[#8FAE82] py-2.5 text-xs font-semibold text-[#141513] disabled:opacity-50 transition-opacity"
        >
          {state === "paying" ? "Sending…" : `Pay ${output.paymentAmount} ${currencyLabel}`}
        </button>
      </div>
    </div>
  );
}

/** Returns the pending marker key from a Velvet tool result, or null if not Velvet pending. */
function velvetPendingKey(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  for (const key of Object.keys(VELVET_PENDING_LABELS)) {
    if ((output as Record<string, unknown>)[key] === true) return key;
  }
  return null;
}

function VelvetTxApprovalCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: Record<string, unknown>;
  addToolResult: (args: { toolCallId: string; result: unknown }) => void;
}) {
  const { wallets } = useWallets();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingKey = velvetPendingKey(output);
  const label = pendingKey ? VELVET_PENDING_LABELS[pendingKey] : "Velvet Transaction";
  // Standard shape: output.tx = { to, data, gas_limit?, gas_price? }
  // Weight-update shape: output.handler + output.call_data + output.estimate_gas + output.gas_price
  const tx = output.tx as { to?: string; data?: string; gas_limit?: string; gas_price?: string } | undefined;
  const txTo   = (tx?.to   ?? output.handler)  as string | undefined;
  const txData = (tx?.data ?? output.call_data) as string | undefined;
  const txGas  = (tx?.gas_limit ?? output.estimate_gas) as string | undefined;
  const txGasPrice = (tx?.gas_price ?? output.gas_price) as string | undefined;

  const handleApprove = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!txTo || !txData) throw new Error("Transaction data missing");
      const evmWallet = wallets?.find((w) => w.walletClientType === "privy") ?? wallets?.[0];
      if (!evmWallet) throw new Error("EVM wallet not connected");
      const provider = await (evmWallet as any).getEthereumProvider?.();
      if (!provider) throw new Error("Could not get wallet provider");
      const txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [{
          to: txTo,
          data: txData,
          ...(txGas ? { gas: "0x" + parseInt(txGas).toString(16) } : {}),
          ...(txGasPrice ? { gasPrice: "0x" + parseInt(txGasPrice).toString(16) } : {}),
        }],
      });
      setDone(true);
      addToolResult({ toolCallId, result: { success: true, txHash } });
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "Transaction failed";
      setError(msg);
      addToolResult({ toolCallId, result: { success: false, error: msg } });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, result: { success: false, error: "User cancelled" } });
    setDone(true);
  };

  if (done && !error) {
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
        ✓ {label} submitted on-chain
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">🏛️</span>
        <div>
          <p className="font-medium text-ink text-sm">{label}</p>
          <p className="text-xs text-ink/50">Velvet Capital · Base (EVM)</p>
        </div>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={handleReject}
          disabled={busy}
          className="flex-1 rounded-lg border border-border py-2 text-sm text-ink/60 hover:bg-ink/5 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleApprove}
          disabled={busy}
          className="flex-1 rounded-lg bg-ink py-2 text-sm font-medium text-cream hover:opacity-80 transition-opacity disabled:opacity-50"
        >
          {busy ? "Signing…" : "Sign & Execute"}
        </button>
      </div>
    </div>
  );
}

function FlashTxApprovalCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: { pendingFlashTx: true; action: string; args: Record<string, unknown>; transaction: string; solanaAddress: string };
  addToolResult: (args: { toolCallId: string; result: unknown }) => void;
}) {
  const { signTransaction } = useSignTransaction();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = FLASH_ACTION_LABELS[output.action] ?? output.action.replace(/_/g, " ");
  const isErAction = ER_ACTIONS.has(output.action);
  const session = isErAction ? loadActiveSession() : null;
  const usesSession = session !== null;

  const handleApprove = async () => {
    setBusy(true);
    setError(null);
    try {
      const rpcUrl = isErAction ? ER_RPC : SOL_RPC;
      const conn = new Connection(rpcUrl, "confirmed");
      let sig: string;

      if (usesSession && session) {
        // Session key is active — sign with it directly, no wallet popup needed
        const txBuf = Buffer.from(output.transaction, "base64");
        const tx = Transaction.from(txBuf);
        const { blockhash } = await conn.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(session.keypair);
        sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      } else {
        // No session — fall back to Privy wallet signature
        const raw = Buffer.from(output.transaction, "base64");
        const signed: Uint8Array = await (signTransaction as any)({ transaction: raw });
        sig = await conn.sendRawTransaction(signed, { skipPreflight: false });
      }

      await conn.confirmTransaction(sig, "confirmed");
      setDone(true);
      addToolResult({ toolCallId, result: { success: true, signature: sig, action: output.action } });
    } catch (err: any) {
      const msg = err?.message ?? "Transaction failed";
      setError(msg);
      addToolResult({ toolCallId, result: { success: false, error: msg } });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, result: { success: false, error: "User rejected" } });
    setDone(true);
  };

  if (done && !error) {
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
        ✓ {label} sent on-chain
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">⚡</span>
        <div>
          <p className="font-medium text-ink text-sm">{label}</p>
          <p className="text-xs text-ink/50">
            Flash Trade · Solana{usesSession ? " · Session key active" : ""}
          </p>
        </div>
      </div>
      {Object.entries(output.args).length > 0 && (
        <div className="rounded-lg bg-ink/5 p-2 text-xs space-y-1">
          {Object.entries(output.args).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <span className="text-ink/50">{k.replace(/_/g, " ")}</span>
              <span className="text-ink font-mono">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
      {usesSession && (
        <p className="text-xs text-blue-400/80">
          Trading session active — no wallet popup required.
        </p>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={handleReject}
          disabled={busy}
          className="flex-1 rounded-lg border border-border py-2 text-sm text-ink/60 hover:bg-ink/5 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleApprove}
          disabled={busy}
          className="flex-1 rounded-lg bg-ink py-2 text-sm font-medium text-cream hover:opacity-80 transition-opacity disabled:opacity-50"
        >
          {busy ? "Executing…" : usesSession ? "Execute" : "Confirm"}
        </button>
      </div>
    </div>
  );
}

function FlashSessionApprovalCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: { pendingFlashSession: true; action: string; args: { durationHours: number }; solanaAddress: string };
  addToolResult: (args: { toolCallId: string; result: unknown }) => void;
}) {
  const { signTransaction } = useSignTransaction();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setBusy(true); setError(null);
    try {
      const sessionKp = Keypair.generate();
      const sessionPubkey = sessionKp.publicKey.toBase58();

      // Fetch the real tx now that we have a session pubkey
      const r = await fetch("/api/flash/create-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerAddress: output.solanaAddress,
          sessionSignerPubkey: sessionPubkey,
          durationHours: output.args.durationHours,
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction: base64Tx } = await r.json() as { transaction: string };

      // Session keypair partial-signs first
      const txBuf = Buffer.from(base64Tx, "base64");
      const tx = Transaction.from(txBuf);
      tx.partialSign(sessionKp);
      const partialB64 = Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");

      // Owner wallet (Privy) signs
      const signed: Uint8Array = await (signTransaction as any)({ transaction: Buffer.from(partialB64, "base64") });
      const conn = new Connection(SOL_RPC, "confirmed");
      const sig = await conn.sendRawTransaction(signed, { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");

      const expiresAt = Date.now() + output.args.durationHours * 60 * 60 * 1000;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ pubkey: sessionPubkey, secretKey: Array.from(sessionKp.secretKey), expiresAt }));

      setDone(true);
      addToolResult({ toolCallId, result: { success: true, signature: sig, sessionPubkey, expiresAt } });
    } catch (err: any) {
      const msg = err?.message ?? "Failed";
      setError(msg);
      addToolResult({ toolCallId, result: { success: false, error: msg } });
    } finally { setBusy(false); }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, result: { success: false, error: "User rejected" } });
    setDone(true);
  };

  if (done && !error) {
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
        ✓ Trading session created — Bluvfi can now trade without wallet popups
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">🔑</span>
        <div>
          <p className="font-medium text-ink text-sm">Start Trading Session</p>
          <p className="text-xs text-ink/50">Flash Trade · Solana · {output.args.durationHours}h</p>
        </div>
      </div>
      <div className="rounded-lg bg-ink/5 p-2 text-xs space-y-1">
        <div className="flex justify-between gap-2">
          <span className="text-ink/50">Duration</span>
          <span className="text-ink font-mono">{output.args.durationHours}h</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-ink/50">Scope</span>
          <span className="text-ink">Flash Trade perpetuals only</span>
        </div>
      </div>
      <p className="text-xs text-ink/40">A temporary keypair will be generated in your browser. You sign once to approve it, then trades run without further popups.</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button onClick={handleReject} disabled={busy} className="flex-1 rounded-lg border border-border py-2 text-sm text-ink/60 hover:bg-ink/5 transition-colors">Cancel</button>
        <button onClick={handleApprove} disabled={busy} className="flex-1 rounded-lg bg-ink py-2 text-sm font-medium text-cream hover:opacity-80 transition-opacity disabled:opacity-50">
          {busy ? "Creating…" : "Approve"}
        </button>
      </div>
    </div>
  );
}

function FlashRevokeSessionCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: { pendingFlashRevoke: true; solanaAddress: string };
  addToolResult: (args: { toolCallId: string; result: unknown }) => void;
}) {
  const { signTransaction } = useSignTransaction();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setBusy(true); setError(null);
    try {
      const raw = typeof window !== "undefined" ? localStorage.getItem(SESSION_KEY) : null;
      if (!raw) throw new Error("No active session found in this browser");
      const { pubkey: sessionSignerPubkey } = JSON.parse(raw) as { pubkey: string };

      const r = await fetch("/api/flash/revoke-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: output.solanaAddress, sessionSignerPubkey }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction: base64Tx } = await r.json() as { transaction: string };

      const signed: Uint8Array = await (signTransaction as any)({ transaction: Buffer.from(base64Tx, "base64") });
      const conn = new Connection(SOL_RPC, "confirmed");
      const sig = await conn.sendRawTransaction(signed, { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");

      if (typeof window !== "undefined") localStorage.removeItem(SESSION_KEY);
      setDone(true);
      addToolResult({ toolCallId, result: { success: true, signature: sig } });
    } catch (err: any) {
      const msg = err?.message ?? "Failed";
      setError(msg);
      addToolResult({ toolCallId, result: { success: false, error: msg } });
    } finally { setBusy(false); }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, result: { success: false, error: "User cancelled" } });
    setDone(true);
  };

  if (done && !error) {
    return (
      <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">
        ✓ Trading session ended
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-lg">🔒</span>
        <div>
          <p className="font-medium text-ink text-sm">End Trading Session</p>
          <p className="text-xs text-ink/50">Flash Trade · Solana</p>
        </div>
      </div>
      <p className="text-xs text-ink/50">This will revoke the session keypair on-chain. Future trades will require your wallet signature again.</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button onClick={handleReject} disabled={busy} className="flex-1 rounded-lg border border-border py-2 text-sm text-ink/60 hover:bg-ink/5 transition-colors">Cancel</button>
        <button onClick={handleApprove} disabled={busy} className="flex-1 rounded-lg bg-ink py-2 text-sm font-medium text-cream hover:opacity-80 transition-opacity disabled:opacity-50">
          {busy ? "Revoking…" : "Confirm"}
        </button>
      </div>
    </div>
  );
}

interface ChatSheetProps {
  visible: boolean;
}

export function ChatSheet({ visible }: ChatSheetProps) {
  const {
    close,
    prefill,
    clearPrefill,
    dashboardData,
    registerSendMessage,
    setIsStreaming: setCtxStreaming,
    setChatInput,
  } = useChatSheet();
  const { user, getAccessToken } = usePrivy();
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  const name = getUserFirstName(user);
  const greeting = getTimeBasedGreeting();

  const { paidBillIds } = useDemoState();

  const accounts = (user?.linkedAccounts as any[]) ?? [];
  const walletAddress = user?.smartWallet?.address ?? user?.wallet?.address;
  const solanaWallet = accounts.find((a: any) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy");
  const solanaAddress = solanaWallet?.address as string | undefined;

  // Balance values come from dashboardData (registered by page.tsx via registerDashboardData).
  // This keeps the agent in sync with exactly what the dashboard displays — no separate fetch.
  const evmUsdc = dashboardData?.evmUsdc;
  const evmUsdt = dashboardData?.evmUsdt;
  const solUsdc = dashboardData?.solUsdc;
  const solUsdt = dashboardData?.solUsdt;

  const bodyRef = useRef<Record<string, unknown>>({});
  bodyRef.current = {
    walletAddress,
    solanaAddress,
    userName: name,
    evmUsdc,
    evmUsdt,
    solUsdc,
    solUsdt,
    paidBillIds,
    totalBillsDueUsd: dashboardData?.totalBillsDueUsd,
    portfolioValueUsd: dashboardData?.portfolioValueUsd,
    billCount: dashboardData?.billCount,
  };

  const getAccessTokenRef = useRef(getAccessToken);
  getAccessTokenRef.current = getAccessToken;

  const transport = useMemo(() => {
    const liveBody: Record<string, unknown> = {};
    for (const key of [
      "walletAddress", "solanaAddress", "userName",
      "evmUsdc", "evmUsdt", "solUsdc", "solUsdt", "paidBillIds",
      "totalBillsDueUsd", "portfolioValueUsd", "billCount",
    ]) {
      Object.defineProperty(liveBody, key, {
        get: () => bodyRef.current[key],
        enumerable: true,
      });
    }
    return new DefaultChatTransport({
      api: "/api/chat",
      body: liveBody,
      headers: async (): Promise<Record<string, string>> => {
        const token = await getAccessTokenRef.current();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const { messages, sendMessage, addToolResult, status } = useChat({
    transport,
  });

  const isBusy = status === "submitted" || status === "streaming";
  const isStreaming = status === "streaming";

  useEffect(() => {
    setCtxStreaming(isBusy);
  }, [isBusy, setCtxStreaming]);

  // Register send for external input bar
  const handleSend = useCallback(
    (text: string) => {
      if (!text.trim() || isBusy) return;
      userScrolledRef.current = false;
      sendMessage({ text });
      setChatInput("");
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
      });
    },
    [isBusy, sendMessage, setChatInput],
  );

  useEffect(() => {
    registerSendMessage(handleSend);
  }, [handleSend, registerSendMessage]);

  useEffect(() => {
    if (prefill) {
      setChatInput(prefill);
      clearPrefill();
    }
  }, [prefill, clearPrefill, setChatInput]);

  // Detect manual scroll-up to stop auto-following
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      // If user scrolled away from bottom, stop auto-following
      if (!isNearBottom && isBusy) {
        userScrolledRef.current = true;
      }
      // If user scrolls back to bottom, resume auto-following
      if (isNearBottom) {
        userScrolledRef.current = false;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isBusy]);

  // Auto-scroll to bottom when messages change or streaming ends (unless user scrolled up).
  // setTimeout lets the DOM paint the new content (e.g. Confirm card) before measuring scrollHeight.
  useEffect(() => {
    if (!scrollRef.current || !visible) return;
    if (userScrolledRef.current) return;
    const el = scrollRef.current;
    const id = setTimeout(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }, 60);
    return () => clearTimeout(id);
  }, [messages, status, visible]);

  return (
    <>
      {/* Backdrop */}
      {visible && (
        <div
          className="fixed inset-0 z-40 bg-ink/10 transition-opacity duration-300"
          onClick={close}
        />
      )}

      {/* Panel */}
      <div
        className={`fixed inset-x-0 bottom-0 z-40 mx-auto flex h-[85dvh] max-w-lg flex-col rounded-t-2xl border-t border-border bg-cream transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] lg:max-w-xl ${
          visible ? "translate-y-0" : "translate-y-full"
        }`}
      >
        {/* Bluvfi logo, tappable to close */}
        <div className="flex-none px-5 pt-3 pb-2">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
          <div className="flex justify-center">
            <button
              onClick={close}
              className="transition-opacity hover:opacity-60"
            >
              <div className="relative">
                <img src="/Bluvfiv2.jpg" alt="Bluvfi" className="h-8 w-8 rounded-full object-cover" />
                <span className="absolute -top-1 -right-5 rounded text-[9px] font-bold tracking-wide uppercase bg-violet-500/20 text-violet-400 px-1 py-px leading-none">beta</span>
              </div>
            </button>
          </div>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 pt-4 pb-[calc(5rem+max(env(safe-area-inset-bottom),0px))]">
          <div className="space-y-4">
            {/* Welcome message — shown when chat is empty */}
            {messages.length === 0 && (
              <div className="py-6">
                <p className="font-display text-[1.4rem] leading-snug text-ink">
                  {greeting}{name ? `, ${name}` : ""}. 👋
                </p>
                <p className="mt-3 font-body text-[1rem] leading-relaxed text-ink/60">
                  I&rsquo;m Bluvfi, your financial assistant. Ask me to pay your bills, invest in stocks, or check your portfolio.
                </p>
              </div>
            )}
            {messages.map((message) => {
              const hasText = message.parts.some(
                (p) => p.type === "text" && p.text.trim(),
              );
              const hasVisibleToolPart = message.parts.some((p) => {
                if (!p.type.startsWith("tool-") || !("toolCallId" in p)) return false;
                const tp = p as { type: string; state: string; output?: unknown };
                const tn = tp.type.slice(5);
                if (["deposit", "withdraw", "swap_and_deposit", "swap"].includes(tn)) return true;
                if (tn.startsWith("flash_")) return tp.state === "output-available";
                return tp.state === "output-available" && !!tp.output;
              });

              return (
                <div key={message.id} data-role={message.role}>
                  {message.parts.map((part, i) => {
                    if (part.type === "text") {
                      return (
                        <MessageBubble key={i} role={message.role} text={part.text} />
                      );
                    }
                    if (part.type === "reasoning") return null;
                    if (part.type.startsWith("tool-") && "toolCallId" in part) {
                      const tp = part as {
                        type: string;
                        toolCallId: string;
                        state: string;
                        input?: unknown;
                        output?: unknown;
                      };
                      const toolName = tp.type.slice(5);

                      if (["deposit", "withdraw", "swap_and_deposit", "swap"].includes(toolName)) {
                        return (
                          <ToolApprovalCard
                            key={tp.toolCallId}
                            toolName={toolName as "deposit" | "withdraw" | "swap" | "swap_and_deposit"}
                            toolCallId={tp.toolCallId}
                            args={(tp.input as Record<string, string>) || {}}
                            state={tp.state}
                            result={tp.output}
                            addToolResult={addToolResult}
                            dashboardData={dashboardData}
                          />
                        );
                      }

                      if (
                        tp.state === "output-available" &&
                        tp.output &&
                        (tp.output as any)?.pendingRoasterBond === true
                      ) {
                        return (
                          <RoasterBondCard
                            key={tp.toolCallId}
                            toolCallId={tp.toolCallId}
                            output={tp.output as any}
                            addToolResult={addToolResult}
                          />
                        );
                      }

                      if (
                        tp.state === "output-available" &&
                        tp.output &&
                        (tp.output as any)?.pendingRoasterBack === true
                      ) {
                        return (
                          <RoasterBackCard
                            key={tp.toolCallId}
                            toolCallId={tp.toolCallId}
                            output={tp.output as any}
                            addToolResult={addToolResult}
                          />
                        );
                      }

                      if (
                        tp.state === "output-available" &&
                        tp.output &&
                        (tp.output as any)?.pendingFlashRevoke === true
                      ) {
                        return (
                          <FlashRevokeSessionCard
                            key={tp.toolCallId}
                            toolCallId={tp.toolCallId}
                            output={tp.output as any}
                            addToolResult={addToolResult}
                          />
                        );
                      }

                      if (
                        tp.state === "output-available" &&
                        tp.output &&
                        (tp.output as any)?.pendingFlashSession === true
                      ) {
                        return (
                          <FlashSessionApprovalCard
                            key={tp.toolCallId}
                            toolCallId={tp.toolCallId}
                            output={tp.output as any}
                            addToolResult={addToolResult}
                          />
                        );
                      }

                      if (
                        tp.state === "output-available" &&
                        tp.output &&
                        (tp.output as any)?.pendingFlashTx === true
                      ) {
                        return (
                          <FlashTxApprovalCard
                            key={tp.toolCallId}
                            toolCallId={tp.toolCallId}
                            output={tp.output as any}
                            addToolResult={addToolResult}
                          />
                        );
                      }

                      if (
                        tp.state === "output-available" &&
                        tp.output &&
                        velvetPendingKey(tp.output) !== null
                      ) {
                        return (
                          <VelvetTxApprovalCard
                            key={tp.toolCallId}
                            toolCallId={tp.toolCallId}
                            output={tp.output as Record<string, unknown>}
                            addToolResult={addToolResult}
                          />
                        );
                      }

                      // Bitrefill payment — show a "Confirm Payment" card that sends USDC client-side
                      if (
                        tp.state === "output-available" &&
                        tp.output &&
                        (tp.output as any)?.pendingBitrefillPayment === true &&
                        !(tp.output as any)?.isAddressBased
                      ) {
                        return (
                          <BitrefillPaymentCard
                            key={tp.toolCallId}
                            toolCallId={tp.toolCallId}
                            output={tp.output as any}
                            addToolResult={addToolResult}
                          />
                        );
                      }

                      if (tp.state === "output-available" && tp.output) {
                        return (
                          <ToolResultCard key={tp.toolCallId} toolName={toolName} result={tp.output} />
                        );
                      }

                      return null;
                    }
                    return null;
                  })}
                  {message.role === "assistant" && !hasText && isBusy && (
                    <ThinkingIndicator />
                  )}
                  {message.role === "assistant" && !hasText && !hasVisibleToolPart && !isBusy && (
                    <MessageBubble role="assistant" text="Let me try that again — could you rephrase?" />
                  )}
                </div>
              );
            })}
            {/* Thinking indicator for submitted phase (before assistant message exists) */}
            {status === "submitted" && (
              <div data-role="assistant">
                <ThinkingIndicator />
              </div>
            )}
            {/* Error fallback when request fails without creating assistant message */}
            {status !== "submitted" && status !== "streaming" && messages.length > 0 && messages[messages.length - 1].role === "user" && (
              <div data-role="assistant">
                <MessageBubble role="assistant" text="Something went wrong — please try again." />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
