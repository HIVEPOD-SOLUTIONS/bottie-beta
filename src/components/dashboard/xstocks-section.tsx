"use client";

import { useState } from "react";

type FieldKind = "text" | "number" | "textarea" | "select";

type FieldDef = {
  name: string;
  label: string;
  placeholder?: string;
  kind?: FieldKind;
  options?: string[];
  required?: boolean;
};

type Operation = {
  id: string;
  group: "Public" | "Client" | "xChange" | "Market" | "Bridges";
  label: string;
  description: string;
  fields: FieldDef[];
  submitLabel?: string;
  buildPayload: (form: Record<string, string>) => Record<string, unknown>;
};

const text = (name: string, label: string, placeholder?: string, required = true): FieldDef => ({
  name, label, placeholder, required,
});

const opt = (name: string, label: string, placeholder?: string): FieldDef => ({
  name, label, placeholder, required: false,
});

const selectField = (name: string, label: string, options: string[], required = true): FieldDef => ({
  name, label, options, required, kind: "select",
});

function compact(p: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== ""));
}

const OPERATIONS: Operation[] = [
  // ── Public ──────────────────────────────────────────────────────────────────
  {
    id: "listAssets",
    group: "Public",
    label: "List all assets",
    description: "All tokenized stocks available on xStocks with metadata.",
    fields: [],
    submitLabel: "Load assets",
    buildPayload: () => ({}),
  },
  {
    id: "getAsset",
    group: "Public",
    label: "Get asset",
    description: "Full details for a single tokenized stock by symbol.",
    fields: [text("symbol", "Symbol", "e.g. AAPL")],
    buildPayload: (f) => ({ symbol: f.symbol }),
  },
  {
    id: "getAssetPriceData",
    group: "Public",
    label: "Price history",
    description: "OHLCV price data for a tokenized stock.",
    fields: [
      text("symbol", "Symbol", "e.g. TSLA"),
      opt("from", "From (ISO date)", "2024-01-01"),
      opt("to", "To (ISO date)", "2024-12-31"),
      opt("interval", "Interval", "1d"),
    ],
    buildPayload: (f) => compact({ symbol: f.symbol, from: f.from, to: f.to, interval: f.interval }),
  },
  {
    id: "getAssetMultiplier",
    group: "Public",
    label: "Asset multiplier",
    description: "Current multiplier (stock-split ratio) for a token.",
    fields: [text("symbol", "Symbol", "e.g. NVDA")],
    buildPayload: (f) => ({ symbol: f.symbol }),
  },
  {
    id: "getAssetMultiplierHistory",
    group: "Public",
    label: "Multiplier history",
    description: "Historical multiplier changes (splits/reverse-splits).",
    fields: [
      text("symbol", "Symbol", "e.g. NVDA"),
      opt("from", "From (ISO date)", "2024-01-01"),
      opt("to", "To (ISO date)", "2024-12-31"),
    ],
    buildPayload: (f) => compact({ symbol: f.symbol, from: f.from, to: f.to }),
  },
  {
    id: "getAssetCirculatingSupply",
    group: "Public",
    label: "Circulating supply",
    description: "Number of tokens currently circulating for a stock.",
    fields: [text("symbol", "Symbol", "e.g. MSFT")],
    buildPayload: (f) => ({ symbol: f.symbol }),
  },
  {
    id: "getAssetTotalSupply",
    group: "Public",
    label: "Total supply",
    description: "Total token supply ever minted for a stock.",
    fields: [text("symbol", "Symbol", "e.g. MSFT")],
    buildPayload: (f) => ({ symbol: f.symbol }),
  },
  {
    id: "listProofOfReserves",
    group: "Public",
    label: "Proof of reserves",
    description: "All stock reserve attestation reports.",
    fields: [],
    submitLabel: "Load reserves",
    buildPayload: () => ({}),
  },
  {
    id: "getProofOfReserves",
    group: "Public",
    label: "Proof of reserves (symbol)",
    description: "Reserve attestation for a specific stock.",
    fields: [text("symbol", "Symbol", "e.g. AAPL")],
    buildPayload: (f) => ({ symbol: f.symbol }),
  },
  {
    id: "listOracles",
    group: "Public",
    label: "List oracles",
    description: "All on-chain price oracle addresses and networks.",
    fields: [],
    submitLabel: "Load oracles",
    buildPayload: () => ({}),
  },
  {
    id: "getOracle",
    group: "Public",
    label: "Get oracle",
    description: "Oracle details for a specific stock.",
    fields: [text("symbol", "Symbol", "e.g. GOOG")],
    buildPayload: (f) => ({ symbol: f.symbol }),
  },
  {
    id: "getSystemStatus",
    group: "Public",
    label: "System status",
    description: "Mint/redeem operational status for a stock.",
    fields: [text("symbol", "Symbol", "e.g. AAPL")],
    buildPayload: (f) => ({ symbol: f.symbol }),
  },
  {
    id: "getSystemWallets",
    group: "Public",
    label: "System wallets",
    description: "Public treasury and fee wallets used by xStocks.",
    fields: [],
    submitLabel: "Load wallets",
    buildPayload: () => ({}),
  },
  {
    id: "getCorporateActionsHistory",
    group: "Public",
    label: "Corporate actions — history",
    description: "Past stock splits, mergers, dividends.",
    fields: [
      opt("symbol", "Symbol (optional)", "e.g. TSLA"),
      opt("from", "From (ISO date)", "2024-01-01"),
      opt("to", "To (ISO date)", "2024-12-31"),
    ],
    buildPayload: (f) => compact({ symbol: f.symbol, from: f.from, to: f.to }),
  },
  {
    id: "getCorporateActionsUpcoming",
    group: "Public",
    label: "Corporate actions — upcoming",
    description: "Scheduled future stock events.",
    fields: [opt("symbol", "Symbol (optional)", "e.g. TSLA")],
    buildPayload: (f) => compact({ symbol: f.symbol }),
  },
  {
    id: "listPublicBridges",
    group: "Public",
    label: "Public bridges",
    description: "Supported blockchain bridge endpoints for xStock tokens.",
    fields: [],
    submitLabel: "Load bridges",
    buildPayload: () => ({}),
  },
  // ── Client ───────────────────────────────────────────────────────────────────
  {
    id: "getRegisteredWallets",
    group: "Client",
    label: "Registered wallets",
    description: "Whitelisted wallets for your API key.",
    fields: [],
    submitLabel: "Load wallets",
    buildPayload: () => ({}),
  },
  {
    id: "getClientLimits",
    group: "Client",
    label: "Client limits",
    description: "Trading and wallet limits for your account.",
    fields: [],
    submitLabel: "Load limits",
    buildPayload: () => ({}),
  },
  {
    id: "getClientUsage",
    group: "Client",
    label: "Client usage",
    description: "Current usage vs limits for your account.",
    fields: [],
    submitLabel: "Load usage",
    buildPayload: () => ({}),
  },
  {
    id: "createWhitelistChallenge",
    group: "Client",
    label: "Whitelist challenge (step 1)",
    description: "Request a signing challenge to whitelist a new wallet — sign the returned message then submit in step 2.",
    fields: [
      text("walletAddress", "Wallet address", "0x…"),
      text("chain", "Chain", "e.g. ethereum"),
    ],
    buildPayload: (f) => ({ walletAddress: f.walletAddress, chain: f.chain }),
  },
  {
    id: "submitWhitelist",
    group: "Client",
    label: "Submit whitelist (step 2)",
    description: "Complete wallet whitelisting by submitting the signed challenge from step 1.",
    fields: [
      text("walletAddress", "Wallet address", "0x…"),
      text("chain", "Chain", "e.g. ethereum"),
      text("challenge", "Challenge", "from step 1 response"),
      text("signature", "Signature", "signed challenge hex"),
    ],
    buildPayload: (f) => ({ walletAddress: f.walletAddress, chain: f.chain, challenge: f.challenge, signature: f.signature }),
  },
  // ── xChange ──────────────────────────────────────────────────────────────────
  {
    id: "listXchangeAssets",
    group: "xChange",
    label: "xChange assets",
    description: "Assets available for xChange RFQ trading.",
    fields: [],
    submitLabel: "Load assets",
    buildPayload: () => ({}),
  },
  {
    id: "getXchangeAsset",
    group: "xChange",
    label: "xChange asset detail",
    description: "Trading details for a specific xChange asset.",
    fields: [text("identifier", "Identifier", "e.g. AAPL or asset ID")],
    buildPayload: (f) => ({ identifier: f.identifier }),
  },
  {
    id: "createXchangeRfqSoft",
    group: "xChange",
    label: "Soft RFQ (indicative quote)",
    description: "Get an indicative price without locking in a trade.",
    fields: [
      text("symbol", "Symbol", "e.g. AAPL"),
      selectField("side", "Side", ["buy", "sell"]),
      opt("quantity", "Quantity (tokens)", "e.g. 10"),
      opt("notional", "Notional (USD)", "e.g. 1000"),
    ],
    buildPayload: (f) =>
      compact({ symbol: f.symbol, side: f.side, quantity: f.quantity ? Number(f.quantity) : undefined, notional: f.notional ? Number(f.notional) : undefined }),
  },
  {
    id: "createXchangeRfq",
    group: "xChange",
    label: "Create RFQ (firm quote)",
    description: "Get a firm executable quote for buying or selling a stock token.",
    fields: [
      text("symbol", "Symbol", "e.g. AAPL"),
      selectField("side", "Side", ["buy", "sell"]),
      opt("quantity", "Quantity (tokens)", "e.g. 10"),
      opt("notional", "Notional (USD)", "e.g. 1000"),
      opt("walletAddress", "Wallet address", "0x…"),
      opt("chain", "Chain", "e.g. ethereum"),
    ],
    buildPayload: (f) =>
      compact({ symbol: f.symbol, side: f.side, quantity: f.quantity ? Number(f.quantity) : undefined, notional: f.notional ? Number(f.notional) : undefined, walletAddress: f.walletAddress, chain: f.chain }),
  },
  {
    id: "getXchangeQuote",
    group: "xChange",
    label: "Get quote by ID",
    description: "Fetch a previously created xChange quote.",
    fields: [text("id", "Quote ID", "uuid")],
    buildPayload: (f) => ({ id: f.id }),
  },
  // ── Trades ───────────────────────────────────────────────────────────────────
  {
    id: "getTradesSummary",
    group: "Market",
    label: "Trades summary",
    description: "Aggregated trading statistics for your account.",
    fields: [],
    submitLabel: "Load summary",
    buildPayload: () => ({}),
  },
  {
    id: "listTrades",
    group: "Market",
    label: "List trades",
    description: "Paginated history of all your trades.",
    fields: [
      opt("symbol", "Symbol (optional)", "e.g. TSLA"),
      opt("type", "Type (optional)", "xchange / market / inkind"),
      opt("status", "Status (optional)", "pending / completed / failed"),
      opt("from", "From (ISO date)", "2024-01-01"),
      opt("to", "To (ISO date)", "2024-12-31"),
      opt("limit", "Limit", "50"),
      opt("offset", "Offset", "0"),
    ],
    buildPayload: (f) => compact({ symbol: f.symbol, type: f.type, status: f.status, from: f.from, to: f.to, limit: f.limit ? Number(f.limit) : undefined, offset: f.offset ? Number(f.offset) : undefined }),
  },
  {
    id: "getTrade",
    group: "Market",
    label: "Get trade by ID",
    description: "Full details for a single trade.",
    fields: [text("id", "Trade ID", "uuid")],
    buildPayload: (f) => ({ id: f.id }),
  },
  {
    id: "getMarketFees",
    group: "Market",
    label: "Market fees",
    description: "Fee schedule for market (primary) issuance and redemption.",
    fields: [],
    submitLabel: "Load fees",
    buildPayload: () => ({}),
  },
  {
    id: "getMarketIssuanceWallets",
    group: "Market",
    label: "Market issuance wallets",
    description: "Sweeping wallets for primary token issuance (minting).",
    fields: [],
    submitLabel: "Load wallets",
    buildPayload: () => ({}),
  },
  {
    id: "getMarketRedemptionWallets",
    group: "Market",
    label: "Market redemption wallets",
    description: "Sweeping wallets for primary token redemption (burning).",
    fields: [],
    submitLabel: "Load wallets",
    buildPayload: () => ({}),
  },
  {
    id: "getInkindSweepingWallets",
    group: "Market",
    label: "InKind sweeping wallets",
    description: "Wallets for in-kind (xPort) stock delivery trades.",
    fields: [],
    submitLabel: "Load wallets",
    buildPayload: () => ({}),
  },
  // ── Bridges ──────────────────────────────────────────────────────────────────
  {
    id: "listBridges",
    group: "Bridges",
    label: "List bridges",
    description: "Authenticated bridge routes available for cross-chain transfers.",
    fields: [],
    submitLabel: "Load bridges",
    buildPayload: () => ({}),
  },
  {
    id: "getBridgeSweepingWallets",
    group: "Bridges",
    label: "Bridge sweeping wallets",
    description: "Wallets used to sweep tokens during bridging.",
    fields: [],
    submitLabel: "Load wallets",
    buildPayload: () => ({}),
  },
];

const GROUP_ORDER: Operation["group"][] = ["Public", "Client", "xChange", "Market", "Bridges"];

const GROUP_COLORS: Record<Operation["group"], string> = {
  Public: "text-sky-400 bg-sky-400/10",
  Client: "text-violet-400 bg-violet-400/10",
  xChange: "text-amber-400 bg-amber-400/10",
  Market: "text-emerald-400 bg-emerald-400/10",
  Bridges: "text-rose-400 bg-rose-400/10",
};

export function XStocksSection() {
  const [activeGroup, setActiveGroup] = useState<Operation["group"]>("Public");
  const [selected, setSelected] = useState<Operation | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ops = OPERATIONS.filter((o) => o.group === activeGroup);

  function selectOp(op: Operation) {
    setSelected(op);
    setForm({});
    setResult(null);
    setError(null);
  }

  async function submit() {
    if (!selected) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const payload = selected.buildPayload(form);
      const res = await fetch("/api/xstocks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: selected.id, ...payload }),
      });
      const json = await res.json() as unknown;
      if (!res.ok) throw new Error((json as { error?: string }).error ?? res.statusText);
      setResult(JSON.stringify(json, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
        <div className="flex items-center gap-3 mb-2">
          <img src="/tokens/xstocks-icon.svg" alt="xStocks" className="h-10 w-10 rounded-xl bg-[#0D1B1A] p-1" />
          <div>
            <p className="font-semibold text-[#F2F0E8]">xStocks</p>
            <p className="text-xs text-[#A7A79A]">Tokenized real-world stocks on blockchain</p>
          </div>
        </div>
        <p className="text-xs text-[#A7A79A] leading-relaxed">
          Access tokenized versions of AAPL, TSLA, NVDA and 70+ other stocks. Trade via xChange RFQ, check proof of reserves, monitor corporate actions.
        </p>
      </div>

      {/* Group tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {GROUP_ORDER.map((g) => (
          <button
            key={g}
            onClick={() => { setActiveGroup(g); setSelected(null); setResult(null); setError(null); }}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              activeGroup === g
                ? "bg-[#F2F0E8] text-[#141513]"
                : "bg-white/[0.06] text-[#A7A79A] hover:text-[#F2F0E8]"
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      {/* Operation list */}
      {!selected && (
        <div className="flex flex-col gap-2">
          {ops.map((op) => (
            <button
              key={op.id}
              onClick={() => selectOp(op)}
              className="flex items-center gap-3 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-left hover:border-[#3A3B37] transition-colors"
            >
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${GROUP_COLORS[op.group]}`}>
                {op.group}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[#F2F0E8]">{op.label}</p>
                <p className="truncate text-xs text-[#A7A79A] mt-0.5">{op.description}</p>
              </div>
              <svg className="shrink-0 text-[#A7A79A]" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          ))}
        </div>
      )}

      {/* Operation form */}
      {selected && (
        <div className="flex flex-col gap-4">
          <button
            onClick={() => { setSelected(null); setResult(null); setError(null); }}
            className="flex items-center gap-1.5 text-xs text-[#A7A79A] hover:text-[#F2F0E8] transition-colors self-start"
          >
            ← Back
          </button>

          <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
            <div className="flex items-center gap-2 mb-1">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${GROUP_COLORS[selected.group]}`}>
                {selected.group}
              </span>
              <p className="font-semibold text-[#F2F0E8] text-sm">{selected.label}</p>
            </div>
            <p className="text-xs text-[#A7A79A]">{selected.description}</p>
          </div>

          {selected.fields.length > 0 && (
            <div className="flex flex-col gap-3">
              {selected.fields.map((f) => (
                <div key={f.name}>
                  <label className="mb-1 block text-xs font-medium text-[#A7A79A]">
                    {f.label}{f.required ? "" : " (optional)"}
                  </label>
                  {f.kind === "select" ? (
                    <select
                      value={form[f.name] ?? ""}
                      onChange={(e) => setForm((p) => ({ ...p, [f.name]: e.target.value }))}
                      className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
                    >
                      <option value="">Select…</option>
                      {f.options!.map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  ) : f.kind === "textarea" ? (
                    <textarea
                      rows={3}
                      value={form[f.name] ?? ""}
                      placeholder={f.placeholder}
                      onChange={(e) => setForm((p) => ({ ...p, [f.name]: e.target.value }))}
                      className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82] font-mono"
                    />
                  ) : (
                    <input
                      type={f.kind === "number" ? "number" : "text"}
                      value={form[f.name] ?? ""}
                      placeholder={f.placeholder}
                      onChange={(e) => setForm((p) => ({ ...p, [f.name]: e.target.value }))}
                      className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={submit}
            disabled={loading}
            className="w-full rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513] disabled:opacity-50"
          >
            {loading ? "Loading…" : selected.submitLabel ?? "Submit"}
          </button>

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
              {error}
            </div>
          )}

          {result && (
            <div className="rounded-xl border border-[#2A2B27] bg-[#141513] p-3">
              <p className="text-xs font-medium text-[#A7A79A] mb-2">Response</p>
              <pre className="text-xs text-[#F2F0E8] overflow-x-auto whitespace-pre-wrap break-all">{result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
