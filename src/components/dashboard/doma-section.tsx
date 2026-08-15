"use client";

import { useEffect, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";

type Tab = "discover" | "market" | "orderbook" | "events";

type DomaConfig = {
  env: string;
  apiBase: string;
  graphqlUrl: string;
  hasApiKey: boolean;
};

async function domaAction(action: string, payload: Record<string, unknown>) {
  const res = await fetch("/api/doma/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? "Doma request failed");
  return data.result;
}

function ResultBox({ error, result }: { error: string | null; result: unknown }) {
  if (!error && result == null) return null;
  return (
    <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      <p className="text-sm font-semibold text-[#F2F0E8]">{error ? "Error" : "Result"}</p>
      <pre className={`mt-3 max-h-80 overflow-auto rounded-xl border border-[#2A2B27] bg-[#141513] p-3 text-[11px] leading-relaxed ${error ? "text-red-300" : "text-[#D8D6CC]"}`}>
        {error ?? JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number";
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#A7A79A]">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-sm text-[#F2F0E8] placeholder:text-[#A7A79A]/40 outline-none focus:border-[#8FAE82]/60"
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#A7A79A]">{label}</span>
      <textarea
        rows={4}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full resize-none rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 font-mono text-xs text-[#F2F0E8] placeholder:text-[#A7A79A]/40 outline-none focus:border-[#8FAE82]/60"
      />
    </label>
  );
}

function parseJson(value: string, fallback: unknown) {
  if (!value.trim()) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON. Check the pasted payload and try again.");
  }
}

function parseBulkOrders(value: string) {
  const orders = parseJson(value, []);
  if (!Array.isArray(orders)) throw new Error("Bulk orders JSON must be an array.");
  if (orders.length > 50) throw new Error("Doma bulk order APIs accept up to 50 orders per request.");
  return orders;
}

export function DomaSection() {
  const { user } = usePrivy();
  const [tab, setTab] = useState<Tab>("discover");
  const [config, setConfig] = useState<DomaConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);

  const evmAddress = user?.wallet?.address ?? "";
  const [domain, setDomain] = useState("example.com");
  const [sld, setSld] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [buyer, setBuyer] = useState(evmAddress);
  const [chainId, setChainId] = useState("eip155:97476");
  const [contractAddress, setContractAddress] = useState("");
  const [orderbook, setOrderbook] = useState("DOMA");
  const [cursor, setCursor] = useState("bluvfi");
  const [correlationId, setCorrelationId] = useState("");
  const [lastEventId, setLastEventId] = useState("");
  const [eventTypes, setEventTypes] = useState("");
  const [includeSynthetics, setIncludeSynthetics] = useState(true);
  const [signature, setSignature] = useState("");
  const [orderParameters, setOrderParameters] = useState("{\n  \"offerer\": \"0x...\",\n  \"startTime\": 0,\n  \"endTime\": 0\n}");
  const [bulkId, setBulkId] = useState("");
  const [email, setEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [emailProof, setEmailProof] = useState("");
  const [registrarIanaId, setRegistrarIanaId] = useState("");
  const [metadataTokens, setMetadataTokens] = useState("[\n  {\n    \"name\": \"example.com\",\n    \"networkId\": \"eip155:97476\",\n    \"type\": \"OWNERSHIP\",\n    \"expiresAt\": \"2027-01-01T00:00:00.000Z\"\n  }\n]");
  const [contactJson, setContactJson] = useState("{\n  \"email\": \"owner@example.com\",\n  \"name\": \"Afolabi\",\n  \"country\": \"US\"\n}");

  useEffect(() => {
    fetch("/api/doma/action")
      .then((res) => res.json())
      .then((data) => setConfig(data))
      .catch(() => setConfig(null));
  }, []);

  useEffect(() => {
    if (evmAddress && !buyer) setBuyer(evmAddress);
  }, [evmAddress, buyer]);

  const run = async (action: string, payload: Record<string, unknown> | (() => Record<string, unknown>)) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const nextPayload = typeof payload === "function" ? payload() : payload;
      setResult(await domaAction(action, nextPayload));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Doma request failed");
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
              <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-xs font-medium text-cyan-300">DomainFi</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${config?.hasApiKey ? "bg-emerald-400/10 text-emerald-400" : "bg-amber-400/10 text-amber-400"}`}>
                {config?.hasApiKey ? "API key ready" : "Read-only / needs key"}
              </span>
            </div>
            <p className="mt-2 text-lg font-bold text-[#F2F0E8]">Doma Protocol</p>
            <p className="mt-1 text-xs leading-relaxed text-[#A7A79A]">
              Search tokenized domains, inspect listings and offers, prepare marketplace fills, and monitor protocol events.
            </p>
          </div>
          <span className="text-2xl">⌁</span>
        </div>
        <p className="mt-3 truncate text-[10px] text-[#A7A79A]">
          {config ? `${config.env} · ${config.apiBase}` : "Checking Doma connection..."}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-1 rounded-xl border border-[#2A2B27] bg-white/[0.03] p-1">
        {(["discover", "market", "orderbook", "events"] as const).map((item) => (
          <button
            key={item}
            onClick={() => {
              setTab(item);
              setResult(null);
              setError(null);
            }}
            className={`rounded-lg px-2 py-2 text-[11px] font-semibold capitalize transition-colors ${
              tab === item ? "bg-[#F2F0E8] text-[#141513]" : "text-[#A7A79A] hover:text-[#F2F0E8]"
            }`}
          >
            {item}
          </button>
        ))}
      </div>

      {tab === "discover" && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <p className="text-sm font-semibold text-[#F2F0E8]">Domain discovery</p>
          <p className="mt-1 text-xs text-[#A7A79A]">Search names, inspect a domain, load token records, or check command status.</p>
          <div className="mt-4 grid gap-3">
            <Field label="Domain" value={domain} onChange={setDomain} placeholder="example.com" />
            <Field label="Token ID" value={tokenId} onChange={setTokenId} placeholder="Optional for statistics" />
            <Field label="Command correlation ID" value={correlationId} onChange={setCorrelationId} placeholder="Optional command ID" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button disabled={loading} onClick={() => run("searchNames", { name: domain, take: 20 })} className="rounded-xl bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513] disabled:opacity-50">Search</button>
            <button disabled={loading} onClick={() => run("getName", { name: domain })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Inspect</button>
            <button disabled={loading} onClick={() => run(tokenId ? "getNameStatistics" : "getTokens", tokenId ? { tokenId } : { name: domain })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">
              {tokenId ? "Stats" : "Tokens"}
            </button>
            <button disabled={loading || !tokenId} onClick={() => run("getToken", { tokenId })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Token detail</button>
            <button disabled={loading || !correlationId} onClick={() => run("getCommand", { correlationId })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Command</button>
            <button disabled={loading} onClick={() => run("getSupportedTlds", { query: domain.split(".").pop() ?? "" })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">TLDs</button>
            <button disabled={loading} onClick={() => run("getNetworkInfo", {})} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Network</button>
            <button disabled={loading} onClick={() => run("getFractionalizationInfo", {})} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Fractionalization</button>
            <button disabled={loading} onClick={() => run("getLifecycleWorkflows", {})} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Workflows</button>
            <button disabled={loading} onClick={() => run("getNameActivities", { name: domain, take: 20 })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Name activity</button>
            <button disabled={loading || !tokenId} onClick={() => run("getTokenActivities", { tokenId, take: 20 })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Token activity</button>
          </div>
          <div className="mt-5 border-t border-[#2A2B27] pt-4">
            <p className="text-sm font-semibold text-[#F2F0E8]">Tokenization helpers</p>
            <p className="mt-1 text-xs text-[#A7A79A]">Generate metadata and prepare registrant contact vouchers for Doma registrar flows.</p>
            <div className="mt-4 grid gap-3">
              <TextArea label="Metadata tokens JSON" value={metadataTokens} onChange={setMetadataTokens} />
              <Field label="Email" value={email} onChange={setEmail} placeholder="owner@example.com" />
              <Field label="Email code" value={verificationCode} onChange={setVerificationCode} placeholder="123456" />
              <Field label="Email proof" value={emailProof} onChange={setEmailProof} placeholder="Proof from complete verification" />
              <Field label="Network ID" value={chainId} onChange={setChainId} placeholder="eip155:97476" />
              <Field label="Registrar IANA ID" value={registrarIanaId} onChange={setRegistrarIanaId} placeholder="3765" type="number" />
              <TextArea label="Registrant contact JSON" value={contactJson} onChange={setContactJson} />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button disabled={loading} onClick={() => run("generateMetadata", () => ({ tokens: parseJson(metadataTokens, []) }))} className="rounded-xl bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513] disabled:opacity-50">Metadata</button>
              <button disabled={loading || !email} onClick={() => run("initiateEmailVerification", { email })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Start email</button>
              <button disabled={loading || !email || !verificationCode} onClick={() => run("completeEmailVerification", { email, code: verificationCode })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Verify email</button>
              <button disabled={loading || !emailProof || !registrarIanaId} onClick={() => run("uploadRegistrantContacts", () => ({ contact: parseJson(contactJson, {}) as Record<string, unknown>, emailVerificationProof: emailProof, networkId: chainId, registrarIanaId: Number(registrarIanaId) }))} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Upload contacts</button>
              <button disabled={loading || !registrarIanaId} onClick={() => run("uploadVerifiedRegistrantContacts", () => ({ contact: parseJson(contactJson, {}) as Record<string, unknown>, networkId: chainId, registrarIanaId: Number(registrarIanaId) }))} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Upload verified</button>
            </div>
          </div>
        </div>
      )}

      {tab === "market" && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <p className="text-sm font-semibold text-[#F2F0E8]">Marketplace</p>
          <p className="mt-1 text-xs text-[#A7A79A]">Browse buy-now listings and active offers from Doma marketplace data.</p>
          <div className="mt-4 grid gap-3">
            <Field label="Second-level domain" value={sld} onChange={setSld} placeholder="example" />
            <Field label="Token ID for offers" value={tokenId} onChange={setTokenId} placeholder="Optional" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button disabled={loading} onClick={() => run("getListings", { sld: sld || undefined, take: 20 })} className="rounded-xl bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513] disabled:opacity-50">Listings</button>
            <button disabled={loading} onClick={() => run("getOffers", { tokenId: tokenId || undefined, take: 20, status: "ACTIVE" })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Offers</button>
          </div>
        </div>
      )}

      {tab === "orderbook" && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <p className="text-sm font-semibold text-[#F2F0E8]">Orderbook prep</p>
          <p className="mt-1 text-xs text-[#A7A79A]">Fetch fees/currencies, fulfillment calldata, or submit signed listing/offer orders.</p>
          <div className="mt-4 grid gap-3">
            <Field label="Orderbook" value={orderbook} onChange={setOrderbook} placeholder="DOMA" />
            <Field label="Chain ID" value={chainId} onChange={setChainId} placeholder="eip155:97476" />
            <Field label="Token contract" value={contractAddress} onChange={setContractAddress} placeholder="0x..." />
            <Field label="Order ID" value={orderId} onChange={setOrderId} placeholder="Listing or offer order ID" />
            <Field label="Buyer / fulfiller" value={buyer} onChange={setBuyer} placeholder="0x..." />
            <Field label="Signature" value={signature} onChange={setSignature} placeholder="0x... signed EIP-712 order/cancel signature" />
            <TextArea label="Order parameters / bulk orders JSON" value={orderParameters} onChange={setOrderParameters} />
            <Field label="Bulk job ID" value={bulkId} onChange={setBulkId} placeholder="Bulk listing/offer ID" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button disabled={loading || !contractAddress} onClick={() => run("getOrderbookFees", { orderbook, chainId, contractAddress })} className="rounded-xl bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513] disabled:opacity-50">Fees</button>
            <button disabled={loading || !contractAddress} onClick={() => run("getSupportedCurrencies", { orderbook, chainId, contractAddress })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Currencies</button>
            <button disabled={loading || !orderId || !buyer} onClick={() => run("getListingFulfillment", { orderId, buyer })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Buy data</button>
            <button disabled={loading || !orderId || !buyer} onClick={() => run("getOfferFulfillment", { orderId, fulfiller: buyer })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Accept offer data</button>
            <button disabled={loading || !signature} onClick={() => run("createListing", () => ({ orderbook, chainId, parameters: parseJson(orderParameters, {}) as Record<string, unknown>, signature, cancelExisting: false }))} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Create listing</button>
            <button disabled={loading || !signature} onClick={() => run("createOffer", () => ({ orderbook, chainId, parameters: parseJson(orderParameters, {}) as Record<string, unknown>, signature, cancelExisting: false }))} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Create offer</button>
            <button disabled={loading} onClick={() => run("createBulkListings", () => ({ orderbook, chainId, orders: parseBulkOrders(orderParameters), cancelExisting: false }))} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Submit bulk listings</button>
            <button disabled={loading} onClick={() => run("createBulkOffers", () => ({ orderbook, chainId, orders: parseBulkOrders(orderParameters), cancelExisting: false }))} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Submit bulk offers</button>
            <button disabled={loading || !orderId || !signature} onClick={() => run("cancelListing", { orderId, signature })} className="rounded-xl border border-red-400/40 py-2 text-xs font-semibold text-red-200 disabled:opacity-50">Cancel listing</button>
            <button disabled={loading || !orderId || !signature} onClick={() => run("cancelOffer", { orderId, signature })} className="rounded-xl border border-red-400/40 py-2 text-xs font-semibold text-red-200 disabled:opacity-50">Cancel offer</button>
            <button disabled={loading || !bulkId} onClick={() => run("getBulkListingItems", { id: bulkId })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Bulk listings</button>
            <button disabled={loading || !bulkId} onClick={() => run("getBulkOfferItems", { id: bulkId })} className="rounded-xl border border-[#8FAE82]/40 py-2 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Bulk offers</button>
          </div>
        </div>
      )}

      {tab === "events" && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <p className="text-sm font-semibold text-[#F2F0E8]">Protocol events</p>
          <p className="mt-1 text-xs text-[#A7A79A]">Poll Doma events for tokenization, marketplace, and domain lifecycle changes.</p>
          <div className="mt-4 grid gap-3">
            <Field label="Cursor" value={cursor} onChange={setCursor} placeholder="bluvfi" />
            <Field label="Last event ID" value={lastEventId} onChange={setLastEventId} placeholder="0" type="number" />
            <Field label="Event types" value={eventTypes} onChange={setEventTypes} placeholder="Comma-separated optional filters" />
            <label className="flex items-center justify-between rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-xs font-semibold text-[#D8D6CC]">
              Include synthetics
              <input
                type="checkbox"
                checked={includeSynthetics}
                onChange={(event) => setIncludeSynthetics(event.target.checked)}
                className="h-4 w-4 accent-[#8FAE82]"
              />
            </label>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <button disabled={loading} onClick={() => run("pollEvents", { cursor, limit: 10, finalizedOnly: true, includeSynthetics, eventTypes: eventTypes.split(",").map((item) => item.trim()).filter(Boolean) })} className="rounded-xl bg-[#8FAE82] py-2.5 text-xs font-semibold text-[#141513] disabled:opacity-50">Poll</button>
            <button disabled={loading || !lastEventId} onClick={() => run("acknowledgeEvents", { cursor, lastEventId: Number(lastEventId) })} className="rounded-xl border border-[#8FAE82]/40 py-2.5 text-xs font-semibold text-[#DCE8D5] disabled:opacity-50">Ack</button>
            <button disabled={loading || !lastEventId} onClick={() => run("resetEventCursor", { cursor, eventId: Number(lastEventId) })} className="rounded-xl border border-red-400/40 py-2.5 text-xs font-semibold text-red-200 disabled:opacity-50">Reset</button>
          </div>
        </div>
      )}

      <ResultBox error={error} result={result} />
    </div>
  );
}
