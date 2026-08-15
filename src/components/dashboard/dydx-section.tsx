"use client";

import { useState } from "react";

type FieldDef = {
  name: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  kind?: "text" | "select";
  options?: string[];
};

type Operation = {
  id: string;
  group: "Markets" | "Account" | "Orders" | "History" | "Vault" | "Chain";
  label: string;
  description: string;
  fields: FieldDef[];
  submitLabel?: string;
  buildPayload: (f: Record<string, string>) => Record<string, unknown>;
};

const t = (name: string, label: string, placeholder?: string, required = true): FieldDef => ({ name, label, placeholder, required });
const o = (name: string, label: string, placeholder?: string): FieldDef => ({ name, label, placeholder, required: false });
const sel = (name: string, label: string, options: string[], required = false): FieldDef => ({ name, label, options, required, kind: "select" });

function compact(p: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== ""));
}

const OPERATIONS: Operation[] = [
  // ── Markets ──────────────────────────────────────────────────────────────────
  {
    id: "listPerpetualMarkets",
    group: "Markets",
    label: "List all markets",
    description: "All active perpetual markets with oracle price, 24h volume, open interest, and funding rate.",
    fields: [],
    submitLabel: "Load markets",
    buildPayload: () => ({}),
  },
  {
    id: "getPerpetualMarket",
    group: "Markets",
    label: "Get market details",
    description: "Full details for a single perpetual market.",
    fields: [t("ticker", "Ticker", "e.g. BTC-USD")],
    buildPayload: (f) => ({ ticker: f.ticker }),
  },
  {
    id: "getOrderbook",
    group: "Markets",
    label: "Orderbook",
    description: "Current bids and asks for a market.",
    fields: [t("ticker", "Ticker", "e.g. ETH-USD")],
    buildPayload: (f) => ({ ticker: f.ticker }),
  },
  {
    id: "getCandles",
    group: "Markets",
    label: "Candlestick data",
    description: "OHLCV price candles for charting.",
    fields: [
      t("ticker", "Ticker", "e.g. BTC-USD"),
      sel("resolution", "Resolution", ["1MIN", "5MINS", "15MINS", "30MINS", "1HOUR", "4HOURS", "1DAY"], true),
      o("limit", "Limit", "100"),
      o("fromISO", "From (ISO)", "2024-01-01T00:00:00Z"),
      o("toISO", "To (ISO)", "2024-12-31T00:00:00Z"),
    ],
    buildPayload: (f) => compact({ ticker: f.ticker, resolution: f.resolution, limit: f.limit, fromISO: f.fromISO, toISO: f.toISO }),
  },
  {
    id: "getMarketTrades",
    group: "Markets",
    label: "Recent trades",
    description: "Most recent trades executed on a market.",
    fields: [t("ticker", "Ticker", "e.g. SOL-USD"), o("limit", "Limit", "50")],
    buildPayload: (f) => compact({ ticker: f.ticker, limit: f.limit }),
  },
  {
    id: "getMarketStats",
    group: "Markets",
    label: "Market stats",
    description: "24h stats: volume, number of trades, open interest.",
    fields: [t("ticker", "Ticker", "e.g. BTC-USD"), o("days", "Days", "1")],
    buildPayload: (f) => compact({ ticker: f.ticker, days: f.days }),
  },
  {
    id: "getHistoricalFunding",
    group: "Markets",
    label: "Historical funding rates",
    description: "Per-hour historical funding rates for a market.",
    fields: [
      t("ticker", "Ticker", "e.g. BTC-USD"),
      o("limit", "Limit", "48"),
      o("effectiveBeforeOrAt", "Before (ISO)", "2025-01-01T00:00:00Z"),
    ],
    buildPayload: (f) => compact({ ticker: f.ticker, limit: f.limit, effectiveBeforeOrAt: f.effectiveBeforeOrAt }),
  },
  {
    id: "getSparklines",
    group: "Markets",
    label: "Market sparklines",
    description: "Mini price series for all perpetual markets over 1 day or 7 days.",
    fields: [sel("timePeriod", "Period", ["ONE_DAY", "SEVEN_DAYS"])],
    submitLabel: "Load sparklines",
    buildPayload: (f) => compact({ timePeriod: f.timePeriod }),
  },

  // ── Account ───────────────────────────────────────────────────────────────────
  {
    id: "getAccount",
    group: "Account",
    label: "Get account",
    description: "dYdX account info and all subaccounts for an address.",
    fields: [t("address", "dYdX address", "dydx1...")],
    buildPayload: (f) => ({ address: f.address }),
  },
  {
    id: "getSubaccount",
    group: "Account",
    label: "Get subaccount",
    description: "Equity, USDC balance, and positions in a specific subaccount.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0" }),
  },
  {
    id: "getPerpetualPositions",
    group: "Account",
    label: "Perpetual positions",
    description: "Open or closed perp positions for a subaccount.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
      sel("status", "Status filter", ["OPEN", "CLOSED", "LIQUIDATED"]),
      o("ticker", "Ticker filter", "e.g. BTC-USD"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0", status: f.status, ticker: f.ticker }),
  },
  {
    id: "getAssetPositions",
    group: "Account",
    label: "Asset positions (USDC)",
    description: "USDC and other collateral asset balances in a subaccount.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0" }),
  },

  // ── Account (parent subaccount) ──────────────────────────────────────────────
  {
    id: "getParentSubaccount",
    group: "Account",
    label: "Parent subaccount",
    description: "Cross-margin aggregate view: equity, free collateral, and all child subaccounts rolled up.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("parentSubaccountNumber", "Parent subacct #", "0"),
    ],
    buildPayload: (f) => compact({ address: f.address, parentSubaccountNumber: f.parentSubaccountNumber || "0" }),
  },
  {
    id: "getPerpetualPositionsParent",
    group: "Account",
    label: "Positions (parent subacct)",
    description: "All perpetual positions rolled up across child subaccounts under a parent.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("parentSubaccountNumber", "Parent subacct #", "0"),
      sel("status", "Status", ["OPEN", "CLOSED", "LIQUIDATED"]),
      o("ticker", "Ticker filter", "BTC-USD"),
    ],
    buildPayload: (f) => compact({ address: f.address, parentSubaccountNumber: f.parentSubaccountNumber || "0", status: f.status, ticker: f.ticker }),
  },
  {
    id: "getAssetPositionsParent",
    group: "Account",
    label: "Asset positions (parent subacct)",
    description: "USDC collateral balances aggregated across all child subaccounts.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("parentSubaccountNumber", "Parent subacct #", "0"),
    ],
    buildPayload: (f) => compact({ address: f.address, parentSubaccountNumber: f.parentSubaccountNumber || "0" }),
  },

  // ── Orders ────────────────────────────────────────────────────────────────────
  {
    id: "getOrders",
    group: "Orders",
    label: "List orders",
    description: "Open or historical orders for a subaccount.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
      sel("status", "Status", ["OPEN", "FILLED", "CANCELED", "BEST_EFFORT_OPENED", "BEST_EFFORT_CANCELED"]),
      o("ticker", "Ticker filter", "BTC-USD"),
      sel("side", "Side", ["BUY", "SELL"]),
      o("limit", "Limit", "20"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0", status: f.status, ticker: f.ticker, side: f.side, limit: f.limit }),
  },
  {
    id: "getOrder",
    group: "Orders",
    label: "Get order by ID",
    description: "Full details for a specific order by its dYdX order ID.",
    fields: [t("orderId", "Order ID", "order ID string")],
    buildPayload: (f) => ({ orderId: f.orderId }),
  },
  {
    id: "getFills",
    group: "Orders",
    label: "Fill history",
    description: "Executed fills (matched trades) for a subaccount.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
      o("ticker", "Ticker filter", "BTC-USD"),
      o("limit", "Limit", "20"),
      o("createdBeforeOrAt", "Before (ISO)", "2025-01-01T00:00:00Z"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0", ticker: f.ticker, limit: f.limit, createdBeforeOrAt: f.createdBeforeOrAt }),
  },

  {
    id: "getOrdersParent",
    group: "Orders",
    label: "Orders (parent subacct)",
    description: "All orders across child subaccounts under a parent — open, filled, or cancelled.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("parentSubaccountNumber", "Parent subacct #", "0"),
      sel("status", "Status", ["OPEN", "FILLED", "CANCELED"]),
      o("ticker", "Ticker filter", "BTC-USD"),
      sel("side", "Side", ["BUY", "SELL"]),
      o("limit", "Limit", "20"),
    ],
    buildPayload: (f) => compact({ address: f.address, parentSubaccountNumber: f.parentSubaccountNumber || "0", status: f.status, ticker: f.ticker, side: f.side, limit: f.limit }),
  },
  {
    id: "getTradeHistory",
    group: "Orders",
    label: "Trade history",
    description: "Position-level trade history: open/close actions with entry price, exit price, and P&L per trade.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
      o("ticker", "Ticker filter", "BTC-USD"),
      o("limit", "Limit", "20"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0", ticker: f.ticker, limit: f.limit }),
  },
  {
    id: "getTradeHistoryParent",
    group: "Orders",
    label: "Trade history (parent subacct)",
    description: "Aggregated position-level trade history across all child subaccounts.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("parentSubaccountNumber", "Parent subacct #", "0"),
      o("ticker", "Ticker filter", "BTC-USD"),
      o("limit", "Limit", "20"),
    ],
    buildPayload: (f) => compact({ address: f.address, parentSubaccountNumber: f.parentSubaccountNumber || "0", ticker: f.ticker, limit: f.limit }),
  },

  // ── History ───────────────────────────────────────────────────────────────────
  {
    id: "getTransfers",
    group: "History",
    label: "Transfer history",
    description: "Deposits, withdrawals, and internal transfers for a subaccount.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
      o("limit", "Limit", "20"),
      o("createdBeforeOrAt", "Before (ISO)", "2025-01-01T00:00:00Z"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0", limit: f.limit, createdBeforeOrAt: f.createdBeforeOrAt }),
  },
  {
    id: "getHistoricalPnl",
    group: "History",
    label: "Historical P&L",
    description: "Equity-curve snapshots over time for a subaccount.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
      o("limit", "Limit", "50"),
      o("createdBeforeOrAt", "Before (ISO)", "2025-01-01T00:00:00Z"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0", limit: f.limit, createdBeforeOrAt: f.createdBeforeOrAt }),
  },
  {
    id: "getFundingPayments",
    group: "History",
    label: "Funding payments",
    description: "Funding rate payments received or paid for perpetual positions.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
      o("ticker", "Ticker filter", "BTC-USD"),
      o("limit", "Limit", "20"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0", ticker: f.ticker, limit: f.limit }),
  },
  {
    id: "getTransfersParent",
    group: "History",
    label: "Transfers (parent subacct)",
    description: "Deposits, withdrawals, and internal transfers aggregated across child subaccounts.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("parentSubaccountNumber", "Parent subacct #", "0"),
      o("limit", "Limit", "20"),
    ],
    buildPayload: (f) => compact({ address: f.address, parentSubaccountNumber: f.parentSubaccountNumber || "0", limit: f.limit }),
  },
  {
    id: "getTransfersBetween",
    group: "History",
    label: "Transfers between addresses",
    description: "All transfers between two specific subaccounts and their net total.",
    fields: [
      t("sourceAddress", "Source address", "dydx1..."),
      o("sourceSubaccountNumber", "Source subacct #", "0"),
      t("recipientAddress", "Recipient address", "dydx1..."),
      o("recipientSubaccountNumber", "Recipient subacct #", "0"),
    ],
    buildPayload: (f) => compact({ sourceAddress: f.sourceAddress, sourceSubaccountNumber: f.sourceSubaccountNumber || "0", recipientAddress: f.recipientAddress, recipientSubaccountNumber: f.recipientSubaccountNumber || "0" }),
  },
  {
    id: "getPnl",
    group: "History",
    label: "Hourly P&L snapshots",
    description: "Hourly-bucketed equity and P&L snapshots (different granularity from historical P&L).",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("subaccountNumber", "Subaccount #", "0"),
      o("limit", "Limit", "48"),
    ],
    buildPayload: (f) => compact({ address: f.address, subaccountNumber: f.subaccountNumber || "0", limit: f.limit }),
  },
  {
    id: "getPnlParent",
    group: "History",
    label: "Hourly P&L (parent subacct)",
    description: "Hourly-bucketed P&L aggregated across all child subaccounts.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("parentSubaccountNumber", "Parent subacct #", "0"),
      o("limit", "Limit", "48"),
    ],
    buildPayload: (f) => compact({ address: f.address, parentSubaccountNumber: f.parentSubaccountNumber || "0", limit: f.limit }),
  },
  {
    id: "getHistoricalPnlParent",
    group: "History",
    label: "Historical P&L (parent subacct)",
    description: "Equity-curve snapshots aggregated across all child subaccounts.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("parentSubaccountNumber", "Parent subacct #", "0"),
      o("limit", "Limit", "50"),
    ],
    buildPayload: (f) => compact({ address: f.address, parentSubaccountNumber: f.parentSubaccountNumber || "0", limit: f.limit }),
  },
  {
    id: "getFundingPaymentsParent",
    group: "History",
    label: "Funding payments (parent subacct)",
    description: "Funding rate payments aggregated across all child subaccounts.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("parentSubaccountNumber", "Parent subacct #", "0"),
      o("ticker", "Ticker filter", "BTC-USD"),
      o("limit", "Limit", "20"),
    ],
    buildPayload: (f) => compact({ address: f.address, parentSubaccountNumber: f.parentSubaccountNumber || "0", ticker: f.ticker, limit: f.limit }),
  },
  {
    id: "getHistoricalBlockTradingRewards",
    group: "History",
    label: "Block trading rewards",
    description: "Historical DYDX trading reward grants per block for an address.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("limit", "Limit", "20"),
      o("startingBeforeOrAt", "Before (ISO)", "2025-01-01T00:00:00Z"),
    ],
    buildPayload: (f) => compact({ address: f.address, limit: f.limit, startingBeforeOrAt: f.startingBeforeOrAt }),
  },
  {
    id: "getHistoricalTradingRewardAggregations",
    group: "History",
    label: "Reward aggregations",
    description: "Paginated historical aggregated DYDX trading rewards by period.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      sel("period", "Period", ["DAILY", "WEEKLY", "MONTHLY"], true),
      o("limit", "Limit", "20"),
      o("startingBeforeOrAt", "Before (ISO)", "2025-01-01T00:00:00Z"),
    ],
    buildPayload: (f) => compact({ address: f.address, period: f.period, limit: f.limit, startingBeforeOrAt: f.startingBeforeOrAt }),
  },

  // ── Vault ─────────────────────────────────────────────────────────────────────
  {
    id: "getMegavaultPositions",
    group: "Vault",
    label: "Megavault positions",
    description: "Current dYdX Megavault open positions across all markets.",
    fields: [],
    submitLabel: "Load vault positions",
    buildPayload: () => ({}),
  },
  {
    id: "getMegavaultHistoricalPnl",
    group: "Vault",
    label: "Megavault P&L history",
    description: "Historical P&L snapshots for the dYdX Megavault.",
    fields: [
      sel("resolution", "Resolution", ["day", "hour"]),
      o("limit", "Limit", "50"),
    ],
    buildPayload: (f) => compact({ resolution: f.resolution, limit: f.limit }),
  },
  {
    id: "getMegavaultOwnerShares",
    group: "Vault",
    label: "My Megavault shares",
    description: "Current Megavault share balance for an address.",
    fields: [t("address", "dYdX address", "dydx1...")],
    buildPayload: (f) => ({ address: f.address }),
  },
  {
    id: "getMegavaultHistoricalOwnerShares",
    group: "Vault",
    label: "Megavault shares history",
    description: "Historical Megavault share snapshots for an address.",
    fields: [
      t("address", "dYdX address", "dydx1..."),
      o("limit", "Limit", "20"),
      o("createdBeforeOrAt", "Before (ISO)", "2025-01-01T00:00:00Z"),
    ],
    buildPayload: (f) => compact({ address: f.address, limit: f.limit, createdBeforeOrAt: f.createdBeforeOrAt }),
  },
  {
    id: "getVaultPositions",
    group: "Vault",
    label: "All vault positions",
    description: "Positions for every individual vault contributing to the Megavault.",
    fields: [],
    submitLabel: "Load all vaults",
    buildPayload: () => ({}),
  },
  {
    id: "getVaultsHistoricalPnl",
    group: "Vault",
    label: "Per-vault historical P&L",
    description: "Historical P&L snapshots broken down per individual vault market.",
    fields: [
      sel("resolution", "Resolution", ["day", "hour"]),
      o("limit", "Limit", "50"),
    ],
    buildPayload: (f) => compact({ resolution: f.resolution, limit: f.limit }),
  },

  // ── Chain ─────────────────────────────────────────────────────────────────────
  {
    id: "getBlockHeight",
    group: "Chain",
    label: "Block height",
    description: "Latest dYdX Chain block number and timestamp.",
    fields: [],
    submitLabel: "Fetch height",
    buildPayload: () => ({}),
  },
  {
    id: "getServerTime",
    group: "Chain",
    label: "Server time",
    description: "Indexer server time as ISO string and Unix epoch.",
    fields: [],
    submitLabel: "Fetch time",
    buildPayload: () => ({}),
  },
  {
    id: "screenAddress",
    group: "Chain",
    label: "Quick restriction check",
    description: "Returns restricted: true/false — whether an address is geo/compliance blocked.",
    fields: [t("address", "dYdX address", "dydx1...")],
    submitLabel: "Check",
    buildPayload: (f) => ({ address: f.address }),
  },
  {
    id: "getComplianceScreen",
    group: "Chain",
    label: "Full compliance screen",
    description: "Full compliance status: COMPLIANT / BLOCKED with reason and timestamp.",
    fields: [t("address", "dYdX address", "dydx1...")],
    submitLabel: "Screen",
    buildPayload: (f) => ({ address: f.address }),
  },
  {
    id: "searchTrader",
    group: "Chain",
    label: "Search trader",
    description: "Look up a trader by dYdX address or username — returns address, subaccountId, and username.",
    fields: [t("searchParam", "Address or username", "dydx1... or username")],
    submitLabel: "Search",
    buildPayload: (f) => ({ searchParam: f.searchParam }),
  },

  // ── Affiliates ──────────────────────────────────────────────────────────────
  {
    id: "getAffiliateMetadata",
    group: "Chain",
    label: "Affiliate metadata",
    description: "Referral code, volume eligibility, and affiliate status for an address.",
    fields: [t("address", "dYdX address", "dydx1...")],
    buildPayload: (f) => ({ address: f.address }),
  },
  {
    id: "getAffiliateAddressByReferralCode",
    group: "Chain",
    label: "Lookup by referral code",
    description: "Resolve a referral code to the affiliate's dYdX address.",
    fields: [t("referralCode", "Referral code", "e.g. RapidSpy0CK")],
    buildPayload: (f) => ({ referralCode: f.referralCode }),
  },
  {
    id: "getAffiliatesSnapshot",
    group: "Chain",
    label: "Affiliates leaderboard",
    description: "Paginated leaderboard of top affiliates sorted by earnings or referred volume.",
    fields: [
      o("limit", "Limit", "20"),
      o("offset", "Offset", "0"),
      sel("sortByAffiliateEarning", "Sort by", ["true", "false"]),
    ],
    submitLabel: "Load leaderboard",
    buildPayload: (f) => compact({ limit: f.limit, offset: f.offset, sortByAffiliateEarning: f.sortByAffiliateEarning === "true" ? true : f.sortByAffiliateEarning === "false" ? false : undefined }),
  },
];

const GROUPS = ["Markets", "Account", "Orders", "History", "Vault", "Chain"] as const;
type Group = typeof GROUPS[number];

function JsonDisplay({ data }: { data: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-xl bg-[#0D0E0C] p-3 text-xs text-[#8FAE82] whitespace-pre-wrap break-words">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

export function DydxSection() {
  const [group, setGroup] = useState<Group>("Markets");
  const [selected, setSelected] = useState<Operation>(OPERATIONS.filter((o) => o.group === "Markets")[0]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const ops = OPERATIONS.filter((op) => op.group === group);

  function selectOp(op: Operation) {
    setSelected(op);
    setForm({});
    setResult(null);
    setError(null);
  }

  function selectGroup(g: Group) {
    setGroup(g);
    const first = OPERATIONS.find((op) => op.group === g);
    if (first) selectOp(first);
  }

  async function run() {
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const payload = selected.buildPayload(form);
      const res = await fetch("/api/dydx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: selected.id, ...payload }),
      });
      const json = await res.json();
      if (json.error) setError(json.error);
      else setResult(json.result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center gap-3 pb-1">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#1A1B2E] text-lg shrink-0">
          ⚡
        </div>
        <div>
          <p className="font-semibold text-[#F2F0E8]">dYdX Chain v4</p>
          <p className="text-xs text-[#A7A79A]">Decentralized perpetuals — Cosmos appchain</p>
        </div>
      </div>

      {/* Info pills */}
      <div className="flex flex-wrap gap-2 text-xs">
        {[
          { label: "100× leverage", color: "text-purple-400 bg-purple-400/10" },
          { label: "Cosmos L1", color: "text-blue-400 bg-blue-400/10" },
          { label: "No gas fees", color: "text-teal-400 bg-teal-400/10" },
          { label: "BTC · ETH · SOL · 100+ markets", color: "text-[#A7A79A] bg-white/[0.06]" },
        ].map((p) => (
          <span key={p.label} className={`rounded-full px-2 py-0.5 font-medium ${p.color}`}>
            {p.label}
          </span>
        ))}
      </div>

      {/* Group tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
        {GROUPS.map((g) => (
          <button
            key={g}
            onClick={() => selectGroup(g)}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              group === g ? "bg-[#F2F0E8] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A] hover:text-[#F2F0E8]"
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      {/* Operation list */}
      <div className="flex flex-col gap-1.5">
        {ops.map((op) => (
          <button
            key={op.id}
            onClick={() => selectOp(op)}
            className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
              selected.id === op.id
                ? "border-[#8FAE82]/40 bg-[#8FAE82]/10"
                : "border-[#2A2B27] bg-[#1B1C19] hover:border-[#3A3B37]"
            }`}
          >
            <p className={`text-sm font-medium ${selected.id === op.id ? "text-[#8FAE82]" : "text-[#F2F0E8]"}`}>
              {op.label}
            </p>
            <p className="text-xs text-[#A7A79A] mt-0.5">{op.description}</p>
          </button>
        ))}
      </div>

      {/* Form */}
      {selected.fields.length > 0 && (
        <div className="flex flex-col gap-2">
          {selected.fields.map((field) => (
            <div key={field.name}>
              <label className="mb-1 block text-xs font-medium text-[#A7A79A]">
                {field.label}{field.required && <span className="ml-0.5 text-red-400">*</span>}
              </label>
              {field.kind === "select" ? (
                <select
                  value={form[field.name] ?? ""}
                  onChange={(e) => setForm((prev) => ({ ...prev, [field.name]: e.target.value }))}
                  className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]/50"
                >
                  <option value="">— any —</option>
                  {field.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  value={form[field.name] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(e) => setForm((prev) => ({ ...prev, [field.name]: e.target.value }))}
                  className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] placeholder-[#5A5A4E] outline-none focus:border-[#8FAE82]/50"
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Run button */}
      <button
        onClick={run}
        disabled={loading}
        className="flex items-center justify-center gap-2 rounded-xl bg-[#1A1B2E] py-2.5 text-sm font-semibold text-purple-300 transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {loading ? (
          <span className="flex items-center gap-2">
            <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"/>
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
            </svg>
            Fetching…
          </span>
        ) : (
          selected.submitLabel ?? "Run query"
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Result */}
      {result !== null && <JsonDisplay data={result} />}

      {/* Footer note */}
      <p className="text-center text-xs text-[#5A5A4E]">
        Data from dYdX Indexer · To trade, visit dydx.trade and connect your wallet
      </p>
    </div>
  );
}
