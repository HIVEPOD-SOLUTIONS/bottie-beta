"use client";

import { useState } from "react";
import { ChainTopUpPanel } from "@/components/dashboard/chain-topup-panel";
import { isSwapChain, SWAP_CHAIN_META, type SwapChain } from "@/lib/swap-chains";

/**
 * fund_wallet_from_chain — puts USDC (or ETH) into the user's Bluvfi wallet on
 * Base from Arc, Tempo, Robinhood Chain, Zcash or Hyperliquid. Nothing moves
 * until the user acts in the panel. Reports {funded:true} back to the chat.
 */
type Output = {
  chainTopUp: true;
  chain?: SwapChain;
  token: "usdc" | "eth";
  amount: string;
  amountUsd: number;
  refundAddress?: string;
  funded?: boolean;
};

export function ChainTopUpCard({
  toolCallId,
  output,
  addToolResult,
}: {
  toolCallId: string;
  output: Output;
  addToolResult: (args: { tool?: string; toolCallId: string; output: unknown }) => void;
}) {
  const [funded, setFunded] = useState(output.funded === true);
  const symbol = output.token === "eth" ? "ETH" : "USDC";
  if (funded) {
    return (
      <div className="my-2 rounded-xl border border-green-700/30 bg-green-900/10 px-4 py-2">
        <p className="text-xs text-green-400">✓ {output.amount} {symbol} is in your Bluvfi wallet on Base.</p>
      </div>
    );
  }
  return (
    <div className="my-2">
      <ChainTopUpPanel
        token={output.token}
        amount={output.amount}
        amountUsd={output.amountUsd}
        purpose="wallet"
        initialChain={isSwapChain(output.chain) ? output.chain : undefined}
        initialRefundAddress={output.refundAddress}
        title={`Add ${output.amount} ${symbol} to your wallet on Base`}
        onFunded={() => {
          setFunded(true);
          addToolResult({
            tool: "fund_wallet_from_chain",
            toolCallId,
            output: { ...output, funded: true, tip: `Done: ${output.amount} ${symbol} arrived in the user's Bluvfi wallet on Base${output.chain ? ` (paid from ${SWAP_CHAIN_META[output.chain].label})` : ""}. Continue with what they wanted to pay for.` },
          });
        }}
      />
    </div>
  );
}
