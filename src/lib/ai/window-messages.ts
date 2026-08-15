import type { UIMessage } from "ai";

const RECENT_WINDOW = 20;
const MAX_RECAP_LINES = 30;

const ACTION_TOOLS = new Set([
  // Bills & investments
  "buy_bitrefill_product",
  "poll_bitrefill_order",
  "buy_investment",
  // x402 / nanopay / solpay
  "nanopay_pay",
  "nanopay_deposit",
  "nanopay_deposit_for",
  "nanopay_withdraw",
  "nanopay_transfer",
  "nanopay_initiate_trustless_withdrawal",
  "solpay_pay",
  "solpay_transfer",
  "x402_pay",
  // Banking (onramp / offramp)
  "create_onramp_order",
  "create_offramp_order",
  "add_offramp_bank_account",
  // Velvet write ops
  "deposit_velvet_portfolio",
  "withdraw_velvet_portfolio",
  "rebalance_velvet_portfolio",
  "update_velvet_weights",
  "remove_velvet_token",
  "velvet_borrow",
  "propose_velvet_fee",
  "update_velvet_fee",
  "manage_velvet_whitelist",
  "manage_velvet_collateral",
  // Flash write ops
  "flash_open_position",
  "flash_close_position",
  "flash_increase_position",
  "flash_add_collateral",
  "flash_remove_collateral",
  "flash_place_limit_order",
  "flash_place_trigger_order",
  "flash_cancel_order",
  "flash_cancel_all_triggers",
  "flash_swap",
  "flash_add_liquidity",
  "flash_remove_liquidity",
  "flash_add_compounding",
  "flash_remove_compounding",
  "flash_stake_flash",
  "flash_unstake_flash",
  "flash_withdraw_flash",
  "flash_deposit_to_vault",
  "flash_withdraw_from_vault",
  "flash_create_session",
  "flash_revoke_session",
  "flash_create_referral",
  // Grail (gold trading)
  "grail_cancel_redemption",
  // Roaster
  "roaster_create_battle",
  "roaster_back_side",
  "roaster_create_rap",
  // Fuze write ops
  "fuze_create_user",
  "fuze_accept_tnc",
  "fuze_create_trade_quote",
  "fuze_execute_trade_order",
  "fuze_create_internal_transfer",
  "fuze_create_external_transfer",
  "fuze_confirm_external_transfer",
  "fuze_remittance_payment",
  "fuze_create_remittance_payout",
  // SpherePay write ops
  "spherepay_create_customer",
  "spherepay_create_transfer",
  "spherepay_cancel_transfer",
  "spherepay_register_bank_account",
  "spherepay_register_wallet",
  // xStocks write ops
  "xstocks_xchange_rfq",
  "xstocks_whitelist_challenge",
  "xstocks_submit_whitelist",
  // Banking payout & collection suite
  "initiate_payout",
  "send_payout",
  "create_banking_sub_account",
  "transfer_sub_account_funds",
  "validate_payout_bank_account",
  "transfer_to_payout_wallet",
  "banking_transfer",
  "initiate_banking_collection",
  "deactivate_offramp_bank_account",
  "review_offramp_bank_account",
  "banking_payout_trade",
  "solana_transfer_usdc",
  // Velvet vault prefs
  "set_vault_pref",
  "remove_vault_pref",
  // Bills management
  "update_bill",
  "delete_bill",
  // Goals
  "create_goal",
  "delete_goal",
  // Velvet additional write ops
  "update_velvet_settings",
  "claim_velvet_removed_tokens",
  "manage_velvet_vault_list",
  // Grail submit ops (execute signed tx on-chain)
  "grail_create_redemption",
  "grail_submit_buy",
  "grail_submit_sell",
  "grail_submit_redemption",
  // Nosana write ops
  "nosana_create_deployment",
  "nosana_start_deployment",
  "nosana_stop_deployment",
  "nosana_archive_deployment",
  // nanopay complete trustless withdrawal
  "nanopay_complete_trustless_withdrawal",
  // DOMA marketplace write ops
  "doma_complete_email_verification",
  "doma_upload_registrant_contacts",
  "doma_upload_verified_registrant_contacts",
  "doma_prepare_buy",
  "doma_prepare_accept_offer",
  "doma_reset_event_cursor",
  "doma_initiate_email_verification",
  "doma_create_listing",
  "doma_create_offer",
  "doma_create_bulk_listings",
  "doma_create_bulk_offers",
  "doma_cancel_listing",
  "doma_cancel_offer",
  // SpherePay upload document
  "spherepay_upload_document",
  // SpherePay additional write ops
  "spherepay_create_quote",
  "spherepay_create_virtual_account",
  "spherepay_create_offloader_wallet",
  "spherepay_add_business_rep",
  "spherepay_create_kyc_link",
  "spherepay_update_customer",
  "spherepay_delete_bank_account",
  "spherepay_delete_wallet",
  "spherepay_deactivate_virtual_account",
  "spherepay_delete_business_rep",
  "spherepay_update_business_rep",
  "spherepay_update_bank_account",
  "spherepay_update_offloader_wallet",
  "spherepay_update_quote_status",
  "spherepay_update_virtual_account",
  // Fuze additional write ops (user, counterparty, wallet, account, remittance, KYC)
  "fuze_update_user",
  "fuze_create_counterparty",
  "fuze_create_internal_wallet",
  "fuze_delete_external_wallet",
  "fuze_register_external_wallet",
  "fuze_create_internal_account",
  "fuze_register_external_account",
  "fuze_create_remittance_originator",
  "fuze_create_remittance_beneficiary",
  "fuze_create_remittance_originator_with_beneficiary",
  "fuze_create_remittance_payout_to_beneficiary",
  "fuze_update_edd",
  "fuze_upsert_kyc",
  // Flash additional write ops
  "flash_migrate_to_sflp",
  "flash_migrate_to_flp",
  "flash_collect_revenue",
  "flash_collect_rebate",
  "flash_collect_flp_reward",
  "flash_collect_stake_reward",
  "flash_cancel_unstake",
  "flash_edit_limit_order",
  "flash_edit_trigger_order",
  // Fuze additional write ops
  "fuze_delete_counterparty",
  "fuze_cancel_order",
  "fuze_update_external_transfer",
  "fuze_create_reversal",
  "fuze_upsert_webhook",
  "fuze_simulate_webhook",
  "fuze_create_watchlist",
  "fuze_update_watchlist",
  "fuze_delete_watchlist",
  "fuze_delete_user",
  "fuze_gateway_create_customer",
  "fuze_gateway_update_customer_kyc",
  "fuze_gateway_create_deposit_wallet",
  "fuze_gateway_create_payin_quote",
  "fuze_gateway_create_payin",
  "fuze_gateway_create_payout_quote",
  "fuze_gateway_create_payout",
  "fuze_gateway_create_refund",
  "fuze_gateway_whitelist_wallet",
]);

interface ToolPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: Record<string, string>;
  output?: unknown;
}

function formatActionFact(toolName: string, input: Record<string, string>, output: unknown): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = typeof output === "string" ? JSON.parse(output) : (output as Record<string, unknown>) ?? {};
  } catch {
    parsed = {};
  }

  const failed = parsed.success === false;
  const cancelled = failed && String(parsed.error || "").toLowerCase().includes("cancel");

  let line: string;

  switch (toolName) {
    case "buy_bitrefill_product": {
      const p = parsed as any;
      const emailNote = p?.recipientEmail ? ` → ${p.recipientEmail}` : "";
      if (p?.pendingBitrefillPayment) {
        const method = p.paymentMethod ?? (input.network === "solana" ? "usdc_solana" : "usdc_base");
        const amount = p.paymentAmount ?? "?";
        const currency = p.paymentCurrency ?? "USDC";
        const actionNote = p.isAddressBased ? " (deposit address ready)" : " (auto-pay)";
        line = `Invoice created for ${input.productId} — ${amount} ${currency} via ${method}${actionNote}${emailNote}`;
      } else {
        line = `Failed to create invoice for ${input.productId}: ${p?.error ?? "unknown error"}`;
      }
      break;
    }
    case "poll_bitrefill_order": {
      const status = (parsed as any)?.status;
      line = status === "complete"
        ? `Gift card code ready for invoice ${input.invoiceId} — sent to ${(parsed as any)?.productName ?? "user"}`
        : `Invoice ${input.invoiceId} status: ${status ?? "pending"}`;
      break;
    }
    case "buy_investment": {
      const netLabel = input.network === "solana" ? " via Solana" : input.network === "evm" ? " via Base" : "";
      line = (parsed as any)?.pendingPurchase
        ? `Queued purchase of ${input.shares} share(s) of ${input.symbol} — $${(parsed as any)?.totalUsdc ?? "?"} USDC${netLabel} (awaiting user confirmation)`
        : `Failed to queue purchase of ${input.symbol}`;
      break;
    }
    case "nanopay_pay":
      line = (parsed as any)?.status === "success"
        ? `Paid x402 resource (EVM): ${input.url}`
        : `EVM nanopayment failed for: ${input.url}`;
      break;
    case "nanopay_deposit":
      line = (parsed as any)?.depositTxHash
        ? `Deposited ${input.amount} USDC into Gateway`
        : ((parsed as any)?.skipped ? `Gateway deposit skipped — balance sufficient` : `Gateway deposit failed`);
      break;
    case "nanopay_deposit_for":
      line = (parsed as any)?.success
        ? `Funded Gateway balance for ${input.address ?? "address"} — ${input.amount} USDC`
        : `Failed to fund Gateway for ${input.address ?? "address"}`;
      break;
    case "nanopay_withdraw":
      line = (parsed as any)?.mintTxHash
        ? `Withdrew ${input.amount} USDC from Gateway`
        : `Gateway withdrawal failed`;
      break;
    case "nanopay_transfer":
      line = (parsed as any)?.transferId
        ? `Transferred ${input.amount} USDC via Gateway to ${input.toAddress ?? input.to ?? "address"} (id: ${String((parsed as any).transferId).slice(0, 12)}…)`
        : `Gateway transfer failed to ${input.toAddress ?? input.to ?? "address"}`;
      break;
    case "nanopay_initiate_trustless_withdrawal":
      line = (parsed as any)?.success
        ? `Initiated trustless withdrawal of ${input.amount} USDC from Gateway`
        : `Trustless withdrawal initiation failed`;
      break;
    case "solpay_pay":
      line = (parsed as any)?.paid
        ? `Paid x402/MPP resource (Solana): ${input.url}`
        : `Solana payment failed for: ${input.url}`;
      break;
    case "solpay_transfer":
      line = (parsed as any)?.txSignature
        ? `Transferred ${input.amountUsdc} USDC (Solana) to ${input.toAddress ?? "address"}`
        : `Solana USDC transfer failed to ${input.toAddress ?? "address"}`;
      break;
    case "create_onramp_order": {
      const orderId = (parsed as any)?.order?.id ?? (parsed as any)?.id;
      const amount = input.cryptoAmount ?? input.amount ?? "?";
      const curr = input.cryptoCurrency ?? "crypto";
      line = orderId
        ? `Created onramp order: ${amount} ${curr} (id: ${String(orderId).slice(0, 12)}…)`
        : `Failed to create onramp order`;
      break;
    }
    case "create_offramp_order": {
      const orderId2 = (parsed as any)?.order?.id ?? (parsed as any)?.id;
      const amount2 = input.cryptoAmount ?? input.amount ?? "?";
      const curr2 = input.cryptoCurrency ?? "crypto";
      line = orderId2
        ? `Created offramp order: ${amount2} ${curr2} → INR (id: ${String(orderId2).slice(0, 12)}…)`
        : `Failed to create offramp order`;
      break;
    }
    case "add_offramp_bank_account":
      line = (parsed as any)?.id
        ? `Added offramp bank account (id: ${String((parsed as any).id).slice(0, 12)}…)`
        : `Failed to add bank account`;
      break;
    case "deposit_velvet_portfolio":
      line = (parsed as any)?.txData
        ? `Prepared Velvet deposit into portfolio ${input.portfolio_address ?? "?"} (awaiting signature)`
        : `Failed to prepare Velvet deposit`;
      break;
    case "withdraw_velvet_portfolio":
      line = (parsed as any)?.txData
        ? `Prepared Velvet withdrawal from portfolio ${input.portfolio_address ?? "?"} (awaiting signature)`
        : `Failed to prepare Velvet withdrawal`;
      break;
    case "rebalance_velvet_portfolio":
    case "update_velvet_weights":
      line = (parsed as any)?.txData
        ? `Prepared Velvet rebalance for portfolio ${input.rebalancing_address ?? "?"} (awaiting signature)`
        : `Failed to prepare Velvet rebalance`;
      break;
    case "remove_velvet_token":
      line = (parsed as any)?.txData
        ? `Prepared Velvet token removal from portfolio ${input.portfolio_address ?? "?"} (awaiting signature)`
        : `Failed to prepare Velvet token removal`;
      break;
    case "velvet_borrow":
      line = (parsed as any)?.txData
        ? `Prepared Velvet borrow against portfolio ${input.rebalancing_address ?? "?"} (awaiting signature)`
        : `Failed to prepare Velvet borrow`;
      break;
    case "propose_velvet_fee":
      line = (parsed as any)?.txData
        ? `Proposed Velvet fee change (${input.fee_type}: ${input.new_fee_bps} bps) — 28-day timelock starts`
        : `Failed to propose Velvet fee change`;
      break;
    case "update_velvet_fee":
      line = (parsed as any)?.txData
        ? `${input.action === "cancel" ? "Cancelled" : "Applied"} Velvet fee change`
        : `Failed to update Velvet fee`;
      break;
    case "manage_velvet_whitelist":
      line = (parsed as any)?.txData
        ? `${input.action === "add" ? "Whitelisted" : "Removed"} wallet(s) on Velvet`
        : `Failed to update Velvet whitelist`;
      break;
    case "manage_velvet_collateral":
      line = (parsed as any)?.txData
        ? `${input.action === "enable" ? "Enabled" : "Disabled"} collateral for Velvet portfolio ${input.rebalancing_address ?? "?"}`
        : `Failed to update Velvet collateral`;
      break;
    case "flash_open_position":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash position open — ${input.market} ${input.side} ${input.collateralUsd} USD × ${input.leverage}× (awaiting signature)`
        : `Failed to queue Flash position open`;
      break;
    case "flash_close_position":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash position close — ${input.closePercent ?? 100}% of ${input.marketId ?? "position"} (awaiting signature)`
        : `Failed to queue Flash position close`;
      break;
    case "flash_increase_position":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash position increase — ${input.marketId ?? "?"} +${input.collateralUsd} USD collateral`
        : `Failed to queue Flash position increase`;
      break;
    case "flash_add_collateral":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash add collateral — ${input.marketId ?? "?"} +${input.collateralUsd} USD`
        : `Failed to queue Flash add collateral`;
      break;
    case "flash_remove_collateral":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash remove collateral — ${input.marketId ?? "?"} −${input.collateralUsd} USD`
        : `Failed to queue Flash remove collateral`;
      break;
    case "flash_place_limit_order":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash limit order — ${input.market} ${input.side} @ ${input.limitPrice}`
        : `Failed to queue Flash limit order`;
      break;
    case "flash_place_trigger_order":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash trigger order — ${input.triggerAbove ? "TP" : "SL"} @ ${input.triggerPrice} (${input.sizePercent}%)`
        : `Failed to queue Flash trigger order`;
      break;
    case "flash_cancel_order":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash order cancel for ${input.orderId ?? "?"}`
        : `Failed to queue Flash order cancel`;
      break;
    case "flash_cancel_all_triggers":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash cancel-all-triggers for market ${input.marketId ?? "?"}`
        : `Failed to queue Flash cancel-all-triggers`;
      break;
    case "flash_swap":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash swap — ${input.inAmount} ${input.inSymbol} → ${input.outSymbol}`
        : `Failed to queue Flash swap`;
      break;
    case "flash_add_liquidity":
    case "flash_add_compounding":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash liquidity deposit — ${input.inAmount} ${input.inSymbol}`
        : `Failed to queue Flash liquidity deposit`;
      break;
    case "flash_remove_liquidity":
    case "flash_remove_compounding":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash liquidity removal — ${input.lpAmount ?? input.amount} LP tokens`
        : `Failed to queue Flash liquidity removal`;
      break;
    case "flash_stake_flash":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash FLASH stake — ${input.amount} FLASH`
        : `Failed to queue Flash stake`;
      break;
    case "flash_unstake_flash":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash FLASH unstake — ${input.amount} FLASH (cooldown starts)`
        : `Failed to queue Flash unstake`;
      break;
    case "flash_withdraw_flash":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash FLASH withdrawal (requestId: ${input.withdrawRequestId ?? "?"})`
        : `Failed to queue Flash withdrawal`;
      break;
    case "flash_deposit_to_vault":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash vault deposit — ${input.amount} ${input.symbol}`
        : `Failed to queue Flash vault deposit`;
      break;
    case "flash_withdraw_from_vault":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash vault withdrawal — ${input.amount} ${input.symbol}`
        : `Failed to queue Flash vault withdrawal`;
      break;
    case "flash_create_session":
      line = (parsed as any)?.pendingFlashSession
        ? `Queued Flash session creation (24h session key, no per-trade popups)`
        : `Failed to create Flash session`;
      break;
    case "flash_revoke_session":
      line = (parsed as any)?.pendingFlashRevoke
        ? `Queued Flash session revocation`
        : `Flash session already inactive or revocation failed`;
      break;
    case "flash_create_referral":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash referral link to ${input.referrer ?? "?"}`
        : `Failed to queue Flash referral`;
      break;
    case "grail_cancel_redemption":
      line = (parsed as any)?.status === "cancelled"
        ? `Cancelled Grail gold redemption ${input.redemption_id ?? "?"}`
        : `Failed to cancel Grail redemption ${input.redemption_id ?? "?"}`;
      break;
    case "roaster_create_battle":
      line = (parsed as any)?.battle_id
        ? `Created Roaster battle "${input.topic ?? "?"}" (id: ${String((parsed as any).battle_id).slice(0, 12)}…) — signing card rendered`
        : `Failed to create Roaster battle`;
      break;
    case "roaster_back_side":
      line = (parsed as any)?.pendingRoasterBack
        ? `Queued Roaster backing — $${(parsed as any).amount_usdc ?? input.amount_usdc} USDC on Side ${(parsed as any).side === 0 ? "A" : "B"} (signing card rendered)`
        : `Failed to queue Roaster backing`;
      break;
    case "roaster_create_rap":
      line = (parsed as any)?.rap_id
        ? `Created Roaster rap (id: ${String((parsed as any).rap_id).slice(0, 12)}…) — AI generating track`
        : `Failed to create Roaster rap`;
      break;
    case "fuze_create_user":
      line = (parsed as any)?.userId ?? (parsed as any)?.data?.userId
        ? `Created Fuze user ${input.orgUserId ?? "?"}`
        : `Failed to create Fuze user`;
      break;
    case "fuze_accept_tnc":
      line = (parsed as any)?.success
        ? `Accepted Fuze T&C for user ${input.orgUserId ?? "?"} — account now ACTIVE`
        : `Failed to accept Fuze T&C`;
      break;
    case "fuze_create_trade_quote":
      line = (parsed as any)?.quoteId ?? (parsed as any)?.data?.quoteId
        ? `Created Fuze trade quote ${input.fromCurrency}→${input.toCurrency} (quoteId locked)`
        : `Failed to create Fuze trade quote`;
      break;
    case "fuze_execute_trade_order":
      line = (parsed as any)?.orderId ?? (parsed as any)?.data?.orderId
        ? `Executed Fuze trade order (quoteId: ${input.quoteId ?? "?"})`
        : `Failed to execute Fuze trade order`;
      break;
    case "fuze_create_internal_transfer":
      line = (parsed as any)?.transferId ?? (parsed as any)?.data?.transferId
        ? `Fuze internal transfer — ${input.amount} ${input.currency} to ${input.toUserId ?? "?"}`
        : `Failed to create Fuze internal transfer`;
      break;
    case "fuze_create_external_transfer":
      line = (parsed as any)?.transferId ?? (parsed as any)?.data?.transferId
        ? `Created Fuze external transfer — ${input.amount} ${input.currency} (awaiting confirm)`
        : `Failed to create Fuze external transfer`;
      break;
    case "fuze_confirm_external_transfer":
      line = (parsed as any)?.success
        ? `Confirmed Fuze external transfer ${input.transferId ?? "?"}`
        : `Failed to confirm Fuze transfer`;
      break;
    case "fuze_remittance_payment":
      line = (parsed as any)?.paymentId ?? (parsed as any)?.data?.paymentId
        ? `Executed Fuze remittance (quoteId: ${input.quoteId ?? "?"})`
        : `Failed to execute Fuze remittance`;
      break;
    case "fuze_create_remittance_payout":
      line = (parsed as any)?.payoutId ?? (parsed as any)?.data?.payoutId
        ? `Created Fuze remittance payout — ${input.amount} ${input.currency ?? "?"}`
        : `Failed to create Fuze remittance payout`;
      break;
    case "spherepay_create_customer":
      line = (parsed as any)?.id
        ? `Created SpherePay customer ${input.email ?? "?"} (id: ${String((parsed as any).id).slice(0, 12)}…)`
        : `Failed to create SpherePay customer`;
      break;
    case "spherepay_create_transfer":
      line = (parsed as any)?.id
        ? `Created SpherePay transfer ${input.amount} ${input.currency ?? "?"} (id: ${String((parsed as any).id).slice(0, 12)}…)`
        : `Failed to create SpherePay transfer`;
      break;
    case "spherepay_cancel_transfer":
      line = (parsed as any)?.success
        ? `Cancelled SpherePay transfer ${input.transferId ?? "?"}`
        : `Failed to cancel SpherePay transfer`;
      break;
    case "spherepay_register_bank_account":
      line = (parsed as any)?.id
        ? `Registered SpherePay bank account for customer ${input.customerId ?? "?"}`
        : `Failed to register SpherePay bank account`;
      break;
    case "spherepay_register_wallet":
      line = (parsed as any)?.id
        ? `Registered SpherePay wallet for customer ${input.customerId ?? "?"}`
        : `Failed to register SpherePay wallet`;
      break;
    case "xstocks_xchange_rfq":
      line = (parsed as any)?.quoteId ?? (parsed as any)?.id
        ? `Created xStocks firm RFQ — ${input.side} ${input.quantity ?? input.notional} ${input.symbol}`
        : `Failed to create xStocks RFQ`;
      break;
    case "xstocks_whitelist_challenge":
      line = (parsed as any)?.challenge
        ? `Generated xStocks whitelist challenge for ${input.walletAddress ?? "?"} on ${input.chain ?? "?"}`
        : `Failed to generate xStocks whitelist challenge`;
      break;
    case "xstocks_submit_whitelist":
      line = (parsed as any)?.success
        ? `Submitted xStocks whitelist for ${input.walletAddress ?? "?"} on ${input.chain ?? "?"}`
        : `Failed to submit xStocks whitelist`;
      break;
    // Banking payout suite
    case "initiate_payout":
      line = (parsed as any)?.payout_id ?? (parsed as any)?.payoutId ?? (parsed as any)?.id
        ? `Initiated ${(input.currency ?? "fiat").toUpperCase()} payout of ${input.amount} to ${input.account_holder_name ?? "?"} via ${input.provider ?? "?"}`
        : `Failed to initiate payout`;
      break;
    case "validate_payout_bank_account":
      line = (parsed as any)?.valid || (parsed as any)?.status === "valid"
        ? `Validated bank account for ${input.account_holder_name ?? "?"} (${input.ifsc ?? "?"})`
        : `Bank account validation failed for ${input.account_holder_name ?? "?"}`;
      break;
    case "transfer_to_payout_wallet":
      line = (parsed as any)?.success || (parsed as any)?.transferId
        ? `Transferred ${input.amount} ${input.currency ?? "INR"} to payout wallet via ${input.provider ?? "?"}`
        : `Failed to transfer to payout wallet`;
      break;
    case "initiate_banking_collection":
      line = (parsed as any)?.id ?? (parsed as any)?.transactionId ?? (parsed as any)?.virtualAccountId
        ? `Initiated banking collection of ${input.amount} via ${input.provider ?? "?"}`
        : `Failed to initiate banking collection`;
      break;
    case "deactivate_offramp_bank_account":
      line = (parsed as any)?.success || (parsed as any)?.status === "deactivated"
        ? `Deactivated offramp bank account ${input.bank_account_id ?? "?"} via ${input.provider ?? "?"}`
        : `Failed to deactivate offramp bank account`;
      break;
    case "review_offramp_bank_account":
      line = (parsed as any)?.status || (parsed as any)?.id
        ? `Submitted bank account for review — ${input.first_name ?? "?"} ${input.last_name ?? ""} (${input.ifsc ?? "?"})`
        : `Failed to submit bank account for review`;
      break;
    case "banking_payout_trade":
      line = (parsed as any)?.tradeId ?? (parsed as any)?.id ?? (parsed as any)?.merchant_trade_id
        ? `Swapped ${input.from_amount} ${input.from_currency ?? "?"} → ${input.to_currency ?? "?"} in payout wallet via ${input.provider ?? "?"}`
        : `Failed to execute payout trade`;
      break;
    case "send_payout":
      line = (parsed as any)?.payout_id ?? (parsed as any)?.payoutId ?? (parsed as any)?.id
        ? `Sent ${(input.currency ?? "fiat").toUpperCase()} payout of ${input.amount} to ${input.account_holder_name ?? "?"} via ${input.provider ?? "?"}`
        : `Failed to send payout`;
      break;
    case "banking_transfer":
      line = (parsed as any)?.success || (parsed as any)?.transferId || (parsed as any)?.id
        ? `Transferred ${input.amount} ${input.currency ?? "INR"} to payout wallet via ${input.provider ?? "?"}`
        : `Failed to transfer to payout wallet`;
      break;
    case "create_banking_sub_account":
      line = (parsed as any)?.sub_account_id
        ? `Created banking sub-account "${input.label ?? (parsed as any)?.label ?? "?"}" (id: ${(parsed as any).sub_account_id}) via ${input.provider ?? "?"}`
        : `Failed to create banking sub-account`;
      break;
    case "transfer_sub_account_funds":
      line = (parsed as any)?.transfer_id
        ? `Transferred ${input.amount} ${input.currency ?? "?"} from sub-account ${input.from_sub_account_id ?? "main"} → ${input.to_sub_account_id ?? "main"} via ${input.provider ?? "?"}`
        : `Failed to transfer between sub-accounts`;
      break;
    case "solana_transfer_usdc":
      line = (parsed as any)?.transaction
        ? `Built USDC transfer tx of ${input.amountUsdc} USDC from ${(input.from as string)?.slice(0, 8) ?? "?"} (awaiting user signature)`
        : `Failed to build Solana USDC transfer`;
      break;
    case "set_vault_pref":
      line = (parsed as any)?.ok
        ? `${input.status === "added" ? "Pinned" : "Hidden"} Velvet vault ${input.portfolioAddress ?? "?"} on dashboard`
        : `Failed to set vault preference`;
      break;
    case "remove_vault_pref":
      line = (parsed as any)?.ok
        ? `Reset dashboard preference for Velvet vault ${input.portfolioAddress ?? "?"}`
        : `Failed to remove vault preference`;
      break;
    case "update_bill":
      line = (parsed as any)?.bill?.id
        ? `Updated bill ${input.billId ?? "?"}${input.status ? ` → status: ${input.status}` : ""}${input.autopay !== undefined ? ` autopay: ${input.autopay}` : ""}`
        : `Failed to update bill`;
      break;
    case "delete_bill":
      line = (parsed as any)?.success
        ? `Deleted bill ${input.billId ?? "?"}`
        : `Failed to delete bill`;
      break;
    // Goals
    case "update_velvet_settings":
      line = (parsed as any)?.txData
        ? `Updated Velvet vault settings (${input.setting ?? "?"}) for portfolio ${input.portfolio_address ?? "?"}`
        : `Failed to update Velvet settings`;
      break;
    case "claim_velvet_removed_tokens":
      line = (parsed as any)?.txData
        ? `Claimed removed tokens from Velvet portfolio ${input.portfolio_address ?? "?"}`
        : `Failed to claim Velvet removed tokens`;
      break;
    case "manage_velvet_vault_list":
      line = !(parsed as any)?.error
        ? `${input.action === "add_vault" ? "Pinned" : input.action === "remove_vault" ? "Unpinned" : input.action === "hide_vault" ? "Hidden" : "Un-hidden"} Velvet vault ${String(input.address ?? "?").slice(0, 10)}… in watchlist`
        : `Failed to update Velvet vault watchlist`;
      break;
    case "grail_create_redemption":
      line = (parsed as any)?.redemption_id
        ? `Created GRAIL gold redemption request — ${input.denomination_id ?? "?"} in ${input.city ?? "?"} (id: ${(parsed as any).redemption_id})`
        : `Failed to create GRAIL redemption`;
      break;
    case "grail_submit_buy":
      line = !(parsed as any)?.error
        ? `Submitted GRAIL gold buy transaction (trade_id: ${input.trade_id ?? "?"})`
        : `Failed to submit GRAIL buy transaction`;
      break;
    case "grail_submit_sell":
      line = !(parsed as any)?.error
        ? `Submitted GRAIL gold sell transaction (trade_id: ${input.trade_id ?? "?"})`
        : `Failed to submit GRAIL sell transaction`;
      break;
    case "grail_submit_redemption":
      line = !(parsed as any)?.error
        ? `Submitted GRAIL gold redemption for delivery (redemption_id: ${input.redemption_id ?? "?"})`
        : `Failed to submit GRAIL redemption`;
      break;
    case "nosana_create_deployment":
      line = (parsed as any)?.id
        ? `Created Nosana GPU deployment (image: ${(parsed as any)?.job_definition?.ops?.[0]?.args?.image ?? input.image ?? "?"})`
        : `Failed to create Nosana deployment`;
      break;
    case "nosana_start_deployment":
      line = (parsed as any)?.id
        ? `Started Nosana deployment ${(parsed as any)?.id ?? input.id ?? "?"}`
        : `Failed to start Nosana deployment`;
      break;
    case "nosana_stop_deployment":
      line = (parsed as any)?.id
        ? `Stopped Nosana deployment ${(parsed as any)?.id ?? input.id ?? "?"}`
        : `Failed to stop Nosana deployment`;
      break;
    case "nosana_archive_deployment":
      line = (parsed as any)?.id
        ? `Archived Nosana deployment ${(parsed as any)?.id ?? input.id ?? "?"}`
        : `Failed to archive Nosana deployment`;
      break;
    case "create_goal":
      line = (parsed as any)?.goal?.id ?? (parsed as any)?.goal
        ? `Set savings goal "${input.name}" — ${input.targetAmount} ${input.currency} for vault ${input.vaultId ?? "?"}`
        : `Failed to create savings goal`;
      break;
    case "delete_goal":
      line = (parsed as any)?.success
        ? `Deleted savings goal for vault ${input.vaultId ?? "?"}`
        : `Failed to delete savings goal`;
      break;
    case "nanopay_complete_trustless_withdrawal":
      line = (parsed as any)?.claimTxHash
        ? `Completed trustless withdrawal — claimed USDC from Gateway (tx: ${String((parsed as any).claimTxHash).slice(0, 16)}…)`
        : `Failed to complete trustless withdrawal`;
      break;
    // DOMA marketplace write ops
    case "doma_complete_email_verification":
      line = (parsed as any)?.success !== false
        ? `Completed DOMA email verification for ${input.email ?? "?"}`
        : `Failed to complete DOMA email verification`;
      break;
    case "doma_upload_registrant_contacts":
      line = (parsed as any)?.success !== false
        ? `Uploaded DOMA registrant contacts`
        : `Failed to upload DOMA registrant contacts`;
      break;
    case "doma_upload_verified_registrant_contacts":
      line = (parsed as any)?.success !== false
        ? `Uploaded verified DOMA registrant contacts`
        : `Failed to upload verified DOMA registrant contacts`;
      break;
    case "doma_prepare_buy":
      line = (parsed as any)?.tx ?? (parsed as any)?.transaction ?? (parsed as any)?.pendingTx
        ? `Prepared DOMA buy transaction for ${input.name ?? "?"}`
        : `Failed to prepare DOMA buy transaction`;
      break;
    case "doma_prepare_accept_offer":
      line = (parsed as any)?.tx ?? (parsed as any)?.transaction ?? (parsed as any)?.pendingTx
        ? `Prepared DOMA accept-offer transaction for ${input.name ?? "?"}`
        : `Failed to prepare DOMA accept-offer transaction`;
      break;
    case "doma_reset_event_cursor":
      line = (parsed as any)?.success !== false
        ? `Reset DOMA event cursor`
        : `Failed to reset DOMA event cursor`;
      break;
    case "spherepay_upload_document":
      line = (parsed as any)?.documentId ?? (parsed as any)?.id ?? (parsed as any)?.success !== false
        ? `Uploaded SpherePay KYC document for customer ${input.customerId ?? "?"}`
        : `Failed to upload SpherePay document`;
      break;
    case "doma_initiate_email_verification":
      line = (parsed as any)?.success !== false
        ? `Initiated DOMA email verification for ${input.email ?? "?"}`
        : `Failed to initiate DOMA email verification`;
      break;
    case "doma_create_listing":
      line = (parsed as any)?.listing_id ?? (parsed as any)?.id
        ? `Created DOMA listing for ${input.name ?? "?"} at ${input.price ?? "?"} ${input.currency ?? "USD"}`
        : `Failed to create DOMA listing`;
      break;
    case "doma_create_offer":
      line = (parsed as any)?.offer_id ?? (parsed as any)?.id
        ? `Created DOMA offer on ${input.name ?? "?"} for ${input.price ?? "?"} ${input.currency ?? "USD"}`
        : `Failed to create DOMA offer`;
      break;
    case "doma_create_bulk_listings":
      line = (parsed as any)?.listings ?? (parsed as any)?.success
        ? `Created bulk DOMA listings`
        : `Failed to create bulk DOMA listings`;
      break;
    case "doma_create_bulk_offers":
      line = (parsed as any)?.offers ?? (parsed as any)?.success
        ? `Created bulk DOMA offers`
        : `Failed to create bulk DOMA offers`;
      break;
    case "doma_cancel_listing":
      line = (parsed as any)?.success !== false
        ? `Cancelled DOMA listing ${input.listing_id ?? "?"}`
        : `Failed to cancel DOMA listing`;
      break;
    case "doma_cancel_offer":
      line = (parsed as any)?.success !== false
        ? `Cancelled DOMA offer ${input.offer_id ?? "?"}`
        : `Failed to cancel DOMA offer`;
      break;
    // SpherePay additional write ops
    case "spherepay_create_quote":
      line = (parsed as any)?.quoteId ?? (parsed as any)?.id
        ? `Created SpherePay quote — ${input.amount} ${input.fromCurrency}→${input.toCurrency ?? "?"}`
        : `Failed to create SpherePay quote`;
      break;
    case "spherepay_create_virtual_account":
      line = (parsed as any)?.id
        ? `Created SpherePay virtual account for customer ${input.customerId ?? "?"}`
        : `Failed to create SpherePay virtual account`;
      break;
    case "spherepay_create_offloader_wallet":
      line = (parsed as any)?.id
        ? `Created SpherePay offloader wallet for customer ${input.customerId ?? "?"}`
        : `Failed to create SpherePay offloader wallet`;
      break;
    case "spherepay_add_business_rep":
      line = (parsed as any)?.id
        ? `Added SpherePay business rep ${input.email ?? "?"} for customer ${input.customerId ?? "?"}`
        : `Failed to add SpherePay business rep`;
      break;
    case "spherepay_create_kyc_link":
      line = (parsed as any)?.link ?? (parsed as any)?.url
        ? `Generated SpherePay KYC link for customer ${input.customerId ?? "?"}`
        : `Failed to create SpherePay KYC link`;
      break;
    case "spherepay_update_customer":
      line = (parsed as any)?.id
        ? `Updated SpherePay customer ${input.customerId ?? "?"}`
        : `Failed to update SpherePay customer`;
      break;
    case "spherepay_delete_bank_account":
      line = (parsed as any)?.success !== false
        ? `Deleted SpherePay bank account ${input.bankAccountId ?? "?"}`
        : `Failed to delete SpherePay bank account`;
      break;
    case "spherepay_delete_wallet":
      line = (parsed as any)?.success !== false
        ? `Deleted SpherePay wallet ${input.walletId ?? "?"}`
        : `Failed to delete SpherePay wallet`;
      break;
    case "spherepay_deactivate_virtual_account":
      line = (parsed as any)?.success !== false
        ? `Deactivated SpherePay virtual account ${input.virtualAccountId ?? "?"}`
        : `Failed to deactivate SpherePay virtual account`;
      break;
    case "spherepay_delete_business_rep":
      line = (parsed as any)?.success !== false
        ? `Deleted SpherePay business rep ${input.repId ?? "?"}`
        : `Failed to delete SpherePay business rep`;
      break;
    case "spherepay_update_business_rep":
      line = (parsed as any)?.id
        ? `Updated SpherePay business rep ${input.repId ?? "?"}`
        : `Failed to update SpherePay business rep`;
      break;
    case "spherepay_update_bank_account":
      line = (parsed as any)?.id
        ? `Updated SpherePay bank account ${input.bankAccountId ?? "?"}`
        : `Failed to update SpherePay bank account`;
      break;
    case "spherepay_update_offloader_wallet":
      line = (parsed as any)?.id
        ? `Updated SpherePay offloader wallet ${input.walletId ?? "?"}`
        : `Failed to update SpherePay offloader wallet`;
      break;
    case "spherepay_update_quote_status":
      line = (parsed as any)?.id
        ? `Updated SpherePay quote ${input.quoteId ?? "?"} status → ${input.status ?? "?"}`
        : `Failed to update SpherePay quote status`;
      break;
    case "spherepay_update_virtual_account":
      line = (parsed as any)?.id
        ? `Updated SpherePay virtual account ${input.virtualAccountId ?? "?"}`
        : `Failed to update SpherePay virtual account`;
      break;
    // Fuze additional write ops
    case "fuze_update_user":
      line = (parsed as any)?.success !== false
        ? `Updated Fuze user ${input.orgUserId ?? "?"}`
        : `Failed to update Fuze user`;
      break;
    case "fuze_create_counterparty":
      line = (parsed as any)?.counterpartyId ?? (parsed as any)?.data?.counterpartyId
        ? `Created Fuze counterparty ${input.name ?? "?"} for user ${input.orgUserId ?? "?"}`
        : `Failed to create Fuze counterparty`;
      break;
    case "fuze_create_internal_wallet":
      line = (parsed as any)?.walletId ?? (parsed as any)?.data?.walletId
        ? `Created Fuze internal wallet for user ${input.orgUserId ?? "?"}`
        : `Failed to create Fuze internal wallet`;
      break;
    case "fuze_delete_external_wallet":
      line = (parsed as any)?.success !== false
        ? `Deleted Fuze external wallet ${input.walletId ?? "?"}`
        : `Failed to delete Fuze external wallet`;
      break;
    case "fuze_register_external_wallet":
      line = (parsed as any)?.walletId ?? (parsed as any)?.data?.walletId
        ? `Registered external wallet ${input.walletAddress ?? "?"} for Fuze user ${input.orgUserId ?? "?"}`
        : `Failed to register Fuze external wallet`;
      break;
    case "fuze_create_internal_account":
      line = (parsed as any)?.accountId ?? (parsed as any)?.data?.accountId
        ? `Created Fuze internal account (${input.currency ?? "?"}) for user ${input.orgUserId ?? "?"}`
        : `Failed to create Fuze internal account`;
      break;
    case "fuze_register_external_account":
      line = (parsed as any)?.accountId ?? (parsed as any)?.data?.accountId
        ? `Registered Fuze external bank account for user ${input.orgUserId ?? "?"}`
        : `Failed to register Fuze external account`;
      break;
    case "fuze_create_remittance_originator":
      line = (parsed as any)?.originatorId ?? (parsed as any)?.data?.originatorId
        ? `Created Fuze remittance originator ${input.name ?? "?"}`
        : `Failed to create Fuze remittance originator`;
      break;
    case "fuze_create_remittance_beneficiary":
      line = (parsed as any)?.beneficiaryId ?? (parsed as any)?.data?.beneficiaryId
        ? `Created Fuze remittance beneficiary ${input.name ?? "?"}`
        : `Failed to create Fuze remittance beneficiary`;
      break;
    case "fuze_create_remittance_originator_with_beneficiary":
      line = (parsed as any)?.paymentId ?? (parsed as any)?.data?.paymentId
        ? `Created Fuze remittance payment with originator+beneficiary`
        : `Failed to create Fuze remittance with originator+beneficiary`;
      break;
    case "fuze_create_remittance_payout_to_beneficiary":
      line = (parsed as any)?.payoutId ?? (parsed as any)?.data?.payoutId
        ? `Created Fuze remittance payout to beneficiary ${input.beneficiaryId ?? "?"}`
        : `Failed to create Fuze remittance payout to beneficiary`;
      break;
    case "fuze_update_edd":
      line = (parsed as any)?.success !== false
        ? `Updated Fuze EDD for user ${input.orgUserId ?? "?"}`
        : `Failed to update Fuze EDD`;
      break;
    case "fuze_upsert_kyc":
      line = (parsed as any)?.success !== false
        ? `Upserted Fuze KYC for user ${input.orgUserId ?? "?"}`
        : `Failed to upsert Fuze KYC`;
      break;
    // Flash additional write ops
    case "flash_migrate_to_sflp":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued migration of ${input.flpAmount} FLP → sFLP (auto-compounding)`
        : `Failed to queue FLP→sFLP migration`;
      break;
    case "flash_migrate_to_flp":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued migration of ${input.sflpAmount} sFLP → staked FLP`
        : `Failed to queue sFLP→FLP migration`;
      break;
    case "flash_collect_revenue":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash revenue collection in ${input.revenueTokenSymbol ?? "USDC"}`
        : `Failed to queue Flash revenue collection`;
      break;
    case "flash_collect_rebate":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash rebate collection`
        : `Failed to queue Flash rebate collection`;
      break;
    case "flash_collect_flp_reward":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued FLP staking reward collection`
        : `Failed to queue FLP reward collection`;
      break;
    case "flash_collect_stake_reward":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued FLASH staking reward collection`
        : `Failed to queue FLASH stake reward collection`;
      break;
    case "flash_cancel_unstake":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued Flash unstake cancellation`
        : `Failed to queue Flash unstake cancellation`;
      break;
    case "flash_edit_limit_order":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued limit order edit — market ${input.marketId}, new price $${input.newLimitPrice}`
        : `Failed to queue limit order edit`;
      break;
    case "flash_edit_trigger_order":
      line = (parsed as any)?.pendingFlashTx
        ? `Queued trigger order edit — market ${input.marketId}, new trigger $${input.newTriggerPrice}`
        : `Failed to queue trigger order edit`;
      break;
    // Fuze additional write ops
    case "fuze_delete_counterparty":
      line = (parsed as any)?.success !== false
        ? `Deleted Fuze counterparty ${input.counterpartyId ?? "?"}`
        : `Failed to delete Fuze counterparty`;
      break;
    case "fuze_cancel_order":
      line = (parsed as any)?.success !== false
        ? `Cancelled Fuze order ${input.orderId ?? "?"}`
        : `Failed to cancel Fuze order`;
      break;
    case "fuze_update_external_transfer":
      line = (parsed as any)?.transferId ?? (parsed as any)?.data?.transferId
        ? `Updated Fuze external transfer ${input.transferId ?? "?"}`
        : `Failed to update Fuze external transfer`;
      break;
    case "fuze_create_reversal":
      line = (parsed as any)?.reversalId ?? (parsed as any)?.data?.reversalId
        ? `Created Fuze reversal for transfer ${input.transferId ?? "?"}`
        : `Failed to create Fuze reversal`;
      break;
    case "fuze_upsert_webhook":
      line = (parsed as any)?.success !== false
        ? `Configured Fuze webhook for ${input.orgUserId ?? "?"}`
        : `Failed to configure Fuze webhook`;
      break;
    case "fuze_simulate_webhook":
      line = (parsed as any)?.success !== false
        ? `Simulated Fuze webhook event ${input.eventType ?? "?"}`
        : `Failed to simulate Fuze webhook`;
      break;
    case "fuze_create_watchlist":
      line = (parsed as any)?.watchlistId ?? (parsed as any)?.data?.watchlistId
        ? `Created Fuze watchlist for user ${input.orgUserId ?? "?"}`
        : `Failed to create Fuze watchlist`;
      break;
    case "fuze_update_watchlist":
      line = (parsed as any)?.success !== false
        ? `Updated Fuze watchlist ${input.watchlistId ?? "?"}`
        : `Failed to update Fuze watchlist`;
      break;
    case "fuze_delete_watchlist":
      line = (parsed as any)?.success !== false
        ? `Deleted Fuze watchlist ${input.watchlistId ?? "?"}`
        : `Failed to delete Fuze watchlist`;
      break;
    case "fuze_delete_user":
      line = (parsed as any)?.success !== false
        ? `Deleted Fuze user ${input.orgUserId ?? "?"}`
        : `Failed to delete Fuze user`;
      break;
    case "fuze_gateway_create_customer":
      line = (parsed as any)?.customerId ?? (parsed as any)?.id
        ? `Created Fuze Gateway customer ${input.email ?? input.externalId ?? "?"}`
        : `Failed to create Fuze Gateway customer`;
      break;
    case "fuze_gateway_update_customer_kyc":
      line = (parsed as any)?.success !== false
        ? `Updated Fuze Gateway KYC for customer ${input.customerId ?? "?"}`
        : `Failed to update Fuze Gateway KYC`;
      break;
    case "fuze_gateway_create_deposit_wallet":
      line = (parsed as any)?.walletAddress ?? (parsed as any)?.address
        ? `Created Fuze Gateway deposit wallet for customer ${input.customerId ?? "?"}`
        : `Failed to create Fuze Gateway deposit wallet`;
      break;
    case "fuze_gateway_create_payin_quote":
      line = (parsed as any)?.quoteId ?? (parsed as any)?.id
        ? `Created Fuze Gateway payin quote — ${input.sourceCurrency}→${input.destinationCurrency}`
        : `Failed to create Fuze Gateway payin quote`;
      break;
    case "fuze_gateway_create_payin":
      line = (parsed as any)?.payinId ?? (parsed as any)?.id
        ? `Initiated Fuze Gateway payin (quoteId: ${input.quoteId ?? "?"})`
        : `Failed to initiate Fuze Gateway payin`;
      break;
    case "fuze_gateway_create_payout_quote":
      line = (parsed as any)?.quoteId ?? (parsed as any)?.id
        ? `Created Fuze Gateway payout quote — ${input.sourceCurrency}→${input.destinationCurrency}`
        : `Failed to create Fuze Gateway payout quote`;
      break;
    case "fuze_gateway_create_payout":
      line = (parsed as any)?.payoutId ?? (parsed as any)?.id
        ? `Initiated Fuze Gateway payout (quoteId: ${input.quoteId ?? "?"})`
        : `Failed to initiate Fuze Gateway payout`;
      break;
    case "fuze_gateway_create_refund":
      line = (parsed as any)?.refundId ?? (parsed as any)?.id
        ? `Created Fuze Gateway refund for payin ${input.payinId ?? "?"}`
        : `Failed to create Fuze Gateway refund`;
      break;
    case "fuze_gateway_whitelist_wallet":
      line = (parsed as any)?.success !== false
        ? `Whitelisted wallet ${input.walletAddress ?? "?"} for Fuze Gateway customer ${input.customerId ?? "?"}`
        : `Failed to whitelist Fuze Gateway wallet`;
      break;
    case "x402_pay": {
      const success = (parsed as any)?.success === true;
      // receipt.network is the CAIP-2 actually used (from consume402 receipt)
      const receipt = (parsed as any)?.receipt as Record<string, unknown> | undefined;
      const net = receipt?.network ?? (parsed as any)?.network ?? input.preferred_network ?? "unknown network";
      const netLabel = String(net).startsWith("eip155:") ? `EVM (${net})` : String(net).startsWith("solana:") ? `Solana (${net})` : net;
      const paidUsdc = receipt?.amountUSDC ?? (parsed as any)?.paid_usdc;
      const paidLabel = paidUsdc != null && Number(paidUsdc) > 0 ? ` — $${Number(paidUsdc).toFixed(6)} USDC` : "";
      const retried = receipt?.retried ? " (retried)" : "";
      const errCode = (parsed as any)?.error;
      line = success
        ? `Paid x402 resource via ${netLabel}${paidLabel}${retried}: ${input.url}`
        : errCode === "spend_limit_exceeded"
          ? `x402 payment blocked — offer exceeds $${input.max_amount_usdc ?? 0.002} cap: ${input.url}`
          : `x402 payment failed on ${netLabel} for: ${input.url}`;
      break;
    }
    default:
      return "";
  }

  if (failed && !cancelled) {
    line += ` (failed: ${String(parsed.error || "unknown error").slice(0, 100)})`;
  }

  return `- Action: ${line}`;
}

/**
 * Extracts a structured recap from older messages.
 * Preserves action tool results and user/assistant text.
 */
function extractRecap(older: UIMessage[]): string {
  const facts: string[] = [];

  for (const msg of older) {
    if (msg.id === "welcome") continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const parts = (msg.parts || []) as (ToolPart & { text?: string })[];

    // Single pass: collect action facts and text parts
    let hasAction = false;
    const texts: string[] = [];

    for (const p of parts) {
      if (p.type?.startsWith("tool-")) {
        const toolName = p.type.slice(5);
        if (ACTION_TOOLS.has(toolName) && p.state === "output-available") {
          const fact = formatActionFact(toolName, p.input || {}, p.output);
          if (fact) { facts.push(fact); hasAction = true; }
        }
      } else if (p.type === "text" && p.text) {
        texts.push(p.text);
      }
    }

    // Skip text extraction if message already contributed action facts
    if (hasAction) continue;

    const text = texts.join(" ");
    if (!text.trim()) continue;

    if (msg.role === "user") {
      facts.push(`- User asked: ${text.slice(0, 500)}`);
    } else {
      facts.push(`- Assistant: ${text.slice(0, 300)}`);
    }
  }

  if (facts.length === 0) return "";

  // Cap at MAX_RECAP_LINES, keeping the most recent facts
  const capped = facts.length > MAX_RECAP_LINES
    ? facts.slice(-MAX_RECAP_LINES)
    : facts;

  return [`Recap of ${older.length} earlier messages:`, ...capped].join("\n");
}

/**
 * Returns a conversation recap string for older messages.
 * Empty string if no windowing is needed.
 */
export function extractConversationRecap(messages: UIMessage[]): string {
  if (messages.length <= RECENT_WINDOW) return "";
  const older = messages.slice(0, messages.length - RECENT_WINDOW);
  return extractRecap(older);
}

/**
 * Windows a message array — returns only the recent window.
 * The recap is handled separately via extractConversationRecap → system prompt.
 */
export function windowMessages(messages: UIMessage[]): UIMessage[] {
  if (messages.length <= RECENT_WINDOW) return messages;
  return messages.slice(-RECENT_WINDOW);
}
