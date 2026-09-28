"use client";

import { useEffect, useState } from "react";

type FieldKind = "text" | "number" | "textarea" | "select" | "checkbox";

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
  group: "Market" | "My Account" | "Trading" | "Funding";
  label: string;
  description: string;
  /** Moves real money, creates a real account, or places/cancels a real order — needs a typed confirmation. */
  sensitive?: boolean;
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

const num = (name: string, label: string, placeholder?: string, required = true): FieldDef => ({
  name, label, placeholder, required, kind: "number",
});

const selectField = (name: string, label: string, options: string[], required = true): FieldDef => ({
  name, label, options, required, kind: "select",
});

function compact(p: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== ""));
}

const OPERATIONS: Operation[] = [
  // ── Market data (shared, read-only) ────────────────────────────────────────
  {
    id: "listTokens",
    group: "Market",
    label: "List active tokens",
    description: "All open tokens: equity, debt, SAFE and fixed-interest raises. Verified live: only page/limit are accepted here — filter by type on the results, or use Search.",
    fields: [opt("page", "Page"), opt("limit", "Limit")],
    submitLabel: "Load tokens",
    buildPayload: (f) => compact({ page: f.page, limit: f.limit }),
  },
  {
    id: "listRaisingTokens",
    group: "Market",
    label: "List raising tokens",
    description: "Tokens currently in an open fundraising round.",
    fields: [opt("page", "Page"), opt("limit", "Limit")],
    submitLabel: "Load raises",
    buildPayload: (f) => compact({ page: f.page, limit: f.limit }),
  },
  {
    id: "searchTokens",
    group: "Market",
    label: "Search tokens",
    description: "Search by name or symbol, with filters.",
    fields: [
      opt("name", "Name", "e.g. Desperado"),
      opt("symbol", "Symbol", "e.g. DAMO"),
      opt("page", "Page"),
      opt("limit", "Limit"),
    ],
    submitLabel: "Search",
    buildPayload: (f) => compact({ name: f.name, symbol: f.symbol, page: f.page, limit: f.limit }),
  },
  {
    id: "getToken",
    group: "Market",
    label: "Get token",
    description: "Full details for one token by its id.",
    fields: [text("tokenId", "Token ID")],
    buildPayload: (f) => ({ tokenId: f.tokenId }),
  },
  {
    id: "getAsset",
    group: "Market",
    label: "Get asset",
    description: "Details of the underlying asset behind a token.",
    fields: [text("assetId", "Asset ID")],
    buildPayload: (f) => ({ assetId: f.assetId }),
  },
  {
    id: "getTokenHistoricals",
    group: "Market",
    label: "Price history (OHLCV)",
    description: "Historical daily price and volume for a token.",
    fields: [text("tokenId", "Token ID"), opt("from", "From (ISO date)"), opt("to", "To (ISO date)")],
    buildPayload: (f) => compact({ tokenId: f.tokenId, from: f.from, to: f.to }),
  },
  {
    id: "getOfferingBook",
    group: "Market",
    label: "Order book",
    description: "Aggregate demand, cover ratio and the demand ladder for a live raise.",
    fields: [text("tokenId", "Token ID"), opt("tranche", "Tranche key (combined offerings only)")],
    buildPayload: (f) => compact({ tokenId: f.tokenId, tranche: f.tranche }),
  },
  {
    id: "getTransaction",
    group: "Market",
    label: "Verify a transaction",
    description: "Look up a transaction/payment by its reference to see if it's settled.",
    fields: [text("reference", "Reference (tx_ref)"), opt("transactionId", "Transaction ID (optional)")],
    buildPayload: (f) => compact({ reference: f.reference, transactionId: f.transactionId }),
  },

  // ── My Account ───────────────────────────────────────────────────────────────
  {
    id: "createMember",
    group: "My Account",
    label: "Open / confirm my account",
    description: "Idempotent: opens a real, KYC-approved GetEquity account for you if you don't have one yet, or confirms your existing one — never a duplicate. Confirm every field with the person this is for first; nothing here is fabricated. No password field — Bluvfi generates and discards one automatically.",
    sensitive: true,
    fields: [
      text("fname", "First name"), text("lname", "Last name"),
      text("email", "Email"), text("phone", "Phone"),
      text("dob", "Date of birth", "YYYY-MM-DD"),
      selectField("sex", "Sex", ["male", "female"]),
      text("homeAddress", "Home address"),
      text("city", "City"), text("state", "State"), text("country", "Country"),
    ],
    submitLabel: "Open / confirm my GetEquity account",
    buildPayload: (f) => ({
      fname: f.fname, lname: f.lname, email: f.email, phone: f.phone,
      dob: f.dob, sex: f.sex, homeAddress: f.homeAddress, city: f.city, state: f.state, country: f.country,
    }),
  },
  {
    id: "getMemberBalance",
    group: "My Account",
    label: "My wallet balance",
    description: "Your cash balance across every currency you hold.",
    fields: [],
    buildPayload: () => ({}),
  },
  {
    id: "getMemberTokenBalance",
    group: "My Account",
    label: "My holdings",
    description: "Every security you hold, with current value.",
    fields: [],
    buildPayload: () => ({}),
  },
  {
    id: "getMemberOrders",
    group: "My Account",
    label: "My orders",
    description: "Your buy/sell order history.",
    fields: [opt("page", "Page"), opt("limit", "Limit")],
    buildPayload: (f) => compact({ page: f.page, limit: f.limit }),
  },
  {
    id: "getMemberTransactions",
    group: "My Account",
    label: "My transactions",
    description: "Your full transaction history — funding, trades, payouts.",
    fields: [opt("page", "Page"), opt("limit", "Limit")],
    buildPayload: (f) => compact({ page: f.page, limit: f.limit }),
  },

  // ── Trading (moves real money) ──────────────────────────────────────────────
  {
    id: "buyTokenAsMember",
    group: "Trading",
    label: "Buy token",
    description: "Places a secondary-market buy order, escrowed against your existing wallet balance.",
    sensitive: true,
    fields: [text("tokenId", "Token ID"), num("amount", "Amount of tokens"), text("currency", "Currency", "e.g. NGN")],
    submitLabel: "Place buy order",
    buildPayload: (f) => ({ tokenId: f.tokenId, amount: Number(f.amount), currency: f.currency }),
  },
  {
    id: "sellTokenAsMember",
    group: "Trading",
    label: "Sell token",
    description: "Places a secondary-market sell order for tokens you already hold.",
    sensitive: true,
    fields: [text("tokenId", "Token ID"), num("amount", "Amount of tokens"), text("currency", "Currency", "e.g. NGN")],
    submitLabel: "Place sell order",
    buildPayload: (f) => ({ tokenId: f.tokenId, amount: Number(f.amount), currency: f.currency }),
  },
  {
    id: "getFundInvestQuote",
    group: "Trading",
    label: "Fund + invest quote",
    description: "Preview the fees and total charge for a fund-and-invest, before initiating any payment.",
    fields: [text("tokenId", "Token ID"), num("investmentAmount", "Investment amount"), text("currency", "Currency", "e.g. NGN")],
    submitLabel: "Get quote",
    buildPayload: (f) => ({ tokenId: f.tokenId, investmentAmount: Number(f.investmentAmount), currency: f.currency }),
  },
  {
    id: "fundInvest",
    group: "Trading",
    label: "Fund + invest",
    description: "Creates a payment link (card) or virtual account (bank transfer) that funds your wallet and invests in one flow. You pay it yourself — this call charges nothing by itself.",
    sensitive: true,
    fields: [
      text("tokenId", "Token ID"),
      num("investmentAmount", "Investment amount"), text("currency", "Currency", "e.g. NGN"),
      selectField("paymentMethod", "Payment method", ["card", "bank_transfer"]),
      opt("redirectUrl", "Redirect URL (required for card)"),
    ],
    submitLabel: "Create payment",
    buildPayload: (f) => compact({ tokenId: f.tokenId, investmentAmount: Number(f.investmentAmount), currency: f.currency, paymentMethod: f.paymentMethod, redirectUrl: f.redirectUrl }),
  },
  {
    id: "commitToOfferingAsMember",
    group: "Trading",
    label: "Bid into an offering",
    description: "Places a bid on your behalf. Cash is held on your own wallet until allotment.",
    sensitive: true,
    fields: [
      text("tokenId", "Offering/token ID"),
      num("amount", "Amount to commit"),
      opt("bid_price", "Bid price (price-based offerings)"),
      opt("bid_rate", "Bid rate (debt/fixed-interest offerings)"),
      opt("tranche", "Tranche key (combined offerings only)"),
    ],
    submitLabel: "Place bid",
    buildPayload: (f) => compact({
      tokenId: f.tokenId, amount: Number(f.amount),
      bid_price: f.bid_price ? Number(f.bid_price) : undefined,
      bid_rate: f.bid_rate ? Number(f.bid_rate) : undefined,
      tranche: f.tranche,
    }),
  },
  {
    id: "cancelMemberOrder",
    group: "Trading",
    label: "Cancel order",
    description: "Cancels an open order and reverses any escrowed funds.",
    sensitive: true,
    fields: [text("orderId", "Order ID")],
    submitLabel: "Cancel order",
    buildPayload: (f) => ({ orderId: f.orderId }),
  },

  // ── Funding & withdrawals (moves real money) ────────────────────────────────
  {
    id: "fundMemberWallet",
    group: "Funding",
    label: "Fund my wallet",
    description: "Funds your cash wallet only — no token purchase.",
    sensitive: true,
    fields: [
      num("amount", "Amount"),
      selectField("currency", "Currency", ["NGN", "USD", "KES", "GHS", "ZAR", "GBP", "EUR"]),
      selectField("paymentMethod", "Payment method", ["card", "bank_transfer", "ussd", "mobilemoney"], false),
      opt("redirectUrl", "Redirect URL (required unless bank_transfer)"),
    ],
    submitLabel: "Create payment",
    buildPayload: (f) => compact({ amount: Number(f.amount), currency: f.currency, paymentMethod: f.paymentMethod || undefined, redirectUrl: f.redirectUrl }),
  },
  {
    id: "withdrawMemberWallet",
    group: "Funding",
    label: "Withdraw to bank",
    description: "Debits your wallet to a bank account. Created as Pending — still needs approval before disbursement.",
    sensitive: true,
    fields: [
      num("amount", "Amount"),
      text("bank_name", "Bank name", "full name, e.g. Guaranty Trust Bank"),
      text("account_name", "Account name"), text("account_number", "Account number"),
      selectField("currency", "Currency", ["NGN", "KES", "GHS", "ZAR", "UGX", "TZS"]),
    ],
    submitLabel: "Request withdrawal",
    buildPayload: (f) => ({ amount: Number(f.amount), bank_name: f.bank_name, account_name: f.account_name, account_number: f.account_number, currency: f.currency }),
  },
];

const GROUP_ORDER: Operation["group"][] = ["Market", "My Account", "Trading", "Funding"];

const GROUP_COLORS: Record<Operation["group"], string> = {
  Market: "text-emerald-400 bg-emerald-400/10",
  "My Account": "text-sky-400 bg-sky-400/10",
  Trading: "text-amber-400 bg-amber-400/10",
  Funding: "text-rose-400 bg-rose-400/10",
};

export function GetEquitySection() {
  const [config, setConfig] = useState<{ hasApiKey: boolean; env: string } | null>(null);
  const [activeGroup, setActiveGroup] = useState<Operation["group"]>("Market");
  const [selected, setSelected] = useState<Operation | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/getequity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "getConfig" }),
    })
      .then((r) => r.json())
      .then((d) => setConfig(d))
      .catch(() => setConfig({ hasApiKey: false, env: "sandbox" }));
  }, []);

  const ops = OPERATIONS.filter((o) => o.group === activeGroup);

  function selectOp(op: Operation) {
    setSelected(op);
    setForm({});
    setConfirmed(false);
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
      const res = await fetch("/api/getequity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: selected.id, ...payload }),
      });
      const json = (await res.json()) as unknown;
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
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-400/10 text-lg font-bold text-indigo-400">GE</div>
          <div>
            <p className="font-semibold text-[#F2F0E8]">GetEquity</p>
            <p className="text-xs text-[#A7A79A]">Private markets — equity, SAFE, debt and fixed-interest raises</p>
          </div>
        </div>
        <p className="text-xs text-[#A7A79A] leading-relaxed">
          Managed model: each Bluvfi user who opts in gets a real, KYC-approved GetEquity account (a "member") that Bluvfi
          acts on behalf of. GetEquity holds the member's cash and securities — Bluvfi never custodies them.
        </p>
        {config && (
          <span className={`mt-3 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${config.hasApiKey ? "bg-emerald-400/10 text-emerald-400" : "bg-amber-400/10 text-amber-400"}`}>
            {config.hasApiKey ? `Configured — ${config.env}` : "Not configured — set GETEQUITY_SECRET_KEY"}
          </span>
        )}
      </div>

      {/* Group tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {GROUP_ORDER.map((g) => (
          <button
            key={g}
            onClick={() => { setActiveGroup(g); setSelected(null); setResult(null); setError(null); }}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              activeGroup === g ? "bg-[#F2F0E8] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A] hover:text-[#F2F0E8]"
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
                <p className="text-sm font-medium text-[#F2F0E8]">
                  {op.label}
                  {op.sensitive && <span className="ml-2 text-[10px] font-semibold text-red-400">MOVES MONEY</span>}
                </p>
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
                        <option key={o} value={o}>{o || "—"}</option>
                      ))}
                    </select>
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

          {selected.sensitive && (
            <label className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
              <span>I've confirmed these exact details with the person this affects, and I understand this moves real money or creates a real account on GetEquity.</span>
            </label>
          )}

          <button
            onClick={submit}
            disabled={loading || (selected.sensitive && !confirmed)}
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
