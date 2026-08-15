"use client";

import { useState, useEffect, useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction } from "@privy-io/react-auth/solana";
import { Transaction } from "@solana/web3.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TradeQuote {
  usdc_amount: number;
  gold_amount: number;
  price_per_troy_oz: number;
  fee_bps: number;
  fee_usd: number;
  min_gold_out?: number;
  min_usdc_out?: number;
}

interface QuoteResult {
  trade_id: string;
  side: "buy" | "sell";
  quote: TradeQuote;
  cosigned_transaction: string;
}

interface Trade {
  trade_id: string;
  side: "buy" | "sell";
  status: string;
  usdc_amount: number;
  gold_amount: number;
  price_per_troy_oz: number;
  fee_usd: number;
  submitted_tx_hash?: string;
  created_at: string;
}

interface Denomination {
  id: string;
  label: string;
  weight_g: number;
  weight_troy_oz: number;
  city: string;
}

interface RedemptionQuote {
  denomination: string;
  weight_g: number;
  spot_price_usd: number;
  gold_value_usd: number;
  fee_usd: number;
  total_usd: number;
  tokens_required: string;
}

interface Redemption {
  redemption_id: string;
  status: string;
  denomination?: string;
  weight_g?: number;
  city?: string;
  quote?: RedemptionQuote;
  partially_signed_transaction?: string;
  submitted_tx_hash?: string;
  cancellation_reason?: string | null;
  created_at?: string;
}

type Tab = "buy" | "sell" | "redeem" | "history";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | undefined, d = 2) {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtGold(n: number | undefined) {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function statusColor(s: string) {
  if (s === "confirmed") return "text-green-400";
  if (s === "failed" || s === "cancelled") return "text-red-400";
  return "text-yellow-400";
}

const COUNTRY_OPTIONS = [
  { code: "PK", label: "Pakistan" },
  { code: "AE", label: "UAE" },
  { code: "SA", label: "Saudi Arabia" },
  { code: "NG", label: "Nigeria" },
  { code: "US", label: "United States" },
  { code: "GB", label: "United Kingdom" },
  { code: "GH", label: "Ghana" },
  { code: "KE", label: "Kenya" },
  { code: "ZA", label: "South Africa" },
  { code: "SG", label: "Singapore" },
];

// ── User registration ─────────────────────────────────────────────────────────

async function ensureGrailUser(
  walletAddress: string,
  fullName: string,
  country: string,
): Promise<string | null> {
  const key = `grail_uid_${walletAddress}`;
  const cached = localStorage.getItem(key);
  if (cached) return cached;
  try {
    const res = await fetch("/api/grail/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet_address: walletAddress, full_name: fullName, country }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const id = data.grailUserId ?? data.grail_user_id ?? null;
    if (id) localStorage.setItem(key, id);
    return id;
  } catch { return null; }
}

// ── Transaction signing ───────────────────────────────────────────────────────

async function userSignTx(
  b64: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: (input: any) => Promise<any>,
): Promise<string> {
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  const result = await signTransaction({ transaction: tx });
  const signed: Transaction = result?.signedTransaction ?? result;
  return Buffer.from(signed.serialize()).toString("base64");
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-[#A7A79A]">{label}</span>
      <span className={`font-medium ${muted ? "text-[#A7A79A]" : "text-[#F2F0E8]"}`}>{value}</span>
    </div>
  );
}

function TxResult({ hash, error }: { hash?: string; error?: string }) {
  if (hash) return (
    <div className="mt-3 rounded-xl bg-green-900/20 px-3 py-2.5 text-xs text-green-400">
      ✓ Transaction confirmed —{" "}
      <a href={`https://solscan.io/tx/${hash}`} target="_blank" rel="noreferrer" className="underline">
        view on Solscan
      </a>
    </div>
  );
  if (error) return <p className="mt-3 rounded-xl bg-red-900/20 px-3 py-2.5 text-xs text-red-400">{error}</p>;
  return null;
}

// ── Buy tab ───────────────────────────────────────────────────────────────────

function BuyTab({
  grailUserId,
  signTransaction,
}: {
  grailUserId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: (input: any) => Promise<any>;
}) {
  const [usdcInput, setUsdcInput] = useState("10");
  const [slippage, setSlippage] = useState(50);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");

  async function getQuote() {
    setError(""); setQuote(null); setTxHash("");
    const amt = Number(usdcInput);
    if (!amt || amt <= 0) { setError("Enter a valid USDC amount"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/grail/buy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grail_user_id: grailUserId, usdc_amount: amt, slippage_bps: slippage }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Quote failed"); return; }
      setQuote(data);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Quote failed"); }
    finally { setLoading(false); }
  }

  async function confirm() {
    if (!quote) return;
    setSigning(true); setError(""); setTxHash("");
    try {
      const signedB64 = await userSignTx(quote.cosigned_transaction, signTransaction);
      const res = await fetch(`/api/grail/buy/${quote.trade_id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_tx: signedB64 }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Submit failed"); return; }
      setTxHash(data.tx_hash);
      setQuote(null);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Submit failed"); }
    finally { setSigning(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-sm font-medium text-[#A7A79A]">USDC amount</label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-[#A7A79A]">$</span>
          <input
            type="number" min="1" step="1"
            value={usdcInput}
            onChange={(e) => { setUsdcInput(e.target.value); setQuote(null); }}
            className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] py-2.5 pl-8 pr-4 text-sm text-[#F2F0E8] outline-none focus:border-[#C9A84C]"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-[#A7A79A]">
          Slippage tolerance — {slippage / 100}%
        </label>
        <div className="flex gap-2">
          {[25, 50, 100, 200].map((bps) => (
            <button
              key={bps}
              onClick={() => { setSlippage(bps); setQuote(null); }}
              className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${
                slippage === bps ? "bg-[#C9A84C] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A]"
              }`}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      {!quote ? (
        <button
          onClick={getQuote}
          disabled={loading}
          className="w-full rounded-2xl bg-[#C9A84C] py-3 text-sm font-semibold text-[#141513] disabled:opacity-50"
        >
          {loading ? "Getting quote…" : "Get Quote"}
        </button>
      ) : (
        <>
          <div className="rounded-2xl border border-[#2A2B27] bg-[#141513] p-4 flex flex-col gap-2">
            <Row label="You spend" value={`$${fmt(quote.quote.usdc_amount)} USDC`} />
            <Row label="You receive" value={`${fmtGold(quote.quote.gold_amount)} $GOLD`} />
            {quote.quote.min_gold_out != null && (
              <Row label="Min received" value={`${fmtGold(quote.quote.min_gold_out)} $GOLD`} muted />
            )}
            <Row label="Gold price" value={`$${fmt(quote.quote.price_per_troy_oz)}/troy oz`} />
            <Row label="Fee" value={`$${fmt(quote.quote.fee_usd)} (${quote.quote.fee_bps} bps)`} />
          </div>
          <p className="text-center text-xs text-[#A7A79A]">Quote expires in ~60 s — sign promptly</p>
          <div className="flex gap-3">
            <button
              onClick={() => setQuote(null)}
              className="flex-1 rounded-2xl border border-[#2A2B27] py-3 text-sm font-medium text-[#A7A79A]"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={signing}
              className="flex-1 rounded-2xl bg-[#C9A84C] py-3 text-sm font-semibold text-[#141513] disabled:opacity-50"
            >
              {signing ? "Signing…" : "Sign & Buy"}
            </button>
          </div>
        </>
      )}

      <TxResult hash={txHash} error={error} />
    </div>
  );
}

// ── Sell tab ──────────────────────────────────────────────────────────────────

function SellTab({
  grailUserId,
  signTransaction,
}: {
  grailUserId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: (input: any) => Promise<any>;
}) {
  const [goldInput, setGoldInput] = useState("0.005");
  const [slippage, setSlippage] = useState(50);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");

  async function getQuote() {
    setError(""); setQuote(null); setTxHash("");
    const amt = Number(goldInput);
    if (!amt || amt <= 0) { setError("Enter a valid $GOLD amount"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/grail/sell", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grail_user_id: grailUserId, gold_amount: amt, slippage_bps: slippage }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Quote failed"); return; }
      setQuote(data);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Quote failed"); }
    finally { setLoading(false); }
  }

  async function confirm() {
    if (!quote) return;
    setSigning(true); setError(""); setTxHash("");
    try {
      const signedB64 = await userSignTx(quote.cosigned_transaction, signTransaction);
      const res = await fetch(`/api/grail/sell/${quote.trade_id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_tx: signedB64 }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Submit failed"); return; }
      setTxHash(data.tx_hash);
      setQuote(null);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Submit failed"); }
    finally { setSigning(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <label className="mb-1.5 block text-sm font-medium text-[#A7A79A]">$GOLD amount</label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-yellow-500">✦</span>
          <input
            type="number" min="0.0001" step="0.001"
            value={goldInput}
            onChange={(e) => { setGoldInput(e.target.value); setQuote(null); }}
            className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] py-2.5 pl-8 pr-4 text-sm text-[#F2F0E8] outline-none focus:border-[#C9A84C]"
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-xs font-medium text-[#A7A79A]">
          Slippage tolerance — {slippage / 100}%
        </label>
        <div className="flex gap-2">
          {[25, 50, 100, 200].map((bps) => (
            <button
              key={bps}
              onClick={() => { setSlippage(bps); setQuote(null); }}
              className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${
                slippage === bps ? "bg-[#C9A84C] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A]"
              }`}
            >
              {bps / 100}%
            </button>
          ))}
        </div>
      </div>

      {!quote ? (
        <button
          onClick={getQuote}
          disabled={loading}
          className="w-full rounded-2xl bg-[#C9A84C] py-3 text-sm font-semibold text-[#141513] disabled:opacity-50"
        >
          {loading ? "Getting quote…" : "Get Quote"}
        </button>
      ) : (
        <>
          <div className="rounded-2xl border border-[#2A2B27] bg-[#141513] p-4 flex flex-col gap-2">
            <Row label="You sell" value={`${fmtGold(quote.quote.gold_amount)} $GOLD`} />
            <Row label="You receive" value={`$${fmt(quote.quote.usdc_amount)} USDC`} />
            {quote.quote.min_usdc_out != null && (
              <Row label="Min received" value={`$${fmt(quote.quote.min_usdc_out)} USDC`} muted />
            )}
            <Row label="Gold price" value={`$${fmt(quote.quote.price_per_troy_oz)}/troy oz`} />
            <Row label="Fee" value={`$${fmt(quote.quote.fee_usd)} (${quote.quote.fee_bps} bps)`} />
          </div>
          <p className="text-center text-xs text-[#A7A79A]">Quote expires in ~60 s — sign promptly</p>
          <div className="flex gap-3">
            <button
              onClick={() => setQuote(null)}
              className="flex-1 rounded-2xl border border-[#2A2B27] py-3 text-sm font-medium text-[#A7A79A]"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={signing}
              className="flex-1 rounded-2xl bg-[#C9A84C] py-3 text-sm font-semibold text-[#141513] disabled:opacity-50"
            >
              {signing ? "Signing…" : "Sign & Sell"}
            </button>
          </div>
        </>
      )}

      <TxResult hash={txHash} error={error} />
    </div>
  );
}

// ── Redeem tab ────────────────────────────────────────────────────────────────

function RedeemTab({
  grailUserId,
  country,
  signTransaction,
}: {
  grailUserId: string;
  country: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: (input: any) => Promise<any>;
}) {
  const [denominations, setDenominations] = useState<Denomination[]>([]);
  const [loadingDenoms, setLoadingDenoms] = useState(true);
  const [selectedDenom, setSelectedDenom] = useState<Denomination | null>(null);
  const [city, setCity] = useState("");
  const [quote, setQuote] = useState<Redemption | null>(null);
  const [loading, setLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    setLoadingDenoms(true);
    fetch(`/api/grail/denominations?country=${country}`)
      .then((r) => r.json())
      .then((d) => { setDenominations(d.denominations ?? []); })
      .catch(() => {})
      .finally(() => setLoadingDenoms(false));
  }, [country]);

  async function getQuote() {
    if (!selectedDenom) { setError("Select a denomination"); return; }
    if (!city.trim()) { setError("Enter a delivery city"); return; }
    setError(""); setQuote(null); setTxHash("");
    setLoading(true);
    try {
      const res = await fetch("/api/grail/redemptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grail_user_id: grailUserId, denomination_id: selectedDenom.id, city: city.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Quote failed"); return; }
      setQuote(data);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Quote failed"); }
    finally { setLoading(false); }
  }

  async function confirm() {
    if (!quote?.partially_signed_transaction || !quote.redemption_id) return;
    setSigning(true); setError(""); setTxHash("");
    try {
      const signedB64 = await userSignTx(quote.partially_signed_transaction, signTransaction);
      const res = await fetch(`/api/grail/redemptions/${quote.redemption_id}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signed_tx: signedB64 }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Submit failed"); return; }
      setTxHash(data.tx_hash);
      setQuote(null);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Submit failed"); }
    finally { setSigning(false); }
  }

  async function loadHistory() {
    setShowHistory(true);
    try {
      const res = await fetch(`/api/grail/redemptions?grail_user_id=${grailUserId}`);
      const data = await res.json();
      setRedemptions(data.redemptions ?? []);
    } catch { /* ignore */ }
  }

  async function cancelRedemption(id: string) {
    try {
      await fetch(`/api/grail/redemptions/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "User cancelled" }),
      });
      loadHistory();
    } catch { /* ignore */ }
  }

  if (loadingDenoms) return <p className="py-8 text-center text-sm text-[#A7A79A]">Loading available gold…</p>;

  if (!denominations.length) return (
    <div className="py-12 text-center">
      <p className="text-3xl">🚫</p>
      <p className="mt-2 text-sm text-[#A7A79A]">No physical gold redemptions available in your country yet</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-400">
        Redeem your $GOLD tokens for physical gold bars or coins, delivered to your city.
        Only your wallet signature is required — no partner co-sign.
      </div>

      {!quote ? (
        <>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[#A7A79A]">Select denomination</label>
            <div className="flex flex-col gap-2">
              {denominations.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setSelectedDenom(d)}
                  className={`flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors ${
                    selectedDenom?.id === d.id
                      ? "border-[#C9A84C] bg-[#C9A84C]/10"
                      : "border-[#2A2B27] bg-[#141513]"
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium text-[#F2F0E8]">{d.label}</p>
                    <p className="text-xs text-[#A7A79A]">{d.weight_g}g · {d.weight_troy_oz} troy oz</p>
                  </div>
                  <span className="text-xs text-[#A7A79A]">{d.city}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-[#A7A79A]">Delivery city</label>
            <input
              type="text"
              placeholder="e.g. Lagos, London, New York"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] outline-none focus:border-[#C9A84C]"
            />
          </div>

          <button
            onClick={getQuote}
            disabled={loading || !selectedDenom}
            className="w-full rounded-2xl bg-[#C9A84C] py-3 text-sm font-semibold text-[#141513] disabled:opacity-50"
          >
            {loading ? "Getting quote…" : "Get Redemption Quote"}
          </button>

          <button
            onClick={showHistory ? undefined : loadHistory}
            className="text-center text-xs text-[#A7A79A] underline"
          >
            {showHistory ? null : "View past redemptions"}
          </button>

          {showHistory && redemptions.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold text-[#A7A79A] uppercase tracking-wide">Redemption history</p>
              {redemptions.map((r) => (
                <div key={r.redemption_id} className="rounded-xl border border-[#2A2B27] bg-[#141513] p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-[#F2F0E8]">{r.denomination ?? "Gold"}</p>
                      <p className="text-xs text-[#A7A79A]">{r.city} · {r.weight_g}g</p>
                    </div>
                    <span className={`text-xs font-medium capitalize ${statusColor(r.status)}`}>{r.status}</span>
                  </div>
                  {r.status === "pending" && (
                    <button
                      onClick={() => cancelRedemption(r.redemption_id)}
                      className="mt-2 text-xs text-red-400 underline"
                    >
                      Cancel redemption
                    </button>
                  )}
                  {r.submitted_tx_hash && (
                    <a
                      href={`https://solscan.io/tx/${r.submitted_tx_hash}`}
                      target="_blank" rel="noreferrer"
                      className="mt-1 block text-xs text-[#C9A84C] underline truncate"
                    >
                      {r.submitted_tx_hash.slice(0, 24)}…
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}

          {showHistory && redemptions.length === 0 && (
            <p className="text-center text-xs text-[#A7A79A]">No redemptions yet</p>
          )}
        </>
      ) : (
        <>
          <div className="rounded-2xl border border-[#2A2B27] bg-[#141513] p-4 flex flex-col gap-2">
            <Row label="Denomination" value={quote.quote?.denomination ?? selectedDenom?.label ?? "—"} />
            <Row label="Weight" value={`${quote.weight_g ?? selectedDenom?.weight_g}g`} />
            <Row label="Delivery city" value={quote.city ?? city} />
            <Row label="Gold value" value={`$${fmt(quote.quote?.gold_value_usd)} USD`} />
            <Row label="Spot price" value={`$${fmt(quote.quote?.spot_price_usd)}/troy oz`} />
            <Row label="Fee" value={`$${fmt(quote.quote?.fee_usd)}`} />
            <Row label="Tokens required" value={`${quote.quote?.tokens_required ?? "—"} $GOLD`} />
          </div>
          <p className="text-center text-xs text-[#A7A79A]">Sign with your wallet to lock in this redemption</p>
          <div className="flex gap-3">
            <button
              onClick={() => setQuote(null)}
              className="flex-1 rounded-2xl border border-[#2A2B27] py-3 text-sm font-medium text-[#A7A79A]"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={signing || !quote.partially_signed_transaction}
              className="flex-1 rounded-2xl bg-[#C9A84C] py-3 text-sm font-semibold text-[#141513] disabled:opacity-50"
            >
              {signing ? "Signing…" : "Sign & Redeem"}
            </button>
          </div>
        </>
      )}

      <TxResult hash={txHash} error={error} />
    </div>
  );
}

// ── History tab ───────────────────────────────────────────────────────────────

function HistoryTab({ grailUserId }: { grailUserId: string }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "buy" | "sell">("all");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const sp = new URLSearchParams({ grail_user_id: grailUserId, limit: "30" });
      if (filter !== "all") sp.set("side", filter);
      const res = await fetch(`/api/grail/trades?${sp}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to load"); return; }
      setTrades(data.trades ?? []);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, [grailUserId, filter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {(["all", "buy", "sell"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`flex-1 rounded-lg py-1.5 text-xs font-medium capitalize transition-colors ${
              filter === f ? "bg-[#C9A84C] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A]"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {loading && <p className="py-8 text-center text-sm text-[#A7A79A]">Loading…</p>}
      {error && <p className="py-8 text-center text-sm text-red-400">{error}</p>}
      {!loading && !error && !trades.length && (
        <div className="py-12 text-center">
          <p className="text-3xl">✦</p>
          <p className="mt-2 text-sm text-[#A7A79A]">No gold trades yet</p>
        </div>
      )}
      {trades.map((t) => (
        <div key={t.trade_id} className="rounded-2xl border border-[#2A2B27] bg-[#141513] p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-lg">{t.side === "buy" ? "🟡" : "💵"}</span>
              <div>
                <p className="text-sm font-semibold text-[#F2F0E8] capitalize">{t.side} $GOLD</p>
                <p className="text-xs text-[#A7A79A]">{new Date(t.created_at).toLocaleDateString()}</p>
              </div>
            </div>
            <span className={`text-xs font-medium capitalize ${statusColor(t.status)}`}>{t.status}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-[#A7A79A]">
            <span>${fmt(t.usdc_amount)} USDC</span>
            <span>↔</span>
            <span>{fmtGold(t.gold_amount)} $GOLD</span>
            <span>@ ${fmt(t.price_per_troy_oz)}/oz</span>
          </div>
          {t.submitted_tx_hash && (
            <a
              href={`https://solscan.io/tx/${t.submitted_tx_hash}`}
              target="_blank" rel="noreferrer"
              className="mt-1 block text-xs text-[#C9A84C] underline truncate"
            >
              {t.submitted_tx_hash.slice(0, 24)}…
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

export function GrailSection() {
  const { user } = usePrivy();
  const { signTransaction } = useSignTransaction();
  const [tab, setTab] = useState<Tab>("buy");
  const [grailUserId, setGrailUserId] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [regError, setRegError] = useState("");
  const [country, setCountry] = useState("PK");
  const [countryChosen, setCountryChosen] = useState(false);
  const [goldPrice, setGoldPrice] = useState<number | null>(null);

  const solanaAddress = (user?.linkedAccounts?.find(
    (a) => a.type === "wallet" && (a as { chainType?: string }).chainType === "solana",
  ) as { address?: string } | undefined)?.address ?? "";

  const displayName =
    user?.google?.name ??
    user?.email?.address ??
    "Bluvfi User";

  useEffect(() => {
    if (!solanaAddress || !countryChosen) return;
    setRegistering(true);
    ensureGrailUser(solanaAddress, displayName, country)
      .then((id) => {
        if (id) setGrailUserId(id);
        else setRegError("Could not register gold account. Please try again.");
      })
      .finally(() => setRegistering(false));
  }, [solanaAddress, displayName, country, countryChosen]);

  // Fetch live gold price once registered
  useEffect(() => {
    if (!grailUserId) return;
    fetch("/api/grail/buy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grail_user_id: grailUserId, usdc_amount: 10 }),
    })
      .then((r) => r.json())
      .then((d) => { if (d?.quote?.price_per_troy_oz) setGoldPrice(d.quote.price_per_troy_oz); })
      .catch(() => {});
  }, [grailUserId]);

  if (!solanaAddress) return (
    <div className="py-12 text-center">
      <p className="text-3xl">🔗</p>
      <p className="mt-2 text-sm text-[#A7A79A]">Connect a Solana wallet to trade gold</p>
    </div>
  );

  // Country selection step
  if (!countryChosen) return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl bg-gradient-to-br from-[#C9A84C]/20 to-[#1B1C19] border border-[#C9A84C]/30 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#C9A84C]/20 text-2xl">✦</div>
          <div>
            <p className="font-semibold text-[#F2F0E8]">Oro GRAIL Gold</p>
            <p className="text-xs text-[#A7A79A]">Select your country to get started</p>
          </div>
        </div>
      </div>
      <div>
        <label className="mb-1.5 block text-sm font-medium text-[#A7A79A]">Your country</label>
        <select
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] outline-none focus:border-[#C9A84C]"
        >
          {COUNTRY_OPTIONS.map((c) => (
            <option key={c.code} value={c.code}>{c.label}</option>
          ))}
        </select>
      </div>
      <button
        onClick={() => setCountryChosen(true)}
        className="w-full rounded-2xl bg-[#C9A84C] py-3 text-sm font-semibold text-[#141513]"
      >
        Continue
      </button>
    </div>
  );

  if (registering) return (
    <div className="py-12 text-center">
      <p className="text-sm text-[#A7A79A]">Setting up your gold account…</p>
    </div>
  );

  if (regError || !grailUserId) return (
    <div className="py-12 text-center flex flex-col gap-3 items-center">
      <p className="text-sm text-red-400">{regError || "Failed to set up gold account"}</p>
      <button
        onClick={() => { setRegError(""); setCountryChosen(false); }}
        className="text-xs text-[#C9A84C] underline"
      >
        Try again
      </button>
    </div>
  );

  const TABS: { key: Tab; label: string }[] = [
    { key: "buy", label: "Buy" },
    { key: "sell", label: "Sell" },
    { key: "redeem", label: "Redeem" },
    { key: "history", label: "History" },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Header with live price */}
      <div className="rounded-2xl bg-gradient-to-br from-[#C9A84C]/20 to-[#1B1C19] border border-[#C9A84C]/30 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#C9A84C]/20 text-2xl">✦</div>
            <div>
              <p className="font-semibold text-[#F2F0E8]">Oro GRAIL Gold</p>
              <p className="text-xs text-[#A7A79A]">Buy · Sell · Redeem · Solana</p>
            </div>
          </div>
          {goldPrice != null && (
            <div className="text-right">
              <p className="text-xs text-[#A7A79A]">Gold price</p>
              <p className="font-semibold text-[#C9A84C]">${fmt(goldPrice)}<span className="text-xs font-normal text-[#A7A79A]">/oz</span></p>
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-full py-2 text-xs font-medium transition-colors ${
              tab === t.key
                ? "bg-[#C9A84C] text-[#141513]"
                : "bg-white/[0.06] text-[#A7A79A]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "buy"     && <BuyTab grailUserId={grailUserId} signTransaction={signTransaction} />}
      {tab === "sell"    && <SellTab grailUserId={grailUserId} signTransaction={signTransaction} />}
      {tab === "redeem"  && <RedeemTab grailUserId={grailUserId} country={country} signTransaction={signTransaction} />}
      {tab === "history" && <HistoryTab grailUserId={grailUserId} />}
    </div>
  );
}
