"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSignTransaction, useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { Connection, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Chain } from "viem";
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
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
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
      addToolResult({ toolCallId, output: { success: true, battle_id: output.battle_id, signature: sig } });
    } catch (err: any) {
      const msg = err?.message ?? "Transaction failed";
      setError(msg);
      addToolResult({ toolCallId, output: { success: false, error: msg } });
    } finally { setBusy(false); }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, output: { success: false, error: "User cancelled" } });
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
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
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
      addToolResult({ toolCallId, output: { success: true, battle_id: output.battle_id, side: output.side, amount_usdc: output.amount_usdc, signature: sig } });
    } catch (err: any) {
      const msg = err?.message ?? "Transaction failed";
      setError(msg);
      addToolResult({ toolCallId, output: { success: false, error: msg } });
    } finally { setBusy(false); }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, output: { success: false, error: "User cancelled" } });
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
  // BSC (usdt_bsc) is intentionally absent — Privy's paymaster has no BSC support.
  // usdt_bsc bypasses smart wallet entirely and goes straight to manual deposit address.
};

/** Human-readable network name for a Bitrefill payment method ID. */
function evmNetworkLabel(pm: string): string {
  const map: Record<string, string> = {
    usdc_base:     "Base",      usdt_base:     "Base",
    usdc_erc20:    "Ethereum",  usdt_erc20:    "Ethereum",
    usdc_polygon:  "Polygon",   usdt_polygon:  "Polygon",
    usdc_arbitrum: "Arbitrum",  usdt_arbitrum: "Arbitrum",
    usdc_optimism: "Optimism",  usdt_optimism: "Optimism",
    usdt_bsc:      "BSC (BEP-20)",
  };
  return map[pm] ?? pm;
}

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
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
}) {
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  // `sendTransaction(..., { sponsor: true })` triggers Privy's native gas
  // sponsorship (EIP-7702) on the user's existing embedded wallet — the
  // "Gas management" dashboard feature. Falls back to Layer 2 (user pays
  // native gas) and Layer 3 (ArcKit) if unavailable.
  const { user: privyUser, sendTransaction: privySendTransaction } = usePrivy();
  const [state, setState] = useState<"idle" | "paying" | "done" | "error" | "manual">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [manualAddress, setManualAddress] = useState<string | null>(null);
  const [manualCopied, setManualCopied] = useState(false);

  // Derive the payment method ID and human-readable currency label.
  // paymentCurrency is sometimes omitted by Bitrefill for EVM methods.
  const pm = (output.paymentMethod ?? "usdc_base") as string;
  const currencyLabel =
    output.paymentCurrency ||
    (pm.includes("usdt") ? "USDT" : "USDC");

  const handlePay = async () => {
    setState("paying");
    setErrMsg(null);
    try {
      const isSolana = pm.includes("solana");

      if (isSolana) {
        // Direct SPL token transfer — mirrors the EVM USDT direct-viem path.
        // Uses @solana/spl-token to find ATAs, run a pre-flight balance check,
        // and build the instruction. The Privy Solana wallet signs the tx bytes.
        const solWallet = solanaWallets[0];
        if (!solWallet) throw new Error("No Solana wallet connected");

        const { PublicKey, Transaction: SolTx, Connection: SolConnection } = await import("@solana/web3.js");
        const { getAssociatedTokenAddress, createTransferInstruction, getAccount, TOKEN_PROGRAM_ID } =
          await import("@solana/spl-token");

        const solRpc = `https://solana-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;
        const connection = new SolConnection(solRpc, "confirmed");

        // Resolve SPL mint — USDC or USDT on Solana mainnet
        const SOLANA_MINTS: Record<string, string> = {
          USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        };
        const token          = pm.includes("usdt") ? "USDT" : "USDC";
        const mint           = new PublicKey(SOLANA_MINTS[token]);
        const senderPubkey   = new PublicKey(solWallet.address);
        const receiverPubkey = new PublicKey(output.paymentAddress);

        // Pre-flight: verify the sender has an ATA with sufficient balance
        const senderAta     = await getAssociatedTokenAddress(mint, senderPubkey);
        const senderAccount = await getAccount(connection, senderAta).catch(() => null);
        if (!senderAccount) {
          throw new Error(`Insufficient ${token} balance on Solana. Please add funds and try again.`);
        }
        const requiredMicro = BigInt(Math.round(Number(output.paymentAmount) * 1_000_000));
        if (senderAccount.amount < requiredMicro) {
          const bal = (Number(senderAccount.amount) / 1_000_000).toFixed(2);
          throw new Error(
            `Insufficient ${token} on Solana. You have $${bal} but need $${Number(output.paymentAmount).toFixed(2)}.`
          );
        }

        // Receiver ATA (Bitrefill maintains their token accounts — no creation needed)
        const receiverAta = await getAssociatedTokenAddress(mint, receiverPubkey);

        // Build, sign, and send
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new SolTx({ recentBlockhash: blockhash, feePayer: senderPubkey }).add(
          createTransferInstruction(senderAta, receiverAta, senderPubkey, requiredMicro, [], TOKEN_PROGRAM_ID),
        );
        const txBytes = Buffer.from(tx.serialize({ requireAllSignatures: false }));
        const { signedTransaction } = await solWallet.signTransaction({ transaction: txBytes });
        const txSig = await connection.sendRawTransaction(SolTx.from(signedTransaction).serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        await connection.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");
      } else {
        // ── EVM payment ───────────────────────────────────────────────────────
        // Layer 1: Privy native gas sponsorship (EIP-7702, `sponsor: true`) on the
        //   embedded wallet — configured in the dashboard under Wallet
        //   infrastructure → Gas management. NOT the same as ERC-4337 smart
        //   *contract* wallets (@privy-io/react-auth/smart-wallets); that feature
        //   creates a separate 4337 account and requires `user.smartWallet` to be
        //   provisioned, which this app doesn't use.
        // Layer 2: Privy EOA — direct ERC-20 transfer, user pays native gas (ETH/MATIC/etc.).
        // Layer 3: ArcKit EOA fallback (Circle) for all EVM chains except BSC.
        // BSC fallback: manual deposit address shown directly in the card UI.

        // Turn a raw error into a short, human-readable one-liner for console
        // logs. Some errors are already clean (e.g. ArcKit's own pre-flight
        // check: "Insufficient token balance on Arbitrum"); others are a
        // multi-hundred-character RPC/simulation dump (USDT on Ethereum reverts
        // with a bare "invalid opcode" instead of a message when the balance is
        // too low). Detect the known-noisy cases and say the real reason instead
        // — the raw error is still passed as a separate console.error argument
        // for anyone who needs the full trace.
        const summarizeError = (err: unknown, pmId: string): string => {
          const raw = (err as Error)?.message ?? String(err);
          const m = raw.toLowerCase();
          const network = pmId.includes("erc20") ? "Ethereum"
            : pmId.includes("polygon") ? "Polygon"
            : pmId.includes("arbitrum") ? "Arbitrum"
            : pmId.includes("optimism") ? "Optimism"
            : pmId.includes("base") ? "Base"
            : "this network";
          if (m.includes("balance_insufficient") || m.includes("insufficient token balance")) {
            return raw.split("\n")[0]; // already clean, e.g. "Insufficient token balance on Arbitrum"
          }
          if (m.includes("invalid opcode") || m.includes("invalidfeopcode") || m.includes("fe opcode")) {
            const token = pmId.includes("usdt") ? "USDT" : pmId.includes("usdc") ? "USDC" : "the token";
            return `Insufficient ${token} balance on ${network} (contract reverted without a reason string)`;
          }
          if (m.includes("insufficient funds for gas") || m.includes("gas required exceeds allowance")) {
            return `Insufficient native gas balance on ${network}`;
          }
          // Otherwise: RPC/simulation dumps are one giant multi-line string —
          // the first line is almost always the actual message.
          return raw.split("\n")[0];
        };

        const swConfig = BITREFILL_SMART_WALLET_TOKENS[pm];
        let swSucceeded = false;

        if (swConfig) {
          try {
            const { encodeFunctionData, erc20Abi, parseAbi, parseUnits } = await import("viem");
            // USDT contracts (Ethereum, Polygon, Arbitrum) use a non-standard
            // transfer() with no bool return — use a stripped ABI for all USDT.
            const isUsdt = pm.includes("usdt");
            const transferAbi = isUsdt
              ? parseAbi(["function transfer(address to, uint256 amount)"])
              : erc20Abi;
            const calldata = encodeFunctionData({
              abi: transferAbi,
              functionName: "transfer",
              args: [output.paymentAddress as `0x${string}`, parseUnits(String(output.paymentAmount), 6)],
            });
            await privySendTransaction(
              {
                to: swConfig.contract,
                data: calldata,
                chainId: swConfig.chainId,
              },
              { sponsor: true },
            );
            swSucceeded = true;
          } catch (swErr: unknown) {
            console.error(`[chat/bitrefill] Layer 1 ❌ Native gas sponsorship failed (${pm}):`, summarizeError(swErr, pm), swErr);
          }
        }

        if (!swSucceeded) {
          // BSC: no smart wallet, no EOA, no ArcKit — show manual deposit address card.
          if (pm === "usdt_bsc") {
            const addr = output.paymentAddress;
            if (!addr) throw new Error("No deposit address returned for BSC USDT");
            setManualAddress(addr);
            setState("manual");
            addToolResult({
              tool: "buy_bitrefill_product",
              toolCallId,
              output: {
                paid: false,
                manualTransferRequired: true,
                depositAddress: addr,
                depositAmount: output.paymentAmount,
                currency: "USDT",
                network: "BSC (BEP-20)",
                invoiceId: output.invoiceId,
                tip: `BSC USDT requires manual transfer. The deposit address has been shown to the user. Ask them to send ${output.paymentAmount} USDT (BEP-20) to ${addr}, then call poll_bitrefill_order(invoiceId="${output.invoiceId}", isTopup=${!!output.isTopup}) every ~5 s until the status changes.`,
              },
            });
            return;
          }

          // ── Layer 2: Privy EOA — direct ERC-20 transfer, user pays native gas ──
          // The embedded Privy wallet signs the tx; the user needs ETH/MATIC/etc.
          // for gas. No paymaster involved — plain EOA → contract call.
          let eoaSucceeded = false;
          if (swConfig) {
            try {
              const {
                createWalletClient, createPublicClient, custom, http,
                encodeFunctionData, erc20Abi, parseAbi, parseUnits,
              } = await import("viem");
              const { base, mainnet, polygon, arbitrum, optimism } = await import("viem/chains");
              const VIEM_CHAINS_EOA: Record<number, Chain> = {
                1:     mainnet,
                8453:  base,
                137:   polygon,
                42161: arbitrum,
                10:    optimism,
              };
              const viemChain = VIEM_CHAINS_EOA[swConfig.chainId];
              const privyEoa = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
              if (!privyEoa) throw new Error("No EVM wallet connected");
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const eoaProvider = await privyEoa.getEthereumProvider();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const walletClient = createWalletClient({ chain: viemChain, transport: custom(eoaProvider as any) });
              const [eoaAccount] = await walletClient.getAddresses();

              // Privy's embedded wallet fires its own gas-estimate preview for the
              // confirm-tx UI as an *unhandled* promise (outside our await chain) —
              // if the account has no native gas token that preview throws an
              // uncaught rejection our try/catch never sees. Check the balance
              // ourselves first so we throw (and catch) a clean error instead.
              // viem's default RPC per chain isn't on the app's CSP allowlist, so
              // point explicitly at an Alchemy endpoint (already whitelisted, same
              // one wagmi.ts uses) — this avoids "Refused to connect" CSP errors.
              const ALCHEMY_SUBDOMAIN: Record<number, string> = {
                1: "eth-mainnet", 8453: "base-mainnet", 137: "polygon-mainnet",
                42161: "arb-mainnet", 10: "opt-mainnet",
              };
              const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
              const rpcUrl = alchemyKey
                ? `https://${ALCHEMY_SUBDOMAIN[swConfig.chainId]}.g.alchemy.com/v2/${alchemyKey}`
                : undefined;
              const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
              const nativeBalance = await publicClient.getBalance({ address: eoaAccount });
              if (nativeBalance === 0n) {
                throw new Error(`No ${viemChain.nativeCurrency.symbol} balance on ${viemChain.name} to pay gas`);
              }

              const isUsdtEoa = pm.includes("usdt");
              const eoaAbi = isUsdtEoa
                ? parseAbi(["function transfer(address to, uint256 amount)"])
                : erc20Abi;
              const eoaCalldata = encodeFunctionData({
                abi: eoaAbi,
                functionName: "transfer",
                args: [output.paymentAddress as `0x${string}`, parseUnits(String(output.paymentAmount), 6)],
              });
              // The Privy EOA may be on a different chain (e.g. Base when we need
              // Ethereum). Switch it to the target chain before sending.
              await walletClient.switchChain({ id: viemChain.id });
              await walletClient.sendTransaction({
                account: eoaAccount,
                to: swConfig.contract,
                data: eoaCalldata,
                chain: viemChain,
              });
              eoaSucceeded = true;
            } catch (eoaErr: unknown) {
              // Native gas unavailable or user rejected — fall through to ArcKit (Layer 3).
              console.error(`[chat/bitrefill] Layer 2 ❌ Privy EOA failed (${pm}):`, summarizeError(eoaErr, pm), eoaErr);
            }
          }

          // ── Layer 3: ArcKit EOA fallback — Circle handles gas; Privy EOA signs ──
          if (!eoaSucceeded) {
            const privyWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
            if (!privyWallet) throw new Error("No EVM wallet connected");
            const provider = await privyWallet.getEthereumProvider();
            const { createViemAdapterFromProvider } = await import("@circle-fin/adapter-viem-v2");
            const { arcKit, AGENT_CHAIN } = await import("@/lib/arc-kit");
            const { Blockchain } = await import("@circle-fin/app-kit");
            const EVM_CHAIN_MAP: Record<string, typeof Blockchain[keyof typeof Blockchain]> = {
              usdc_base:     Blockchain.Base,     usdt_base:     Blockchain.Base,
              usdc_erc20:    Blockchain.Ethereum, usdt_erc20:    Blockchain.Ethereum,
              usdc_polygon:  Blockchain.Polygon,  usdt_polygon:  Blockchain.Polygon,
              usdc_arbitrum: Blockchain.Arbitrum, usdt_arbitrum: Blockchain.Arbitrum,
              usdc_optimism: Blockchain.Optimism, usdt_optimism: Blockchain.Optimism,
            };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const adapter = await createViemAdapterFromProvider({ provider: provider as any });
            const chain = EVM_CHAIN_MAP[pm] ?? AGENT_CHAIN;
            // ArcKit v1.10.0 has usdtAddress: null for Polygon, Arbitrum, Optimism, and
            // Base — it only recognises the "USDT" alias on Ethereum. Passing the raw
            // contract address (TokenAddress) bypasses alias validation and lets ArcKit
            // treat it as a generic ERC-20 token (it fetches decimals from the chain).
            const swCfg = BITREFILL_SMART_WALLET_TOKENS[pm];
            const arcKitToken: string =
              pm.includes("usdt") && pm !== "usdt_erc20" && swCfg?.contract
                ? swCfg.contract   // raw contract address for non-Ethereum USDT
                : pm.includes("usdt") ? "USDT" : "USDC";  // alias for Ethereum USDT / all USDC
            let arcKitResult: unknown;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              arcKitResult = await arcKit.send({ from: { adapter, chain: chain as any }, to: output.paymentAddress, amount: String(output.paymentAmount), token: arcKitToken as any });
            } catch (arcErr: unknown) {
              console.error(`[chat/bitrefill] Layer 3 ❌ ArcKit failed (${pm}):`, summarizeError(arcErr, pm), arcErr);
              throw arcErr;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((arcKitResult as any)?.state && (arcKitResult as any).state !== "success") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              console.error(`[chat/bitrefill] Layer 3 ❌ ArcKit returned non-success state (${pm}):`, (arcKitResult as any).state);
              throw new Error("Transfer did not complete");
            }
          }
        }
      }

      setState("done");
      addToolResult({
        tool: "buy_bitrefill_product",
        toolCallId,
        output: {
          paid: true,
          invoiceId: output.invoiceId,
          isTopup: output.isTopup,
          tip: `USDC payment confirmed on-chain. Call poll_bitrefill_order(invoiceId="${output.invoiceId}", isTopup=${!!output.isTopup}) NOW. Keep retrying every ~3 s (up to 20 times) until status is complete/failed/expired. Do not ask the user anything.`,
        },
      });
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "Payment failed";

      // Normalise raw viem/EVM errors into user-friendly messages.
      const friendly = (() => {
        const m = msg.toLowerCase();
        if (m.includes("cancel") || m.includes("reject") || m.includes("denied"))
          return "Payment cancelled.";
        // Privy paymaster rejecting a token/chain that isn't configured.
        if (m.includes("not supported on") || m.includes("is not supported"))
          return "This payment method is temporarily unavailable. Please try again or use a different network.";
        // ArcKit validates the token contract (fetches decimals) via a public chain RPC
        // before sending. If that RPC is down or rate-limiting, this error surfaces.
        if (
          m.includes("validation failed for 'tokenaddress'") ||
          m.includes("failed to fetch decimals") ||
          (m.includes("http request failed") && (m.includes("arbitrum") || m.includes("polygon") || m.includes("optimism") || m.includes("ethereum")))
        ) {
          const network = (output.paymentMethod ?? "").includes("arbitrum") ? "Arbitrum"
            : (output.paymentMethod ?? "").includes("polygon") ? "Polygon"
            : (output.paymentMethod ?? "").includes("optimism") ? "Optimism"
            : (output.paymentMethod ?? "").includes("erc20") ? "Ethereum"
            : "this network";
          return `Network RPC error on ${network}. Please wait a moment and try again.`;
        }
        // Bitrefill server error — MCP transport wraps HTTP 5xx responses as
        // "Streamable HTTP error: Error POSTing to endpoint: <!doctype html>..."
        // (Cloudflare 502/503/504 pages, or Bitrefill's own 500 page).
        if (
          m.includes("streamable http error") ||
          m.includes("bad gateway") ||
          m.includes("<!doctype html") ||
          (m.includes("error posting to endpoint") && (m.includes("502") || m.includes("503") || m.includes("504") || m.includes("500")))
        ) return "Bitrefill is temporarily unavailable. Please try again in a few minutes.";
        // Bitrefill API rate limit — MCP transport wraps it as
        // "Streamable HTTP error: Error POSTing to endpoint: {status: rate_limit_reached}"
        if (m.includes("rate_limit") || m.includes("rate limit") || m.includes("request quota") || m.includes("quota"))
          return "Bitrefill rate limit reached. Please wait a moment and try again.";
        // USDT on Ethereum uses assert() for balance checks, which produces the
        // opaque InvalidFEOpcode / "invalid opcode: INVALID" revert instead of a
        // clear error. Catch it and surface a readable message.
        if (
          m.includes("invalidfeopcode") ||
          m.includes("invalid opcode") ||
          m.includes("fe opcode") ||
          (m.includes("simulation failed") && m.includes("ethereum"))
        ) {
          const token = (output.paymentMethod ?? "").includes("usdt") ? "USDT"
            : (output.paymentMethod ?? "").includes("usdc") ? "USDC" : "token";
          const network = (output.paymentMethod ?? "").includes("erc20") ? "Ethereum"
            : (output.paymentMethod ?? "").includes("polygon") ? "Polygon"
            : (output.paymentMethod ?? "").includes("arbitrum") ? "Arbitrum"
            : (output.paymentMethod ?? "").includes("optimism") ? "Optimism"
            : (output.paymentMethod ?? "").includes("base") ? "Base"
            : "this network";
          return `Insufficient ${token} balance on ${network}. Please add funds and try again.`;
        }
        // eth_estimateGas rejection: wallet has no native gas token (POL, ETH, etc.)
        if (
          m.includes("estimategas") ||
          m.includes("insufficient funds for gas") ||
          m.includes("insufficient funds for transfer") ||
          (m.includes("total cost") && m.includes("gas"))
        ) {
          const gasToken = (output.paymentMethod ?? "").includes("polygon") ? "POL"
            : (output.paymentMethod ?? "").includes("solana") ? "SOL"
            : "ETH";
          const network = (output.paymentMethod ?? "").includes("polygon") ? "Polygon"
            : (output.paymentMethod ?? "").includes("arbitrum") ? "Arbitrum"
            : (output.paymentMethod ?? "").includes("optimism") ? "Optimism"
            : (output.paymentMethod ?? "").includes("erc20") ? "Ethereum"
            : "this network";
          const stableToken = (output.paymentMethod ?? "").includes("usdt") ? "USDT" : "USDC";
          return `You need ${gasToken} for gas fees and ${stableToken} to send on ${network}. Please add both to your wallet and try again.`;
        }
        // Pass through pre-flight Solana SPL errors — they're already user-friendly
        // (e.g. "Insufficient USDC on Solana. You have $0.50 but need $1.00.")
        if ((m.includes("insufficient") || m.includes("not enough")) && m.includes("solana"))
          return msg;
        // Insufficient funds reported by wallet/RPC
        if (m.includes("insufficient") || m.includes("insufficient funds") || m.includes("not enough"))
          return "Insufficient balance. Please add funds and try again.";
        // ArcKit / Circle returns INTERNAL_ERROR for Solana payments when the wallet
        // has insufficient token balance. "Sender token account not found" means the
        // wallet has never received USDC/USDT on Solana (ATA doesn't exist yet — zero balance).
        if (
          m.includes("internal_error") ||
          m.includes("failed to process purchase") ||
          m.includes("token account not found") ||
          m.includes("sender token account")
        ) {
          const token = (output.paymentMethod ?? "").includes("usdt") ? "USDT" : "USDC";
          const network = (output.paymentMethod ?? "").includes("solana") ? "Solana" : "this network";
          return `Insufficient ${token} balance on ${network}. Please add funds and try again.`;
        }
        return msg;
      })();

      setErrMsg(friendly);
      setState("error");
      addToolResult({
        tool: "buy_bitrefill_product",
        toolCallId,
        output: { paid: false, error: friendly, invoiceId: output.invoiceId },
      });
    }
  };

  const handleCancel = () => {
    addToolResult({
      tool: "buy_bitrefill_product",
      toolCallId,
      output: { paid: false, error: "Cancelled by user", invoiceId: output.invoiceId },
    });
  };

  if (state === "manual" && manualAddress) {
    const network = evmNetworkLabel(pm);
    const tokenLabel = pm.includes("usdt") ? "USDT" : "USDC";
    return (
      <div className="my-2 rounded-xl border border-yellow-700/30 bg-yellow-900/10 px-4 py-3 space-y-2">
        <p className="text-xs font-semibold text-yellow-300">
          🟡 Send manually — {network} {tokenLabel}
        </p>
        <p className="text-xs text-[#A7A79A]">
          Gasless payment is temporarily unavailable. Send exactly{" "}
          <span className="font-mono font-semibold text-[#F2F0E8]">
            {output.paymentAmount} {tokenLabel}
          </span>{" "}
          to the address below using the <span className="text-[#F2F0E8]">{network}</span> network.
        </p>
        <div className="rounded-lg bg-[#141513] px-3 py-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-[#F2F0E8] break-all">{manualAddress}</span>
          <button
            onClick={() => {
              navigator.clipboard.writeText(manualAddress).then(() => {
                setManualCopied(true);
                setTimeout(() => setManualCopied(false), 2000);
              });
            }}
            className="shrink-0 rounded-lg border border-[#2A2B27] px-2 py-1 text-[10px] text-[#A7A79A] hover:bg-white/[0.06] transition-colors"
          >
            {manualCopied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        <p className="text-[10px] text-[#A7A79A]">
          ⚠ Only send on {network} — sending on another network will result in loss of funds.
        </p>
      </div>
    );
  }

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
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
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
      addToolResult({ toolCallId, output: { success: true, txHash } });
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "Transaction failed";
      setError(msg);
      addToolResult({ toolCallId, output: { success: false, error: msg } });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, output: { success: false, error: "User cancelled" } });
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
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
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
      addToolResult({ toolCallId, output: { success: true, signature: sig, action: output.action } });
    } catch (err: any) {
      const msg = err?.message ?? "Transaction failed";
      setError(msg);
      addToolResult({ toolCallId, output: { success: false, error: msg } });
    } finally {
      setBusy(false);
    }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, output: { success: false, error: "User rejected" } });
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
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
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
      addToolResult({ toolCallId, output: { success: true, signature: sig, sessionPubkey, expiresAt } });
    } catch (err: any) {
      const msg = err?.message ?? "Failed";
      setError(msg);
      addToolResult({ toolCallId, output: { success: false, error: msg } });
    } finally { setBusy(false); }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, output: { success: false, error: "User rejected" } });
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
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
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
      addToolResult({ toolCallId, output: { success: true, signature: sig } });
    } catch (err: any) {
      const msg = err?.message ?? "Failed";
      setError(msg);
      addToolResult({ toolCallId, output: { success: false, error: msg } });
    } finally { setBusy(false); }
  };

  const handleReject = () => {
    addToolResult({ toolCallId, output: { success: false, error: "User cancelled" } });
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
                            addToolResult={addToolResult as any}
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
                            addToolResult={addToolResult as any}
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
                            addToolResult={addToolResult as any}
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
                            addToolResult={addToolResult as any}
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
                            addToolResult={addToolResult as any}
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
                            addToolResult={addToolResult as any}
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
                            addToolResult={addToolResult as any}
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
                            addToolResult={addToolResult as any}
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
