"use client";

import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

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
  group: "Gateway" | "Core" | "Remittance";
  label: string;
  description: string;
  fields: FieldDef[];
  submitLabel?: string;
  buildPayload: (form: Record<string, string>) => Record<string, unknown>;
};

const text = (name: string, label: string, placeholder?: string, required = true): FieldDef => ({
  name,
  label,
  placeholder,
  required,
});

const numberField = (name: string, label: string, placeholder?: string, required = true): FieldDef => ({
  name,
  label,
  placeholder,
  required,
  kind: "number",
});

const jsonField = (name: string, label: string, placeholder: string, required = true): FieldDef => ({
  name,
  label,
  placeholder,
  required,
  kind: "textarea",
});

function optionalNumber(value: string) {
  return value.trim() ? Number(value) : undefined;
}

function compact(payload: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== ""),
  );
}

function parseJson(value: string, fallback: Record<string, unknown> = {}) {
  if (!value.trim()) return fallback;
  return JSON.parse(value) as Record<string, unknown>;
}

const OPERATIONS: Operation[] = [
  {
    id: "listGatewaySupportedAssets",
    group: "Gateway",
    label: "List supported assets",
    description: "Show Fuze Pay assets, chains, and networks available for wallets and payments.",
    fields: [],
    submitLabel: "Load assets",
    buildPayload: () => ({}),
  },
  {
    id: "getGatewayAccountBalances",
    group: "Gateway",
    label: "Account balances",
    description: "Check merchant fiat balances for Fuze Pay settlement accounts.",
    fields: [],
    submitLabel: "Check balances",
    buildPayload: () => ({}),
  },
  {
    id: "createGatewayCustomer",
    group: "Gateway",
    label: "Create gateway customer",
    description: "Create a Fuze Pay customer with API-driven KYC data.",
    fields: [
      text("clientIdentifier", "Client identifier", "afolabi-main"),
      text("email", "Email", "jwavolabilove0016@gmail.com", false),
      jsonField("kycData", "KYC data JSON", '{ "name": "Afolabi", "country": "NG" }'),
    ],
    buildPayload: (form) => compact({
      clientIdentifier: form.clientIdentifier,
      email: form.email,
      type: "THIRD_PARTY",
      kycData: parseJson(form.kycData),
    }),
  },
  {
    id: "fetchGatewayCustomer",
    group: "Gateway",
    label: "Fetch gateway customer",
    description: "Check a Fuze Pay customer status by client identifier.",
    fields: [text("clientIdentifier", "Client identifier", "afolabi-main")],
    buildPayload: (form) => ({ clientIdentifier: form.clientIdentifier }),
  },
  {
    id: "createGatewayDepositWallet",
    group: "Gateway",
    label: "Create deposit wallet",
    description: "Create a reusable wallet address for crypto settlement or automatic conversion.",
    fields: [
      text("clientIdentifier", "Client identifier", "afolabi-main"),
      text("symbol", "Symbol", "USDC_USD"),
      text("chain", "Chain", "POLYGON"),
    ],
    buildPayload: (form) => ({ clientIdentifier: form.clientIdentifier, symbol: form.symbol, chain: form.chain }),
  },
  {
    id: "listGatewayDepositWallets",
    group: "Gateway",
    label: "List deposit wallets",
    description: "List deposit wallets for a customer, asset, or chain.",
    fields: [
      text("clientIdentifier", "Client identifier", "afolabi-main", false),
      text("symbol", "Symbol", "USDC_USD", false),
      text("chain", "Chain", "POLYGON", false),
    ],
    buildPayload: (form) => compact({ clientIdentifier: form.clientIdentifier, symbol: form.symbol, chain: form.chain }),
  },
  {
    id: "getGatewayConversionRate",
    group: "Gateway",
    label: "Conversion rate",
    description: "Get BUY or SELL pricing before creating a payin or payout.",
    fields: [
      text("symbol", "Symbol", "USDC_USD"),
      { name: "operation", label: "Operation", kind: "select", options: ["BUY", "SELL"], required: true },
      numberField("quantity", "Crypto quantity", "100", false),
      numberField("quoteQuantity", "Fiat quantity", "100", false),
    ],
    buildPayload: (form) => compact({
      symbol: form.symbol,
      operation: form.operation || "BUY",
      quantity: optionalNumber(form.quantity),
      quoteQuantity: optionalNumber(form.quoteQuantity),
    }),
  },
  {
    id: "createGatewayPayin",
    group: "Gateway",
    label: "Create payin",
    description: "Request a customer payment in crypto or crypto-to-fiat.",
    fields: [
      text("clientIdentifier", "Client identifier", "afolabi-main"),
      text("symbol", "Symbol", "USDC_USD"),
      text("chain", "Chain", "POLYGON", false),
      numberField("quantity", "Crypto quantity", "", false),
      numberField("quoteQuantity", "Fiat quantity", "25", false),
      text("clientOrderId", "Client order ID", "payin-afolabi-001", false),
    ],
    buildPayload: (form) => compact({
      clientIdentifier: form.clientIdentifier,
      symbol: form.symbol,
      chain: form.chain,
      quantity: optionalNumber(form.quantity),
      quoteQuantity: optionalNumber(form.quoteQuantity),
      clientOrderId: form.clientOrderId,
    }),
  },
  {
    id: "fetchGatewayPayin",
    group: "Gateway",
    label: "Fetch payin",
    description: "Check payin status by client order ID.",
    fields: [text("clientOrderId", "Client order ID", "payin-afolabi-001")],
    buildPayload: (form) => ({ clientOrderId: form.clientOrderId }),
  },
  {
    id: "createGatewayPayout",
    group: "Gateway",
    label: "Create payout",
    description: "Send a wallet payout after confirming destination and amount.",
    fields: [
      text("clientIdentifier", "Client identifier", "afolabi-main"),
      text("address", "Destination wallet", "0x..."),
      text("chain", "Chain", "POLYGON"),
      text("symbol", "Symbol", "USDC"),
      numberField("quantity", "Quantity", "10", false),
      text("clientOrderId", "Client order ID", "payout-afolabi-001", false),
    ],
    buildPayload: (form) => compact({
      clientIdentifier: form.clientIdentifier,
      address: form.address,
      chain: form.chain,
      symbol: form.symbol,
      quantity: optionalNumber(form.quantity),
      clientOrderId: form.clientOrderId,
    }),
  },
  {
    id: "fetchGatewayPayout",
    group: "Gateway",
    label: "Fetch payout",
    description: "Check payout or refund status by client order ID.",
    fields: [text("clientOrderId", "Client order ID", "payout-afolabi-001")],
    buildPayload: (form) => ({ clientOrderId: form.clientOrderId }),
  },
  {
    id: "createUser",
    group: "Core",
    label: "Create Fuze user",
    description: "Create a Fuze end user or operational user.",
    fields: [
      text("orgUserId", "Org user ID", "afolabi-core"),
      { name: "userType", label: "User type", kind: "select", options: ["USER", "ORG_USER"], required: true },
      text("email", "Email", "jwavolabilove0016@gmail.com", false),
      text("firstName", "First name", "Afolabi", false),
      text("lastName", "Last name", "", false),
      text("country", "Country", "NG", false),
    ],
    buildPayload: (form) => compact(form),
  },
  {
    id: "getUser",
    group: "Core",
    label: "Fetch Fuze user",
    description: "Check KYC and profile status for a Fuze user.",
    fields: [text("orgUserId", "Org user ID", "afolabi-core")],
    buildPayload: (form) => ({ orgUserId: form.orgUserId }),
  },
  {
    id: "getUserKycLink",
    group: "Core",
    label: "Generate KYC link",
    description: "Create a hosted KYC/KYB link for a Fuze user.",
    fields: [text("orgUserId", "Org user ID", "afolabi-core")],
    buildPayload: (form) => ({ orgUserId: form.orgUserId }),
  },
  {
    id: "getUserBalance",
    group: "Core",
    label: "User balances",
    description: "Fetch balances across a user's Fuze wallets and accounts.",
    fields: [text("orgUserId", "Org user ID", "afolabi-core")],
    buildPayload: (form) => ({ orgUserId: form.orgUserId }),
  },
  {
    id: "createInternalWallet",
    group: "Core",
    label: "Create crypto wallet",
    description: "Issue a Fuze-hosted crypto wallet for a user.",
    fields: [
      text("orgUserId", "Org user ID", "afolabi-core"),
      text("currency", "Currency", "USDC"),
      text("network", "Network", "polygon"),
    ],
    buildPayload: (form) => form,
  },
  {
    id: "createInternalAccount",
    group: "Core",
    label: "Create fiat account",
    description: "Issue a Fuze-hosted fiat account for a user.",
    fields: [
      text("orgUserId", "Org user ID", "afolabi-core"),
      text("currency", "Currency", "AED"),
    ],
    buildPayload: (form) => form,
  },
  {
    id: "createTradeQuote",
    group: "Core",
    label: "Trade quote",
    description: "Quote crypto/fiat conversion for an existing Fuze customer.",
    fields: [
      text("customerId", "Customer ID", "afolabi-core"),
      text("fromCurrency", "From currency", "USDC"),
      numberField("fromAmount", "Amount", "10"),
      text("toCurrency", "To currency", "AED"),
    ],
    buildPayload: (form) => ({
      customerId: form.customerId,
      from: { currency: form.fromCurrency, amount: Number(form.fromAmount) },
      to: { currency: form.toCurrency },
    }),
  },
  {
    id: "createRemittanceOriginator",
    group: "Remittance",
    label: "Create originator",
    description: "Create the remittance sender profile.",
    fields: [
      text("name", "Name", "Afolabi"),
      text("email", "Email", "jwavolabilove0016@gmail.com", false),
      text("phoneNumber", "Phone", "", false),
      text("address", "Address", "Lagos"),
      text("nationality", "Nationality", "NG"),
      text("country", "Sender country", "NG"),
      text("idType", "ID type", "PASSPORT"),
      text("idNumber", "ID number", "A0000000"),
      text("clientIdentifier", "Client identifier", "afolabi-originator"),
      text("dob", "Date of birth", "1990-01-01"),
    ],
    buildPayload: (form) => compact({ ...form, type: "ORIGINATOR" }),
  },
  {
    id: "fetchRemittanceOriginator",
    group: "Remittance",
    label: "Fetch originator",
    description: "Check remittance sender verification status.",
    fields: [text("clientIdentifier", "Client identifier", "afolabi-originator")],
    buildPayload: (form) => ({ clientIdentifier: form.clientIdentifier }),
  },
  {
    id: "createRemittanceBeneficiary",
    group: "Remittance",
    label: "Create beneficiary",
    description: "Create a remittance receiver account under a sender.",
    fields: [
      text("thirdPartyClientIdentifier", "Originator ID", "afolabi-originator"),
      text("clientIdentifier", "Beneficiary ID", "afolabi-beneficiary"),
      text("currency", "Currency", "INR"),
      text("accountType", "Account type", "BANK"),
      text("country", "Country", "IN"),
      jsonField("accountData", "Account data JSON", '{ "accountNumber": "123456789", "ifscCode": "ICIC0000001", "name": "Afolabi", "bankAccountType": "NRO/SAVINGS" }'),
    ],
    buildPayload: (form) => ({
      thirdPartyClientIdentifier: form.thirdPartyClientIdentifier,
      clientIdentifier: form.clientIdentifier,
      currency: form.currency,
      accountType: form.accountType,
      country: form.country,
      enableAccountVerification: false,
      accountData: parseJson(form.accountData),
    }),
  },
  {
    id: "createRemittanceQuote",
    group: "Remittance",
    label: "Remittance quote",
    description: "Quote purchase of local currency before transfer.",
    fields: [
      text("fromCurrency", "From currency", "AED"),
      text("toCurrency", "To currency", "INR"),
      numberField("quantity", "Quantity", "100"),
      text("orgUserId", "Org user ID", "afolabi-core"),
    ],
    buildPayload: (form) => ({
      fromCurrency: form.fromCurrency,
      toCurrency: form.toCurrency,
      quantity: Number(form.quantity),
      orgUserId: form.orgUserId,
    }),
  },
  {
    id: "createRemittancePayoutToBeneficiary",
    group: "Remittance",
    label: "Send to beneficiary",
    description: "Transfer local currency to an existing beneficiary.",
    fields: [
      text("currency", "Currency", "INR"),
      numberField("amount", "Amount", "1000"),
      text("clientOrderId", "Client order ID", "remit-afolabi-001"),
      text("clientIdentifier", "Beneficiary ID", "afolabi-beneficiary"),
      text("purpose", "Purpose", "FAMILY"),
    ],
    buildPayload: (form) => ({
      currency: form.currency,
      amount: Number(form.amount),
      clientOrderId: form.clientOrderId,
      clientIdentifier: form.clientIdentifier,
      purpose: form.purpose,
    }),
  },
  {
    id: "listRemittancePayouts",
    group: "Remittance",
    label: "List payouts",
    description: "List payout statuses for a remittance beneficiary.",
    fields: [text("clientIdentifier", "Beneficiary ID", "afolabi-beneficiary")],
    buildPayload: (form) => ({ clientIdentifier: form.clientIdentifier }),
  },
];

const GROUPS = ["Gateway", "Core", "Remittance"] as const;

function defaultForm(operation: Operation, userEmail?: string, userName?: string) {
  const values: Record<string, string> = {};
  for (const field of operation.fields) {
    values[field.name] = field.placeholder ?? field.options?.[0] ?? "";
  }
  if (userEmail && "email" in values) values.email = userEmail;
  if (userName && "name" in values) values.name = userName;
  return values;
}

export function FuzeSection() {
  const { user } = usePrivy();
  const [activeGroup, setActiveGroup] = useState<(typeof GROUPS)[number]>("Gateway");
  const operations = useMemo(() => OPERATIONS.filter((op) => op.group === activeGroup), [activeGroup]);
  const [operationId, setOperationId] = useState(operations[0].id);
  const operation = OPERATIONS.find((op) => op.id === operationId) ?? operations[0];
  const [form, setForm] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ configured: boolean; baseUrl: string } | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const userEmail = user?.email?.address;
  const userName = user?.google?.name ?? user?.email?.address?.split("@")[0];

  useEffect(() => {
    fetch("/api/fuze/action")
      .then((res) => res.json())
      .then((data) => setStatus({ configured: Boolean(data.configured), baseUrl: data.baseUrl }))
      .catch(() => setStatus({ configured: false, baseUrl: "Unavailable" }));
  }, []);

  useEffect(() => {
    const first = operations[0];
    setOperationId(first.id);
  }, [operations]);

  useEffect(() => {
    setForm(defaultForm(operation, userEmail, userName));
    setResult(null);
    setError(null);
  }, [operation, userEmail, userName]);

  const runAction = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const payload = operation.buildPayload(form);
      const res = await fetch("/api/fuze/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: operation.id, payload }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Fuze request failed");
      setResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fuze request failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-blue-400/10 px-2 py-0.5 text-xs font-medium text-blue-400">Live API</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status?.configured ? "bg-emerald-400/10 text-emerald-400" : "bg-amber-400/10 text-amber-400"}`}>
                {status?.configured ? "Configured" : "Needs keys"}
              </span>
            </div>
            <p className="mt-2 text-lg font-bold text-[#F2F0E8]">Fuze Finance Console</p>
            <p className="mt-1 text-xs leading-relaxed text-[#A7A79A]">
              Run Fuze gateway, core wallet/account, trade, and remittance actions directly from Bluvfi.
            </p>
          </div>
        </div>
        <p className="mt-3 truncate text-[10px] text-[#A7A79A]">Base URL: {status?.baseUrl ?? "Checking..."}</p>
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-xl border border-[#2A2B27] bg-white/[0.03] p-1">
        {GROUPS.map((group) => (
          <button
            key={group}
            onClick={() => setActiveGroup(group)}
            className={`rounded-lg px-2 py-2 text-xs font-semibold transition-colors ${
              activeGroup === group ? "bg-[#F2F0E8] text-[#141513]" : "text-[#A7A79A] hover:text-[#F2F0E8]"
            }`}
          >
            {group}
          </button>
        ))}
      </div>

      <div>
        <label className="text-[10px] font-semibold uppercase tracking-wide text-[#A7A79A]">Action</label>
        <select
          value={operationId}
          onChange={(event) => setOperationId(event.target.value)}
          className="mt-1 w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-3 text-sm text-[#F2F0E8] outline-none"
        >
          {operations.map((op) => (
            <option key={op.id} value={op.id}>{op.label}</option>
          ))}
        </select>
      </div>

      <form onSubmit={runAction} className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
        <p className="text-sm font-semibold text-[#F2F0E8]">{operation.label}</p>
        <p className="mt-1 text-xs leading-relaxed text-[#A7A79A]">{operation.description}</p>

        {operation.fields.length > 0 && (
          <div className="mt-4 grid grid-cols-1 gap-3">
            {operation.fields.map((field) => (
              <label key={field.name} className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-[#A7A79A]">{field.label}</span>
                {field.kind === "textarea" ? (
                  <textarea
                    required={field.required}
                    rows={4}
                    value={form[field.name] ?? ""}
                    onChange={(event) => setForm((current) => ({ ...current, [field.name]: event.target.value }))}
                    className="mt-1 w-full resize-none rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 font-mono text-xs text-[#F2F0E8] outline-none focus:border-[#8FAE82]/60"
                  />
                ) : field.kind === "select" ? (
                  <select
                    required={field.required}
                    value={form[field.name] ?? field.options?.[0] ?? ""}
                    onChange={(event) => setForm((current) => ({ ...current, [field.name]: event.target.value }))}
                    className="mt-1 w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]/60"
                  >
                    {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <input
                    required={field.required}
                    type={field.kind === "number" ? "number" : "text"}
                    value={form[field.name] ?? ""}
                    onChange={(event) => setForm((current) => ({ ...current, [field.name]: event.target.value }))}
                    className="mt-1 w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]/60"
                  />
                )}
              </label>
            ))}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="mt-4 w-full rounded-xl bg-[#8FAE82] px-4 py-3 text-sm font-semibold text-[#141513] transition-opacity disabled:opacity-50"
        >
          {loading ? "Running..." : operation.submitLabel ?? "Run action"}
        </button>
      </form>

      {(error || result !== null) && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <p className="text-sm font-semibold text-[#F2F0E8]">{error ? "Error" : "Result"}</p>
          <pre className={`mt-3 max-h-80 overflow-auto rounded-xl border border-[#2A2B27] bg-[#141513] p-3 text-[11px] leading-relaxed ${error ? "text-red-300" : "text-[#D8D6CC]"}`}>
            {error ?? JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
