"use client";

import { useState, useCallback, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import { createPortal } from "react-dom";
import { usePrivy } from "@privy-io/react-auth";
import type { ProviderMeta } from "@/lib/banking/registry";
import type { BankingTransaction, ProviderBalance, TransactionStatus } from "@/lib/banking/types";
import { FuzeSection } from "./fuze-section";

// ── Status pill ───────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<TransactionStatus, string> = {
  completed:  "bg-sage/15 text-sage",
  processing: "bg-blue-500/15 text-blue-400",
  pending:    "bg-amber-500/15 text-amber-400",
  initiated:  "bg-border/60 text-ink-light",
  failed:     "bg-fail/15 text-fail",
  expired:    "bg-fail/10 text-fail/70",
};

function StatusPill({ status }: { status: TransactionStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 font-mono text-[9px] capitalize ${STATUS_STYLE[status] ?? "bg-border/60 text-ink-light"}`}>
      {status}
    </span>
  );
}

// ── Shared field input ────────────────────────────────────────────────────────

function Field({ label, type = "text", placeholder, value, onChange, required, min }: {
  label: string; type?: string; placeholder?: string; value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  required?: boolean; min?: number;
}) {
  return (
    <div>
      <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">{label}</label>
      <input type={type} placeholder={placeholder} value={value} onChange={onChange} required={required} min={min}
        className="mt-1.5 w-full rounded-xl border border-border bg-cream-dark/40 px-4 py-3 font-body text-sm text-ink placeholder:text-ink-light/40 outline-none focus:border-sage/50" />
    </div>
  );
}

// ── Modal shell ───────────────────────────────────────────────────────────────

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-t-2xl border-t border-border bg-cream px-5 pb-[max(env(safe-area-inset-bottom),24px)] pt-4">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-border" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ── Coming soon placeholder ───────────────────────────────────────────────────

function ComingSoon({ icon, title, description }: { icon: string; title: string; description: string }) {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <span className="text-5xl">{icon}</span>
      <p className="mt-4 font-display text-lg text-ink">{title}</p>
      <p className="mt-2 max-w-xs font-body text-sm text-ink-light">{description}</p>
    </div>
  );
}

// ── Receive modal ─────────────────────────────────────────────────────────────

function ReceiveModal({
  provider, onClose, onSuccess,
}: {
  provider: ProviderMeta; onClose: () => void; onSuccess: (tx: BankingTransaction) => void;
}) {
  const [step, setStep] = useState<"form" | "qr">("form");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tx, setTx] = useState<BankingTransaction | null>(null);
  const [pollStatus, setPollStatus] = useState<TransactionStatus | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amtNum = Number(amount);
    if (!amtNum || amtNum < provider.minCollectionAmount) {
      setError(`Minimum amount is ${provider.currencySymbol}${provider.minCollectionAmount}`);
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/banking/${provider.id}/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amtNum, description: description.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to create payment request");
      setTx(data as BankingTransaction);
      setStep("qr");
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (step !== "qr" || !tx) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/banking/${provider.id}/collections?id=${tx.id}`);
        if (!res.ok) return;
        const data: BankingTransaction = await res.json();
        if (!stopped) {
          setPollStatus(data.status);
          if (data.status === "completed" || data.status === "failed" || data.status === "expired") {
            onSuccess({ ...tx, ...data });
          }
        }
      } catch { /* ignore */ }
    };
    const interval = setInterval(poll, 5000);
    poll();
    return () => { stopped = true; clearInterval(interval); };
  }, [step, tx, provider.id, onSuccess]);

  const isTerminal = pollStatus === "completed" || pollStatus === "failed" || pollStatus === "expired";
  const qrValue = tx?.upiIntent ?? "";

  return (
    <ModalShell onClose={onClose}>
      {step === "form" && (
        <>
          <h2 className="font-display text-xl text-ink">Receive Money</h2>
          <p className="mt-1 font-body text-sm text-ink-light">UPI collection via {provider.name}</p>
          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <Field
              label={`Amount (${provider.currencySymbol} ${provider.currency}) · min ${provider.currencySymbol}${provider.minCollectionAmount}`}
              type="number" min={provider.minCollectionAmount} value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={`e.g. ${provider.minCollectionAmount * 3}`} required
            />
            <Field label="Description (optional)" value={description}
              onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Invoice #123" />
            {error && <p className="font-body text-sm text-fail">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full rounded-xl bg-sage py-3.5 font-mono text-sm font-semibold text-cream transition-opacity disabled:opacity-50">
              {loading ? "Creating…" : "Generate QR"}
            </button>
          </form>
        </>
      )}
      {step === "qr" && tx && (
        <div className="flex flex-col items-center gap-4">
          <div className="flex w-full items-center">
            <button onClick={() => setStep("form")} className="font-mono text-xs text-ink-light hover:text-ink mr-auto">← Back</button>
            <h2 className="font-display text-xl text-ink mx-auto pr-8">Scan to Pay</h2>
          </div>
          <p className="font-body text-sm text-ink-light text-center">Scan in any UPI-compatible app. Polling for confirmation…</p>
          <div className="rounded-2xl border border-border bg-white p-4">
            {tx.qrCode ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={tx.qrCode} alt="Payment QR" className="h-48 w-48" />
            ) : qrValue ? (
              <QRCodeSVG value={qrValue} size={192} bgColor="#ffffff" fgColor="#141513" />
            ) : tx.redirectUrl ? (
              <div className="flex h-48 w-48 items-center justify-center">
                <a href={tx.redirectUrl} target="_blank" rel="noopener noreferrer"
                  className="rounded-xl bg-sage px-4 py-2.5 font-mono text-sm font-semibold text-cream">
                  Open Payment Page ↗
                </a>
              </div>
            ) : (
              <div className="flex h-48 w-48 items-center justify-center">
                <p className="text-center font-body text-xs text-ink-light">QR unavailable</p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="font-display text-2xl text-ink">{provider.currencySymbol}{tx.amount.toLocaleString()}</span>
            {pollStatus && <StatusPill status={pollStatus} />}
          </div>
          {qrValue && (
            <a href={qrValue} className="rounded-xl border border-sage/30 px-4 py-2 font-mono text-xs text-sage transition-colors hover:bg-sage/10">
              Open in Payment App
            </a>
          )}
          {isTerminal ? (
            <button onClick={onClose} className="w-full rounded-xl bg-sage py-3 font-mono text-sm font-semibold text-cream">
              {pollStatus === "completed" ? "Done ✓" : "Close"}
            </button>
          ) : (
            <p className="animate-pulse font-mono text-xs text-ink-light">Waiting for payment…</p>
          )}
        </div>
      )}
    </ModalShell>
  );
}

// ── Transfer modal (collection → payout wallet) ───────────────────────────────

function TransferModal({ provider, onClose, onSuccess }: {
  provider: ProviderMeta; onClose: () => void; onSuccess: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ afterCollectionBalance: number; afterPayoutBalance: number } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amtNum = Number(amount);
    if (!amtNum || amtNum <= 0) { setError("Enter a valid amount"); return; }
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/banking/${provider.id}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amtNum, currency: provider.currency }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Transfer failed");
      setResult(data);
      onSuccess();
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      {result ? (
        <div className="flex flex-col items-center gap-4 py-6">
          <span className="text-5xl">⇄</span>
          <h2 className="font-display text-xl text-ink">Transfer Complete</h2>
          <div className="w-full rounded-2xl border border-border/60 bg-cream-dark/30 p-4 space-y-2">
            <div className="flex justify-between font-mono text-sm">
              <span className="text-ink-light">Collection wallet</span>
              <span className="text-ink">{provider.currencySymbol}{result.afterCollectionBalance.toLocaleString()}</span>
            </div>
            <div className="flex justify-between font-mono text-sm">
              <span className="text-ink-light">Payout wallet</span>
              <span className="text-ink">{provider.currencySymbol}{result.afterPayoutBalance.toLocaleString()}</span>
            </div>
          </div>
          <button onClick={onClose} className="w-full rounded-xl bg-sage py-3 font-mono text-sm font-semibold text-cream">Done</button>
        </div>
      ) : (
        <>
          <h2 className="font-display text-xl text-ink">Transfer to Payout</h2>
          <p className="mt-1 font-body text-sm text-ink-light">Move funds from collection wallet to payout wallet</p>
          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
            <Field label={`Amount (${provider.currencySymbol} ${provider.currency})`} type="number" min={1}
              placeholder="e.g. 1000" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            {error && <p className="font-body text-sm text-fail">{error}</p>}
            <button type="submit" disabled={loading}
              className="w-full rounded-xl bg-sage py-3.5 font-mono text-sm font-semibold text-cream transition-opacity disabled:opacity-50">
              {loading ? "Transferring…" : "Transfer Funds"}
            </button>
          </form>
        </>
      )}
    </ModalShell>
  );
}

// ── Ledger list (used inside Collection tab) ──────────────────────────────────

interface LedgerEntry {
  id: string;
  type: string;
  amount: number;
  currency: string;
  status: string;
  created_at?: string;
  description?: string;
}

function LedgerList({ provider }: { provider: ProviderMeta }) {
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 20;

  const fetchLedger = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/banking/${provider.id}/ledger?page=${p}&limit=${limit}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to load ledger");
      setEntries(data.data ?? []);
      setTotalCount(data.totalCount ?? 0);
    } catch (err: any) {
      setError(err?.message ?? "Could not load ledger");
    } finally {
      setLoading(false);
    }
  }, [provider.id]);

  useEffect(() => { fetchLedger(page); }, [fetchLedger, page]);

  if (loading) return (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-2xl border border-border/60 bg-cream-dark/30" />)}
    </div>
  );

  if (error) return (
    <div className="py-8 text-center">
      <p className="text-sm text-ink-light">{error}</p>
      <button onClick={() => fetchLedger(page)} className="mt-3 rounded-xl border border-border/60 px-4 py-2 font-mono text-xs text-ink-light hover:text-ink">Retry</button>
    </div>
  );

  if (entries.length === 0) return (
    <div className="py-8 text-center">
      <p className="text-3xl">📒</p>
      <p className="mt-2 text-sm text-ink-light">No ledger entries yet</p>
    </div>
  );

  const totalPages = Math.ceil(totalCount / limit);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-cream-dark/30 p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-body text-sm font-semibold text-ink capitalize">
                {entry.description ?? entry.type.replace(/_/g, " ")}
              </p>
              <p className="font-mono text-[10px] text-ink-light">
                {entry.created_at
                  ? new Date(entry.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                  : entry.id}
                {" · "}<span className="capitalize">{entry.status}</span>
              </p>
            </div>
            <p className={`shrink-0 font-mono text-sm font-semibold ${entry.type?.includes("credit") || entry.type?.includes("collection") ? "text-sage" : "text-ink"}`}>
              {provider.currencySymbol}{entry.amount.toLocaleString()}
            </p>
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="rounded-xl border border-border/60 px-3 py-1.5 font-mono text-xs text-ink-light hover:text-ink disabled:opacity-40">
            ← Prev
          </button>
          <span className="font-mono text-[10px] text-ink-light">{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}
            className="rounded-xl border border-border/60 px-3 py-1.5 font-mono text-xs text-ink-light hover:text-ink disabled:opacity-40">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

// ── Collection tab ────────────────────────────────────────────────────────────

type CollectionSubTab = "payments" | "ledger";

function CollectionTabFull({ provider }: { provider: ProviderMeta }) {
  const [balance, setBalance] = useState<ProviderBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<BankingTransaction[]>([]);
  const [loadingBalance, setLoadingBalance] = useState(true);
  const [loadingTx, setLoadingTx] = useState(true);
  const [subTab, setSubTab] = useState<CollectionSubTab>("payments");
  const [showReceive, setShowReceive] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

  const fetchBalance = useCallback(async () => {
    setLoadingBalance(true);
    try {
      const res = await fetch(`/api/banking/${provider.id}/balance`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed");
      setBalance(data as ProviderBalance);
      setBalanceError(null);
    } catch (err: any) {
      setBalanceError(err?.message ?? "Could not load balance");
    } finally {
      setLoadingBalance(false);
    }
  }, [provider.id]);

  const fetchTransactions = useCallback(async () => {
    setLoadingTx(true);
    try {
      const res = await fetch(`/api/banking/${provider.id}/collections`);
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      setTransactions(Array.isArray(data) ? data : []);
    } catch { /* silently fail */ } finally {
      setLoadingTx(false);
    }
  }, [provider.id]);

  useEffect(() => {
    fetchBalance();
    fetchTransactions();
  }, [fetchBalance, fetchTransactions]);

  const handleCollectionSuccess = useCallback((tx: BankingTransaction) => {
    setTransactions((prev) => [tx, ...prev.filter((x) => x.id !== tx.id)]);
    fetchBalance();
    setShowReceive(false);
  }, [fetchBalance]);

  const collections = transactions.filter((t) => t.type === "collection");

  return (
    <div className="flex flex-col gap-4">
      {/* Balance card */}
      <div className="rounded-3xl bg-[#8FAE82] p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-[#141513]/70">Collection Balance</p>
            {loadingBalance ? (
              <div className="mt-1 h-9 w-32 animate-pulse rounded-lg bg-[#141513]/10" />
            ) : balanceError ? (
              <div>
                <p className="mt-1 font-display text-2xl text-[#141513]/60">—</p>
                <p className="mt-0.5 font-mono text-[10px] text-[#141513]/50">{balanceError}</p>
              </div>
            ) : (
              <p className="mt-1 font-display text-3xl font-bold text-[#141513]">
                {provider.currencySymbol}
                {(balance?.amount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </p>
            )}
            <p className="mt-0.5 font-mono text-[10px] text-[#141513]/60 uppercase tracking-wide">
              {provider.currency} · Collection Wallet
            </p>
          </div>
          <span className="text-2xl">{provider.flag}</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => setShowReceive(true)}
            className="flex flex-col items-center gap-1 rounded-xl bg-[#141513] py-2.5 font-mono text-[10px] font-semibold text-[#F2F0E8]">
            <span className="text-base leading-none">↓</span>
            Receive
          </button>
          <button onClick={() => setShowTransfer(true)}
            className="flex flex-col items-center gap-1 rounded-xl bg-[#141513]/20 py-2.5 font-mono text-[10px] font-semibold text-[#141513]">
            <span className="text-base leading-none">⇄</span>
            Transfer
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 rounded-xl border border-border/60 bg-cream-dark/20 p-1">
        {(["payments", "ledger"] as CollectionSubTab[]).map((t) => (
          <button key={t} onClick={() => setSubTab(t)}
            className={`flex-1 rounded-lg py-2 font-mono text-xs font-semibold capitalize transition-colors ${
              subTab === t ? "bg-cream shadow-sm text-ink" : "text-ink-light hover:text-ink"
            }`}>
            {t}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      {subTab === "payments" && (
        loadingTx ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl border border-border/60 bg-cream-dark/30" />)}
          </div>
        ) : collections.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-3xl">📥</p>
            <p className="mt-2 font-semibold text-ink">No collections yet</p>
            <p className="mt-1 text-sm text-ink-light">Tap <strong>Receive</strong> to create a payment request</p>
          </div>
        ) : (
          <div className="space-y-2">
            {collections.map((tx) => (
              <div key={tx.id} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-cream-dark/30 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-lg">
                  {tx.status === "completed" ? "✅" : tx.status === "failed" || tx.status === "expired" ? "❌" : "⏳"}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-body text-sm font-semibold text-ink">
                    {tx.description ?? `Collection …${tx.id.slice(-6)}`}
                  </p>
                  <p className="font-mono text-[10px] text-ink-light">
                    {tx.createdAt
                      ? new Date(tx.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                      : tx.merchantReferenceId}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-mono text-sm font-semibold text-ink">
                    {provider.currencySymbol}{tx.amount.toLocaleString()}
                  </p>
                  <StatusPill status={tx.status} />
                </div>
              </div>
            ))}
          </div>
        )
      )}
      {subTab === "ledger" && <LedgerList provider={provider} />}

      {showReceive && (
        <ReceiveModal provider={provider} onClose={() => setShowReceive(false)} onSuccess={handleCollectionSuccess} />
      )}
      {showTransfer && (
        <TransferModal provider={provider} onClose={() => setShowTransfer(false)} onSuccess={fetchBalance} />
      )}
    </div>
  );
}

// ── Payout tab ────────────────────────────────────────────────────────────────

function PayoutTab({ provider: _provider }: { provider: ProviderMeta }) {
  return (
    <ComingSoon
      icon="💸"
      title="Payout"
      description="Send money to bank accounts worldwide. Coming soon."
    />
  );
}

// ── Payout tab types (unused until payout is live) ────────────────────────────

interface RemBalance { balance: number; currency: string; total_credit_limit: number; consumed_credit: number; available_credit: number; }
interface FxRateData { fx_rate: number; input_currency: string; output_currency: string; }
interface DepositAddr { address: string; currency: string; blockchain: string; chain: string; }
interface DepositEntry { amount: number; blockchain: string; blockchain_txid: string; created: number; currency: string; source_address: string; }
interface PayoutEntry { payout_id: string; merchant_payout_id: string; account_holder_name: string; account_number?: string; upi_id?: string; amount: number; currency: string; status: string; fees_amount?: number; transaction_reference_no?: string; payout_method?: string; created: number; }

type PayoutCurrency = "INR" | "IDR" | "PHP" | "VND";
type InrMethod = "bank" | "upi";

const PAYOUT_CURRENCY_INFO: Record<PayoutCurrency, { flag: string; label: string; description: string }> = {
  INR: { flag: "🇮🇳", label: "India (INR)", description: "Bank transfer or UPI" },
  IDR: { flag: "🇮🇩", label: "Indonesia (IDR)", description: "Bank transfer" },
  PHP: { flag: "🇵🇭", label: "Philippines (PHP)", description: "Bank transfer" },
  VND: { flag: "🇻🇳", label: "Vietnam (VND)", description: "Bank transfer" },
};

// ── Validate bank account ─────────────────────────────────────────────────────

function ValidateAccountButton({ provider, accountNumber, ifsc, accountHolderName, currency, onResult }: {
  provider: ProviderMeta;
  accountNumber: string; ifsc: string; accountHolderName: string; currency: string;
  onResult: (result: { status: string; nameFromBank?: string; failureReason?: string }) => void;
}) {
  const [loading, setLoading] = useState(false);
  const ready = accountNumber.trim() && ifsc.trim() && accountHolderName.trim();

  const handleValidate = async () => {
    if (!ready) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/banking/${provider.id}/payout/validate-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: currency.toLowerCase(), account_number: accountNumber, ifsc, account_holder_name: accountHolderName }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Validation failed");
      onResult({ status: data.status, nameFromBank: data.account_holder_name_from_bank, failureReason: data.failure_reason });
    } catch (err: any) {
      onResult({ status: "failed", failureReason: err?.message ?? "Could not validate" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <button type="button" onClick={handleValidate} disabled={!ready || loading}
      className="rounded-xl border border-sage/30 px-3 py-2 font-mono text-xs text-sage transition-colors hover:bg-sage/10 disabled:opacity-40">
      {loading ? "Validating…" : "Verify Account"}
    </button>
  );
}

// ── Send payout modal ─────────────────────────────────────────────────────────

function SendPayoutModal({ provider, onClose, onSuccess }: {
  provider: ProviderMeta; onClose: () => void; onSuccess: () => void;
}) {
  const [step, setStep] = useState<"currency" | "details" | "done">("currency");
  const [currency, setCurrency] = useState<PayoutCurrency>("INR");
  const [inrMethod, setInrMethod] = useState<InrMethod>("bank");

  // Common fields
  const [amount, setAmount] = useState("");
  const [accountHolderName, setAccountHolderName] = useState("");

  // INR bank fields
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [purpose, setPurpose] = useState<"crypto_offramp" | "trade_finance">("crypto_offramp");

  // INR UPI fields
  const [upiId, setUpiId] = useState("");

  // Cross-border fields
  const [bankName, setBankName] = useState("");
  const [bankCode, setBankCode] = useState("");
  const [senderCustomerId, setSenderCustomerId] = useState("");
  const [receiverCustomerId, setReceiverCustomerId] = useState("");

  // Validation
  const [validation, setValidation] = useState<{ status: string; nameFromBank?: string; failureReason?: string } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ payout_id: string; status: string; after_balance: number } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amtNum = Number(amount);
    if (!amtNum || amtNum <= 0) { setError("Enter a valid amount"); return; }
    if (!accountHolderName.trim()) { setError("Account holder name is required"); return; }
    setError(null);
    setSubmitting(true);

    const body: Record<string, unknown> = { currency: currency.toLowerCase(), amount: amtNum, account_holder_name: accountHolderName.trim() };

    if (currency === "INR") {
      body.purpose = purpose;
      if (inrMethod === "bank") {
        if (!accountNumber.trim() || !ifsc.trim()) { setError("Account number and IFSC are required"); setSubmitting(false); return; }
        body.account_number = accountNumber.trim();
        body.ifsc = ifsc.trim();
      } else {
        if (!upiId.trim()) { setError("UPI ID is required"); setSubmitting(false); return; }
        body.upi_id = upiId.trim();
      }
    } else {
      if (!accountNumber.trim()) { setError("Account number is required"); setSubmitting(false); return; }
      if (!bankName.trim() || !bankCode.trim()) { setError("Bank name and bank code are required"); setSubmitting(false); return; }
      if (!senderCustomerId.trim() && !receiverCustomerId.trim()) { setError("At least one of sender or receiver customer ID is required"); setSubmitting(false); return; }
      body.account_number = accountNumber.trim();
      body.bank_name = bankName.trim();
      body.bank_code = bankCode.trim();
      if (senderCustomerId.trim()) body.sender_customer_id = senderCustomerId.trim();
      if (receiverCustomerId.trim()) body.receiver_customer_id = receiverCustomerId.trim();
    }

    try {
      const res = await fetch(`/api/banking/${provider.id}/payout/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Payout failed");
      setResult({ payout_id: data.payout_id, status: data.status, after_balance: data.after_balance });
      setStep("done");
      onSuccess();
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  const info = PAYOUT_CURRENCY_INFO[currency];

  return (
    <ModalShell onClose={onClose}>
      {step === "currency" && (
        <>
          <h2 className="font-display text-xl text-ink">Send Payout</h2>
          <p className="mt-1 font-body text-sm text-ink-light">Select destination currency</p>
          <div className="mt-5 space-y-2">
            {(Object.keys(PAYOUT_CURRENCY_INFO) as PayoutCurrency[]).map((cur) => {
              const ci = PAYOUT_CURRENCY_INFO[cur];
              return (
                <button key={cur} type="button" onClick={() => { setCurrency(cur); setStep("details"); }}
                  className="flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-cream-dark/30 p-4 text-left transition-colors hover:border-sage/30 hover:bg-sage/5">
                  <span className="text-2xl">{ci.flag}</span>
                  <div>
                    <p className="font-mono text-sm font-semibold text-ink">{ci.label}</p>
                    <p className="font-mono text-[10px] text-ink-light">{ci.description}</p>
                  </div>
                  <span className="ml-auto font-mono text-xs text-ink-light">→</span>
                </button>
              );
            })}
          </div>
        </>
      )}

      {step === "details" && (
        <>
          <button onClick={() => setStep("currency")} className="mb-2 font-mono text-xs text-ink-light hover:text-ink">
            ← Back
          </button>
          <h2 className="font-display text-xl text-ink">Send {currency}</h2>
          <p className="mt-1 font-body text-sm text-ink-light">{info.flag} {info.label}</p>

          <form onSubmit={handleSubmit} className="mt-5 space-y-3">
            <Field label={`Amount (${currency})`} type="number" min={1}
              placeholder={currency === "INR" ? "e.g. 500" : currency === "IDR" ? "e.g. 50000" : "e.g. 100"}
              value={amount} onChange={(e) => setAmount(e.target.value)} required />

            <Field label="Account Holder Name" placeholder="Full name as on bank account"
              value={accountHolderName} onChange={(e) => setAccountHolderName(e.target.value)} required />

            {currency === "INR" && (
              <>
                {/* INR method toggle */}
                <div>
                  <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Payment Method</label>
                  <div className="mt-1.5 flex gap-1 rounded-xl border border-border/60 bg-cream-dark/20 p-1">
                    {(["bank", "upi"] as InrMethod[]).map((m) => (
                      <button key={m} type="button" onClick={() => setInrMethod(m)}
                        className={`flex-1 rounded-lg py-2 font-mono text-xs font-semibold transition-colors ${
                          inrMethod === m ? "bg-cream shadow-sm text-ink" : "text-ink-light hover:text-ink"
                        }`}>
                        {m === "bank" ? "Bank Transfer" : "UPI"}
                      </button>
                    ))}
                  </div>
                </div>

                {inrMethod === "bank" && (
                  <>
                    <Field label="Account Number" placeholder="e.g. 12345678901234"
                      value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} required />
                    <Field label="IFSC Code" placeholder="e.g. SBIN0001234"
                      value={ifsc} onChange={(e) => setIfsc(e.target.value)} required />
                    {validation && (
                      <div className={`rounded-xl p-3 font-mono text-xs ${validation.status === "completed" ? "bg-sage/10 text-sage" : "bg-fail/10 text-fail"}`}>
                        {validation.status === "completed"
                          ? `✓ Verified · ${validation.nameFromBank ?? "account valid"}`
                          : `✗ ${validation.failureReason ?? "Validation failed"}`}
                      </div>
                    )}
                    <ValidateAccountButton
                      provider={provider}
                      accountNumber={accountNumber} ifsc={ifsc} accountHolderName={accountHolderName}
                      currency="inr"
                      onResult={setValidation}
                    />
                  </>
                )}
                {inrMethod === "upi" && (
                  <Field label="UPI ID" placeholder="e.g. name@bank"
                    value={upiId} onChange={(e) => setUpiId(e.target.value)} required />
                )}

                <div>
                  <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Purpose</label>
                  <select value={purpose} onChange={(e) => setPurpose(e.target.value as typeof purpose)}
                    className="mt-1.5 w-full rounded-xl border border-border bg-cream-dark/40 px-4 py-3 font-mono text-sm text-ink outline-none focus:border-sage/50">
                    <option value="crypto_offramp">Crypto Offramp</option>
                    <option value="trade_finance">Trade Finance</option>
                  </select>
                </div>
              </>
            )}

            {(currency === "IDR" || currency === "PHP" || currency === "VND") && (
              <>
                <Field label="Account Number" placeholder="Bank account number"
                  value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} required />
                <Field label="Bank Name" placeholder="e.g. Bank Central Asia"
                  value={bankName} onChange={(e) => setBankName(e.target.value)} required />
                <Field label="Bank Code" placeholder="e.g. BCA"
                  value={bankCode} onChange={(e) => setBankCode(e.target.value)} required />
                <p className="font-mono text-[10px] text-ink-light uppercase tracking-wide">Customer IDs (at least one required)</p>
                <Field label="Sender Customer ID (optional)" placeholder="Your registered customer ID"
                  value={senderCustomerId} onChange={(e) => setSenderCustomerId(e.target.value)} />
                <Field label="Receiver Customer ID (optional)" placeholder="Recipient's customer ID"
                  value={receiverCustomerId} onChange={(e) => setReceiverCustomerId(e.target.value)} />
              </>
            )}

            {error && <p className="font-body text-sm text-fail">{error}</p>}

            <button type="submit" disabled={submitting}
              className="w-full rounded-xl bg-sage py-3.5 font-mono text-sm font-semibold text-cream transition-opacity disabled:opacity-50">
              {submitting ? "Sending…" : `Send ${currency} Payout`}
            </button>
          </form>
        </>
      )}

      {step === "done" && result && (
        <div className="flex flex-col items-center gap-4 py-4">
          <span className="text-5xl">💸</span>
          <h2 className="font-display text-xl text-ink">Payout Initiated</h2>
          <div className="w-full rounded-2xl border border-border/60 bg-cream-dark/30 p-4 space-y-2">
            <div className="flex justify-between font-mono text-sm">
              <span className="text-ink-light">Payout ID</span>
              <span className="text-ink text-right text-[10px] break-all">{result.payout_id}</span>
            </div>
            <div className="flex justify-between font-mono text-sm">
              <span className="text-ink-light">Status</span>
              <span className="capitalize text-amber-400">{result.status}</span>
            </div>
            <div className="flex justify-between font-mono text-sm">
              <span className="text-ink-light">Remaining balance</span>
              <span className="text-ink">${result.after_balance.toFixed(2)}</span>
            </div>
          </div>
          <p className="font-mono text-[10px] text-ink-light text-center">You&apos;ll be notified via webhook when the payout completes</p>
          <button onClick={onClose} className="w-full rounded-xl bg-sage py-3 font-mono text-sm font-semibold text-cream">Done</button>
        </div>
      )}
    </ModalShell>
  );
}

// ── Deposit address modal ─────────────────────────────────────────────────────

function DepositAddressModal({ provider, onClose }: { provider: ProviderMeta; onClose: () => void }) {
  const [currency, setCurrency] = useState("USDT");
  const [blockchain, setBlockchain] = useState("ethereum");
  const [addresses, setAddresses] = useState<DepositAddr[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const fetchAddress = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/banking/${provider.id}/payout/deposit-address?currency=${currency}&blockchain=${blockchain}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to fetch address");
      setAddresses(Array.isArray(data) ? data : [data]);
    } catch (err: any) {
      setError(err?.message ?? "Could not load deposit address");
    } finally {
      setLoading(false);
    }
  }, [provider.id, currency, blockchain]);

  useEffect(() => { fetchAddress(); }, [fetchAddress]);

  const copyToClipboard = (addr: string) => {
    navigator.clipboard.writeText(addr).then(() => { setCopied(addr); setTimeout(() => setCopied(null), 2000); });
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="font-display text-xl text-ink">Deposit Address</h2>
      <p className="mt-1 font-body text-sm text-ink-light">Fund your payout wallet by depositing crypto</p>

      <div className="mt-5 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Currency</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-border bg-cream-dark/40 px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-sage/50">
              <option value="USDT">USDT</option>
              <option value="USDC">USDC</option>
            </select>
          </div>
          <div>
            <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Network</label>
            <select value={blockchain} onChange={(e) => setBlockchain(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-border bg-cream-dark/40 px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-sage/50">
              <option value="ethereum">Ethereum</option>
              <option value="tron">Tron (TRC20)</option>
              <option value="bsc">BSC (BEP20)</option>
              <option value="polygon">Polygon</option>
            </select>
          </div>
        </div>

        {loading && <div className="h-16 animate-pulse rounded-2xl border border-border/60 bg-cream-dark/30" />}
        {error && <p className="font-body text-sm text-fail">{error}</p>}

        {!loading && addresses.length > 0 && addresses.map((a, i) => (
          <div key={i} className="rounded-2xl border border-border/60 bg-cream-dark/30 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] text-ink-light uppercase tracking-wide">{a.blockchain} · {a.currency}</span>
              <button onClick={() => copyToClipboard(a.address)}
                className="rounded-lg border border-border/60 px-2 py-1 font-mono text-[10px] text-ink-light hover:text-ink transition-colors">
                {copied === a.address ? "Copied ✓" : "Copy"}
              </button>
            </div>
            <p className="break-all font-mono text-xs text-ink">{a.address}</p>
            <div className="rounded-xl border border-border/40 bg-white p-3 flex justify-center">
              <QRCodeSVG value={a.address} size={120} bgColor="#ffffff" fgColor="#141513" />
            </div>
          </div>
        ))}
      </div>

      <button onClick={onClose} className="mt-4 w-full rounded-xl border border-border/60 py-2.5 font-mono text-sm text-ink-light hover:text-ink">
        Close
      </button>
    </ModalShell>
  );
}

// ── Payout history list ───────────────────────────────────────────────────────

const PAYOUT_STATUS_STYLE: Record<string, string> = {
  completed:  "bg-sage/15 text-sage",
  processing: "bg-blue-500/15 text-blue-400",
  pending:    "bg-amber-500/15 text-amber-400",
  initiated:  "bg-border/60 text-ink-light",
  queued:     "bg-border/60 text-ink-light",
  failed:     "bg-fail/15 text-fail",
};

function PayoutHistoryList({ provider, reloadKey }: { provider: ProviderMeta; reloadKey: number }) {
  const [payouts, setPayouts] = useState<PayoutEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 10;

  const fetchPayouts = useCallback(async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/banking/${provider.id}/payout/list?page=${p}&limit=${limit}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to load payouts");
      setPayouts(data.data ?? []);
      setTotalCount(data.total_count ?? 0);
    } catch (err: any) {
      setError(err?.message ?? "Could not load payouts");
    } finally {
      setLoading(false);
    }
  }, [provider.id]);

  useEffect(() => { fetchPayouts(page); }, [fetchPayouts, page, reloadKey]);

  if (loading) return (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl border border-border/60 bg-cream-dark/30" />)}
    </div>
  );

  if (error) return (
    <div className="py-8 text-center">
      <p className="text-sm text-ink-light">{error}</p>
      <button onClick={() => fetchPayouts(page)} className="mt-3 rounded-xl border border-border/60 px-4 py-2 font-mono text-xs text-ink-light hover:text-ink">Retry</button>
    </div>
  );

  if (payouts.length === 0) return (
    <div className="py-8 text-center">
      <p className="text-3xl">📭</p>
      <p className="mt-2 text-sm text-ink-light">No payouts yet · tap Send to get started</p>
    </div>
  );

  const totalPages = Math.ceil(totalCount / limit);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {payouts.map((p) => (
          <div key={p.payout_id} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-cream-dark/30 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] font-mono text-sm">
              {p.payout_method === "upi" ? "🔷" : "🏦"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-body text-sm font-semibold text-ink">{p.account_holder_name}</p>
              <p className="truncate font-mono text-[10px] text-ink-light">
                {p.upi_id ?? p.account_number ?? p.merchant_payout_id}
                {p.transaction_reference_no && <> · ref: {p.transaction_reference_no}</>}
              </p>
              <p className="font-mono text-[10px] text-ink-light">
                {p.created ? new Date(p.created * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-sm font-semibold text-ink">{p.amount.toLocaleString()} {p.currency?.toUpperCase()}</p>
              <span className={`rounded-full px-2 py-0.5 font-mono text-[9px] capitalize ${PAYOUT_STATUS_STYLE[p.status] ?? "bg-border/60 text-ink-light"}`}>
                {p.status}
              </span>
            </div>
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <button disabled={page <= 0} onClick={() => setPage((p) => p - 1)}
            className="rounded-xl border border-border/60 px-3 py-1.5 font-mono text-xs text-ink-light hover:text-ink disabled:opacity-40">← Prev</button>
          <span className="font-mono text-[10px] text-ink-light">{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}
            className="rounded-xl border border-border/60 px-3 py-1.5 font-mono text-xs text-ink-light hover:text-ink disabled:opacity-40">Next →</button>
        </div>
      )}
    </div>
  );
}

// ── Deposit history list ──────────────────────────────────────────────────────

function DepositHistoryList({ provider }: { provider: ProviderMeta }) {
  const [deposits, setDeposits] = useState<DepositEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/banking/${provider.id}/payout/deposits?page=0&limit=10`)
      .then((r) => r.json())
      .then((d) => setDeposits(d.data ?? []))
      .catch(() => setError("Could not load deposits"))
      .finally(() => setLoading(false));
  }, [provider.id]);

  if (loading) return <div className="space-y-2">{[1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-2xl border border-border/60 bg-cream-dark/30" />)}</div>;
  if (error) return <p className="py-4 text-center font-mono text-xs text-ink-light">{error}</p>;
  if (deposits.length === 0) return (
    <div className="py-8 text-center">
      <p className="text-3xl">📭</p>
      <p className="mt-2 text-sm text-ink-light">No deposits yet · use your deposit address to fund this wallet</p>
    </div>
  );

  return (
    <div className="space-y-2">
      {deposits.map((d, i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-cream-dark/30 p-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sage/10 font-mono text-lg">↓</div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs font-semibold text-ink">{d.amount} {d.currency?.toUpperCase()}</p>
            <p className="truncate font-mono text-[10px] text-ink-light">{d.blockchain} · {d.blockchain_txid?.slice(0, 16)}…</p>
            <p className="font-mono text-[10px] text-ink-light">
              {d.created ? new Date(d.created * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-sage/15 px-2 py-0.5 font-mono text-[9px] text-sage">Received</span>
        </div>
      ))}
    </div>
  );
}

// ── Onramping tab ────────────────────────────────────────────────────────────

interface OnrampPair {
  pair_id: string;
  input_currency: string;
  output_currency: string;
  blockchain: string;
  min_output_amount: number;
  max_output_amount: number;
  fee_bps: number;
  network_fees: number;
  processing_time_min: number;
  processing_time_max: number;
}

interface OnrampQuote {
  rate: number;
  fee_input: number;
  network_fee_input: number;
  expires_at: number;
}

interface OnrampOrder {
  order_id: string;
  upi_qr: string;
  upi_intent: string;
  input_amount: number;
  fee_input: number;
  network_fee_input: number;
  rate: number;
  expires_at: number;
}

type OnrampStatus =
  | "CREATED" | "PAYMENT_PENDING" | "PAYMENT_RECEIVED"
  | "WITHDRAWAL_INITIATED" | "CONFIRMATIONS_PENDING"
  | "COMPLETED" | "EXPIRED" | "FAILED";

interface OnrampOrderDetail {
  order_id: string;
  status: OnrampStatus;
  input_amount: number;
  output_amount: number;
  output_currency: string;
  destination_address: string;
  rate: number;
  fee_input: number;
  network_fee_input: number;
  created_at: number;
}

const ONRAMP_STATUS_STYLE: Record<OnrampStatus, string> = {
  COMPLETED:             "bg-sage/15 text-sage",
  CONFIRMATIONS_PENDING: "bg-blue-500/15 text-blue-400",
  WITHDRAWAL_INITIATED:  "bg-blue-500/15 text-blue-400",
  PAYMENT_RECEIVED:      "bg-blue-500/15 text-blue-400",
  PAYMENT_PENDING:       "bg-amber-500/15 text-amber-400",
  CREATED:               "bg-border/60 text-ink-light",
  FAILED:                "bg-fail/15 text-fail",
  EXPIRED:               "bg-fail/10 text-fail/70",
};

const ONRAMP_STATUS_LABEL: Record<OnrampStatus, string> = {
  CREATED:               "Created",
  PAYMENT_PENDING:       "Paying",
  PAYMENT_RECEIVED:      "Paid",
  WITHDRAWAL_INITIATED:  "Sending",
  CONFIRMATIONS_PENDING: "Confirming",
  COMPLETED:             "Completed",
  EXPIRED:               "Expired",
  FAILED:                "Failed",
};

const TERMINAL_ONRAMP: OnrampStatus[] = ["COMPLETED", "EXPIRED", "FAILED"];

// ── Buy Crypto modal ──────────────────────────────────────────────────────────

function BuyCryptoModal({ provider, onClose, onSuccess }: {
  provider: ProviderMeta;
  onClose: () => void;
  onSuccess: (order: OnrampOrderDetail) => void;
}) {
  const { user } = usePrivy();
  const evmAddress = user?.smartWallet?.address ?? user?.wallet?.address ?? "";
  const solanaAddress = ((user?.linkedAccounts as any[]) ?? []).find(
    (a) => a.type === "wallet" && a.chainType === "solana" && a.walletClientType === "privy"
  )?.address ?? "";

  const [step, setStep] = useState<"form" | "qr">("form");
  const [pairs, setPairs] = useState<OnrampPair[]>([]);
  const [pairsLoading, setPairsLoading] = useState(true);
  const [selectedPair, setSelectedPair] = useState<OnrampPair | null>(null);
  const [amount, setAmount] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Auto-pick the right wallet address based on the selected pair's blockchain
  const autoAddress = selectedPair?.blockchain?.toLowerCase() === "solana" ? solanaAddress : evmAddress;
  const [destAddress, setDestAddress] = useState("");
  const [quote, setQuote] = useState<OnrampQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [order, setOrder] = useState<OnrampOrder | null>(null);
  const [orderStatus, setOrderStatus] = useState<OnrampStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Auto-fill destination address when pair or wallet changes
  useEffect(() => {
    setDestAddress(autoAddress);
  }, [autoAddress]);

  // Load pairs
  useEffect(() => {
    fetch(`/api/banking/${provider.id}/onramp/pairs`)
      .then((r) => r.json())
      .then((d) => {
        const list: OnrampPair[] = d?.data ?? [];
        setPairs(list);
        if (list.length > 0) setSelectedPair(list[0]);
      })
      .catch(() => setError("Could not load currency pairs"))
      .finally(() => setPairsLoading(false));
  }, [provider.id]);

  // Fetch quote whenever pair or amount changes (debounced)
  useEffect(() => {
    if (!selectedPair || !amount || Number(amount) <= 0) { setQuote(null); return; }
    const timer = setTimeout(async () => {
      setQuoteLoading(true);
      try {
        const res = await fetch(
          `/api/banking/${provider.id}/onramp/rate?pair_id=${selectedPair.pair_id}&amount=${amount}`,
        );
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error ?? "Failed to fetch quote");
        setQuote(d.data as OnrampQuote);
      } catch { setQuote(null); } finally { setQuoteLoading(false); }
    }, 600);
    return () => clearTimeout(timer);
  }, [provider.id, selectedPair, amount]);

  // Poll order status when on QR step
  useEffect(() => {
    if (step !== "qr" || !order) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/banking/${provider.id}/onramp/order?order_id=${order.order_id}`);
        if (!res.ok) return;
        const d = await res.json();
        const detail = d?.data as OnrampOrderDetail | undefined;
        if (!stopped && detail) {
          setOrderStatus(detail.status);
          if (TERMINAL_ONRAMP.includes(detail.status)) onSuccess(detail);
        }
      } catch { /* ignore */ }
    };
    const iv = setInterval(poll, 5000);
    poll();
    return () => { stopped = true; clearInterval(iv); };
  }, [step, order, provider.id, onSuccess]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPair) return;
    const amtNum = Number(amount);
    if (!amtNum || amtNum < selectedPair.min_output_amount || amtNum > selectedPair.max_output_amount) {
      setError(`Amount must be between ${selectedPair.min_output_amount} and ${selectedPair.max_output_amount} ${selectedPair.output_currency}`);
      return;
    }
    if (!firstName.trim() || !lastName.trim()) { setError("First and last name are required"); return; }
    if (!destAddress.trim()) { setError("Destination wallet address is required"); return; }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/banking/${provider.id}/onramp/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pair_id: selectedPair.pair_id,
          amount: amtNum,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          destination_address: destAddress.trim(),
        }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error ?? "Failed to create order");
      setOrder(d.data as OnrampOrder);
      setStep("qr");
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  const isTerminal = orderStatus && TERMINAL_ONRAMP.includes(orderStatus);
  const expiresIn = order ? Math.max(0, order.expires_at - Math.floor(Date.now() / 1000)) : 0;

  return (
    <ModalShell onClose={onClose}>
      {step === "form" && (
        <>
          <h2 className="font-display text-xl text-ink">Buy Crypto</h2>
          <p className="mt-1 font-body text-sm text-ink-light">Pay with INR via UPI · receive crypto on-chain</p>

          {pairsLoading ? (
            <div className="mt-5 space-y-3">
              {[1, 2, 3].map((i) => <div key={i} className="h-10 animate-pulse rounded-xl bg-cream-dark/40" />)}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-5 space-y-3">
              {/* Pair selector */}
              <div>
                <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Currency Pair</label>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {pairs.map((p) => (
                    <button
                      key={p.pair_id} type="button"
                      onClick={() => { setSelectedPair(p); setAmount(""); setQuote(null); }}
                      className={`rounded-xl border px-3 py-2 font-mono text-xs font-semibold transition-colors ${
                        selectedPair?.pair_id === p.pair_id
                          ? "border-sage/40 bg-sage/10 text-sage"
                          : "border-border/60 bg-cream-dark/30 text-ink-light hover:text-ink"
                      }`}>
                      {p.input_currency} → {p.output_currency}
                      <span className="ml-1 font-normal opacity-60">({p.blockchain})</span>
                    </button>
                  ))}
                </div>
              </div>

              {selectedPair && (
                <>
                  <div>
                    <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">
                      Amount ({selectedPair.output_currency}) · {selectedPair.min_output_amount}–{selectedPair.max_output_amount}
                    </label>
                    <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
                      placeholder={`e.g. ${selectedPair.min_output_amount * 2}`}
                      min={selectedPair.min_output_amount} max={selectedPair.max_output_amount} step="any"
                      className="mt-1.5 w-full rounded-xl border border-border bg-cream-dark/40 px-4 py-3 font-mono text-sm text-ink placeholder:text-ink-light/40 outline-none focus:border-sage/50"
                      required />
                  </div>

                  {/* Live quote */}
                  {(quote || quoteLoading) && (
                    <div className="rounded-xl border border-border/60 bg-cream-dark/20 p-3 space-y-1.5">
                      {quoteLoading ? (
                        <div className="h-4 w-32 animate-pulse rounded bg-cream-dark/60" />
                      ) : quote && (
                        <>
                          <div className="flex justify-between font-mono text-xs">
                            <span className="text-ink-light">Rate</span>
                            <span className="text-ink">₹{quote.rate.toLocaleString()} / {selectedPair.output_currency}</span>
                          </div>
                          <div className="flex justify-between font-mono text-xs">
                            <span className="text-ink-light">Platform fee</span>
                            <span className="text-ink">₹{quote.fee_input.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between font-mono text-xs">
                            <span className="text-ink-light">Network fee</span>
                            <span className="text-ink">₹{quote.network_fee_input.toLocaleString()}</span>
                          </div>
                          <div className="mt-1 flex justify-between border-t border-border/40 pt-1.5 font-mono text-sm font-semibold">
                            <span className="text-ink-light">You pay (INR)</span>
                            <span className="text-ink">
                              ₹{(Number(amount) * quote.rate + quote.fee_input + quote.network_fee_input).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span>
                          </div>
                          <p className="font-mono text-[9px] text-ink-light/60">
                            Est. {selectedPair.processing_time_min}–{selectedPair.processing_time_max} min · {selectedPair.fee_bps / 100}% fee
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Field label="First Name" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="John" required />
                <Field label="Last Name" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" required />
              </div>

              <div>
                <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">
                  Destination Wallet ({selectedPair?.blockchain ?? "address"})
                </label>
                <input value={destAddress} onChange={(e) => setDestAddress(e.target.value)}
                  placeholder="Your wallet address"
                  className="mt-1.5 w-full rounded-xl border border-border bg-cream-dark/40 px-4 py-3 font-mono text-[11px] text-ink placeholder:text-ink-light/40 outline-none focus:border-sage/50"
                  required />
                {autoAddress && destAddress !== autoAddress && (
                  <button type="button" onClick={() => setDestAddress(autoAddress)}
                    className="mt-1 font-mono text-[10px] text-sage hover:underline">
                    Use my {selectedPair?.blockchain?.toLowerCase() === "solana" ? "Solana" : "EVM"} wallet
                  </button>
                )}
              </div>

              {error && <p className="font-body text-sm text-fail">{error}</p>}

              <button type="submit" disabled={submitting || !selectedPair}
                className="w-full rounded-xl bg-sage py-3.5 font-mono text-sm font-semibold text-cream transition-opacity disabled:opacity-50">
                {submitting ? "Creating order…" : "Generate UPI QR"}
              </button>
            </form>
          )}
        </>
      )}

      {step === "qr" && order && (
        <div className="flex flex-col items-center gap-4">
          <div className="flex w-full items-center">
            <button onClick={() => setStep("form")} className="font-mono text-xs text-ink-light hover:text-ink mr-auto">← Back</button>
            <h2 className="font-display text-xl text-ink mx-auto pr-8">Scan & Pay</h2>
          </div>
          <p className="font-body text-sm text-ink-light text-center">
            Scan with any UPI app to pay ₹{order.input_amount.toLocaleString()}
          </p>

          <div className="rounded-2xl border border-border bg-white p-4">
            {order.upi_qr ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`data:image/png;base64,${order.upi_qr}`} alt="UPI QR" className="h-48 w-48" />
            ) : order.upi_intent ? (
              <QRCodeSVG value={order.upi_intent} size={192} bgColor="#ffffff" fgColor="#141513" />
            ) : (
              <div className="flex h-48 w-48 items-center justify-center">
                <p className="text-center font-body text-xs text-ink-light">QR unavailable</p>
              </div>
            )}
          </div>

          {/* Order summary */}
          <div className="w-full rounded-xl border border-border/60 bg-cream-dark/20 p-3 space-y-1">
            <div className="flex justify-between font-mono text-xs">
              <span className="text-ink-light">You pay</span>
              <span className="font-semibold text-ink">₹{order.input_amount.toLocaleString()}</span>
            </div>
            <div className="flex justify-between font-mono text-xs">
              <span className="text-ink-light">You receive</span>
              <span className="font-semibold text-sage">{amount} {selectedPair?.output_currency}</span>
            </div>
            <div className="flex justify-between font-mono text-xs">
              <span className="text-ink-light">Rate</span>
              <span className="text-ink">₹{order.rate.toLocaleString()} / {selectedPair?.output_currency}</span>
            </div>
            {expiresIn > 0 && (
              <div className="flex justify-between font-mono text-xs">
                <span className="text-ink-light">Expires in</span>
                <span className="text-amber-400">{Math.floor(expiresIn / 60)}m {expiresIn % 60}s</span>
              </div>
            )}
          </div>

          {orderStatus && (
            <div className={`rounded-full px-3 py-1 font-mono text-xs font-semibold ${ONRAMP_STATUS_STYLE[orderStatus]}`}>
              {ONRAMP_STATUS_LABEL[orderStatus]}
            </div>
          )}

          {order.upi_intent && (
            <a href={order.upi_intent}
              className="rounded-xl border border-sage/30 px-4 py-2 font-mono text-xs text-sage hover:bg-sage/10">
              Open in UPI App
            </a>
          )}

          {isTerminal ? (
            <button onClick={onClose} className="w-full rounded-xl bg-sage py-3 font-mono text-sm font-semibold text-cream">
              {orderStatus === "COMPLETED" ? "Done ✓" : "Close"}
            </button>
          ) : (
            <p className="animate-pulse font-mono text-xs text-ink-light">Polling for payment…</p>
          )}
        </div>
      )}
    </ModalShell>
  );
}

// ── Onramp orders list ────────────────────────────────────────────────────────

function OnrampOrdersList({ provider }: { provider: ProviderMeta }) {
  const [orders, setOrders] = useState<OnrampOrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 10;

  const fetchOrders = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/banking/${provider.id}/onramp/orders?page=${p}&limit=${limit}`);
      const d = await res.json();
      setOrders(d.data ?? []);
      setTotalCount(d.totalCount ?? 0);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [provider.id]);

  useEffect(() => { fetchOrders(page); }, [fetchOrders, page]);

  if (loading) return (
    <div className="space-y-2">
      {[1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl border border-border/60 bg-cream-dark/30" />)}
    </div>
  );

  if (orders.length === 0) return (
    <div className="py-8 text-center">
      <p className="text-2xl">📭</p>
      <p className="mt-2 text-sm text-ink-light">No orders yet</p>
    </div>
  );

  const totalPages = Math.ceil(totalCount / limit);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {orders.map((o) => (
          <div key={o.order_id} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-cream-dark/30 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-lg">
              {o.status === "COMPLETED" ? "✅" : o.status === "FAILED" || o.status === "EXPIRED" ? "❌" : "⏳"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs font-semibold text-ink">
                {o.output_amount} {o.output_currency}
                <span className="ml-1.5 font-normal text-ink-light">← ₹{o.input_amount?.toLocaleString()}</span>
              </p>
              <p className="truncate font-mono text-[10px] text-ink-light">
                {o.created_at
                  ? new Date(o.created_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                  : o.order_id.slice(-12)}
              </p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold ${ONRAMP_STATUS_STYLE[o.status]}`}>
              {ONRAMP_STATUS_LABEL[o.status]}
            </span>
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <button disabled={page <= 0} onClick={() => setPage((p) => p - 1)}
            className="rounded-xl border border-border/60 px-3 py-1.5 font-mono text-xs text-ink-light hover:text-ink disabled:opacity-40">
            ← Prev
          </button>
          <span className="font-mono text-[10px] text-ink-light">{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}
            className="rounded-xl border border-border/60 px-3 py-1.5 font-mono text-xs text-ink-light hover:text-ink disabled:opacity-40">
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

function OnrampingTab({ provider }: { provider: ProviderMeta }) {
  const [showBuy, setShowBuy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const handleSuccess = useCallback(() => {
    setShowBuy(false);
    setReloadKey((k) => k + 1);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="rounded-3xl bg-gradient-to-br from-[#6B8FD4] to-[#4A6BB5] p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-white/70">Onramping</p>
            <p className="mt-1 font-display text-2xl font-bold text-white">INR → Crypto</p>
            <p className="mt-0.5 font-mono text-[10px] text-white/60 uppercase tracking-wide">
              Pay with UPI · Receive crypto on-chain
            </p>
          </div>
          <span className="text-2xl">🔄</span>
        </div>
        <button onClick={() => setShowBuy(true)}
          className="mt-4 w-full rounded-xl bg-white py-2.5 font-mono text-xs font-semibold text-[#4A6BB5]">
          Buy Crypto with UPI
        </button>
      </div>

      {/* Orders list */}
      <p className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Order History</p>
      <OnrampOrdersList key={reloadKey} provider={provider} />

      {showBuy && (
        <BuyCryptoModal provider={provider} onClose={() => setShowBuy(false)} onSuccess={handleSuccess} />
      )}
    </div>
  );
}

// ── Offramp types ─────────────────────────────────────────────────────────────

interface OfframpPair { pair_id: string; input_currency: string; output_currency: string; blockchain: string; min_input_amount: number; max_input_amount: number; fee_bps: number; network_fees: number; processing_time_min: number; processing_time_max: number; }
interface OfframpQuote { rate: number; fee_input: number; network_fee_input: number; expires_at: number; }
interface OfframpBankAccount { bank_account_id: string; account_number: string; ifsc: string; account_holder_name: string; bank_name: string; is_default: boolean; }
interface OfframpOrder { order_id: string; deposit_address: string; blockchain: string; input_amount: number; input_currency: string; output_amount: number; expires_at: number; }
type OfframpStatus = "CREATED" | "DEPOSIT_PENDING" | "DEPOSIT_CONFIRMED" | "PAYOUT_INITIATED" | "PAYOUT_COMPLETED" | "FAILED";
interface OfframpOrderDetail { order_id: string; status: OfframpStatus; input_amount: number; input_currency: string; output_amount: number; output_currency: string; deposit_address: string; bank_account_id: string; rate: number; fee_input: number; network_fee_input: number; payout_utr?: string; created_at: number; }

const OFFRAMP_STATUS_STYLE: Record<OfframpStatus, string> = {
  PAYOUT_COMPLETED: "bg-sage/15 text-sage",
  PAYOUT_INITIATED: "bg-blue-500/15 text-blue-400",
  DEPOSIT_CONFIRMED: "bg-blue-500/15 text-blue-400",
  DEPOSIT_PENDING:  "bg-amber-500/15 text-amber-400",
  CREATED:          "bg-border/60 text-ink-light",
  FAILED:           "bg-fail/15 text-fail",
};
const OFFRAMP_STATUS_LABEL: Record<OfframpStatus, string> = {
  CREATED:          "Awaiting deposit",
  DEPOSIT_PENDING:  "Deposit detected",
  DEPOSIT_CONFIRMED:"Deposit confirmed",
  PAYOUT_INITIATED: "Paying out",
  PAYOUT_COMPLETED: "Completed",
  FAILED:           "Failed",
};
const TERMINAL_OFFRAMP: OfframpStatus[] = ["PAYOUT_COMPLETED", "FAILED"];

// ── Add bank account modal ────────────────────────────────────────────────────

function AddBankAccountModal({ provider, onClose, onAdded }: {
  provider: ProviderMeta; onClose: () => void; onAdded: (acct: OfframpBankAccount) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [review, setReview] = useState<{ would_pass: boolean; name_match_score: number; account_holder_name_from_bank: string; is_nre_account: boolean } | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReview = async () => {
    if (!firstName || !lastName || !accountNumber || !ifsc) { setError("All fields required to pre-validate"); return; }
    setReviewing(true); setError(null);
    try {
      const res = await fetch(`/api/banking/${provider.id}/offramp/bank-accounts/review`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: firstName, last_name: lastName, account_number: accountNumber, ifsc }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Review failed");
      setReview(data.data);
    } catch (err: any) { setError(err?.message ?? "Could not validate"); } finally { setReviewing(false); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`/api/banking/${provider.id}/offramp/bank-accounts`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: firstName, last_name: lastName, account_number: accountNumber, ifsc }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to add account");
      onAdded(data.data as OfframpBankAccount);
    } catch (err: any) { setError(err?.message ?? "Something went wrong"); } finally { setSubmitting(false); }
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="font-display text-xl text-ink">Add Bank Account</h2>
      <p className="mt-1 font-body text-sm text-ink-light">Penny-drop verified · INR payout destination</p>
      <form onSubmit={handleSubmit} className="mt-5 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="First Name" placeholder="John" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
          <Field label="Last Name" placeholder="Doe" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
        </div>
        <Field label="Account Number" placeholder="e.g. 12345678901234" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} required />
        <Field label="IFSC Code" placeholder="e.g. HDFC0001234" value={ifsc} onChange={(e) => setIfsc(e.target.value)} required />

        {review && (
          <div className={`rounded-xl p-3 font-mono text-xs space-y-1 ${review.would_pass ? "bg-sage/10 text-sage" : "bg-fail/10 text-fail"}`}>
            <p>{review.would_pass ? "✓ Would pass" : "✗ Would not pass"}</p>
            <p className="text-[10px] opacity-80">Bank name: {review.account_holder_name_from_bank}</p>
            <p className="text-[10px] opacity-80">Match score: {(review.name_match_score * 100).toFixed(0)}%{review.is_nre_account ? " · NRE account (not supported)" : ""}</p>
          </div>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={handleReview} disabled={reviewing}
            className="flex-1 rounded-xl border border-sage/30 py-2.5 font-mono text-xs text-sage transition-colors hover:bg-sage/10 disabled:opacity-40">
            {reviewing ? "Validating…" : "Pre-validate"}
          </button>
          <button type="submit" disabled={submitting}
            className="flex-1 rounded-xl bg-sage py-2.5 font-mono text-xs font-semibold text-cream transition-opacity disabled:opacity-50">
            {submitting ? "Adding…" : "Add Account"}
          </button>
        </div>
        {error && <p className="font-body text-sm text-fail">{error}</p>}
      </form>
    </ModalShell>
  );
}

// ── Sell crypto modal (offramp order flow) ────────────────────────────────────

function SellCryptoModal({ provider, onClose, onSuccess }: {
  provider: ProviderMeta; onClose: () => void; onSuccess: () => void;
}) {
  const { user } = usePrivy();
  const userId = (user as any)?.id ?? "";

  const [step, setStep] = useState<"form" | "address" | "done">("form");
  const [pairs, setPairs] = useState<OfframpPair[]>([]);
  const [pairsLoading, setPairsLoading] = useState(true);
  const [selectedPair, setSelectedPair] = useState<OfframpPair | null>(null);
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<OfframpQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [bankAccounts, setBankAccounts] = useState<OfframpBankAccount[]>([]);
  const [bankLoading, setBankLoading] = useState(false);
  const [selectedBank, setSelectedBank] = useState<OfframpBankAccount | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [showAddBank, setShowAddBank] = useState(false);
  const [order, setOrder] = useState<OfframpOrder | null>(null);
  const [orderStatus, setOrderStatus] = useState<OfframpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load pairs
  useEffect(() => {
    fetch(`/api/banking/${provider.id}/offramp/pairs`)
      .then((r) => r.json())
      .then((d) => { const list: OfframpPair[] = d?.data ?? []; setPairs(list); if (list.length > 0) setSelectedPair(list[0]); })
      .catch(() => setError("Could not load currency pairs"))
      .finally(() => setPairsLoading(false));
  }, [provider.id]);

  // Load bank accounts
  useEffect(() => {
    if (!userId) return;
    setBankLoading(true);
    fetch(`/api/banking/${provider.id}/offramp/bank-accounts?customer_id=${userId}`)
      .then((r) => r.json())
      .then((d) => { const list: OfframpBankAccount[] = d?.data ?? []; setBankAccounts(list); if (list.length > 0) setSelectedBank(list[0]); })
      .catch(() => {})
      .finally(() => setBankLoading(false));
  }, [provider.id, userId]);

  // Debounced quote
  useEffect(() => {
    if (!selectedPair || !amount || Number(amount) <= 0) { setQuote(null); return; }
    const t = setTimeout(async () => {
      setQuoteLoading(true);
      try {
        const res = await fetch(`/api/banking/${provider.id}/offramp/rate?pair_id=${selectedPair.pair_id}&amount=${amount}`);
        const d = await res.json();
        if (!res.ok || d.error) throw new Error(d.error);
        setQuote(d.data as OfframpQuote);
      } catch { setQuote(null); } finally { setQuoteLoading(false); }
    }, 600);
    return () => clearTimeout(t);
  }, [provider.id, selectedPair, amount]);

  // Poll order status
  useEffect(() => {
    if (step !== "address" || !order) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/banking/${provider.id}/offramp/order?order_id=${order.order_id}`);
        if (!res.ok) return;
        const d = await res.json();
        const detail = d?.data as OfframpOrderDetail | undefined;
        if (!stopped && detail) {
          setOrderStatus(detail.status);
          if (TERMINAL_OFFRAMP.includes(detail.status)) { onSuccess(); setStep("done"); }
        }
      } catch { /* ignore */ }
    };
    const iv = setInterval(poll, 5000);
    poll();
    return () => { stopped = true; clearInterval(iv); };
  }, [step, order, provider.id, onSuccess]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPair || !selectedBank) return;
    const amtNum = Number(amount);
    if (!amtNum || amtNum < selectedPair.min_input_amount || amtNum > selectedPair.max_input_amount) {
      setError(`Amount must be between ${selectedPair.min_input_amount} and ${selectedPair.max_input_amount} ${selectedPair.input_currency}`);
      return;
    }
    if (!firstName.trim() || !lastName.trim()) { setError("First and last name required"); return; }
    setError(null); setSubmitting(true);
    try {
      const res = await fetch(`/api/banking/${provider.id}/offramp/order`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pair_id: selectedPair.pair_id, amount: amtNum, first_name: firstName.trim(), last_name: lastName.trim(), bank_account_id: selectedBank.bank_account_id }),
      });
      const d = await res.json();
      if (!res.ok || d.error) throw new Error(d.error ?? "Failed to create order");
      setOrder(d.data as OfframpOrder);
      setStep("address");
    } catch (err: any) { setError(err?.message ?? "Something went wrong"); } finally { setSubmitting(false); }
  };

  const copyAddress = () => {
    if (!order) return;
    navigator.clipboard.writeText(order.deposit_address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };

  const isTerminal = orderStatus && TERMINAL_OFFRAMP.includes(orderStatus);

  return (
    <ModalShell onClose={onClose}>
      {step === "form" && (
        <>
          <h2 className="font-display text-xl text-ink">Sell Crypto</h2>
          <p className="mt-1 font-body text-sm text-ink-light">Send crypto · receive INR in your bank account</p>

          {pairsLoading ? (
            <div className="mt-5 space-y-3">{[1,2,3].map((i) => <div key={i} className="h-10 animate-pulse rounded-xl bg-cream-dark/40" />)}</div>
          ) : (
            <form onSubmit={handleSubmit} className="mt-5 space-y-3">
              {/* Pair selector */}
              <div>
                <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Currency Pair</label>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {pairs.map((p) => (
                    <button key={p.pair_id} type="button"
                      onClick={() => { setSelectedPair(p); setAmount(""); setQuote(null); }}
                      className={`rounded-xl border px-3 py-2 font-mono text-xs font-semibold transition-colors ${
                        selectedPair?.pair_id === p.pair_id ? "border-sage/40 bg-sage/10 text-sage" : "border-border/60 bg-cream-dark/30 text-ink-light hover:text-ink"
                      }`}>
                      {p.input_currency} → {p.output_currency}
                      <span className="ml-1 font-normal opacity-60">({p.blockchain})</span>
                    </button>
                  ))}
                </div>
              </div>

              {selectedPair && (
                <>
                  <div>
                    <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">
                      Amount ({selectedPair.input_currency}) · {selectedPair.min_input_amount}–{selectedPair.max_input_amount}
                    </label>
                    <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
                      placeholder={`e.g. ${selectedPair.min_input_amount * 2}`}
                      min={selectedPair.min_input_amount} max={selectedPair.max_input_amount} step="any"
                      className="mt-1.5 w-full rounded-xl border border-border bg-cream-dark/40 px-4 py-3 font-mono text-sm text-ink placeholder:text-ink-light/40 outline-none focus:border-sage/50"
                      required />
                  </div>

                  {(quote || quoteLoading) && (
                    <div className="rounded-xl border border-border/60 bg-cream-dark/20 p-3 space-y-1.5">
                      {quoteLoading ? <div className="h-4 w-32 animate-pulse rounded bg-cream-dark/60" /> : quote && (
                        <>
                          <div className="flex justify-between font-mono text-xs">
                            <span className="text-ink-light">Rate</span>
                            <span className="text-ink">₹{quote.rate.toLocaleString()} / {selectedPair.input_currency}</span>
                          </div>
                          <div className="flex justify-between font-mono text-xs">
                            <span className="text-ink-light">Platform fee</span>
                            <span className="text-ink">₹{quote.fee_input.toLocaleString()}</span>
                          </div>
                          <div className="flex justify-between font-mono text-xs">
                            <span className="text-ink-light">Network fee</span>
                            <span className="text-ink">₹{quote.network_fee_input.toLocaleString()}</span>
                          </div>
                          <div className="mt-1 flex justify-between border-t border-border/40 pt-1.5 font-mono text-sm font-semibold">
                            <span className="text-ink-light">You receive (INR)</span>
                            <span className="text-sage">
                              ₹{Math.max(0, Number(amount) * quote.rate - quote.fee_input - quote.network_fee_input).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span>
                          </div>
                          <p className="font-mono text-[9px] text-ink-light/60">
                            Est. {selectedPair.processing_time_min}–{selectedPair.processing_time_max} min · {selectedPair.fee_bps / 100}% fee
                          </p>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}

              <div className="grid grid-cols-2 gap-2">
                <Field label="First Name" placeholder="John" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
                <Field label="Last Name" placeholder="Doe" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
              </div>

              {/* Bank account selector */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Payout Bank Account</label>
                  <button type="button" onClick={() => setShowAddBank(true)} className="font-mono text-[10px] text-sage hover:underline">+ Add account</button>
                </div>
                {bankLoading ? (
                  <div className="mt-1.5 h-12 animate-pulse rounded-xl bg-cream-dark/40" />
                ) : bankAccounts.length === 0 ? (
                  <button type="button" onClick={() => setShowAddBank(true)}
                    className="mt-1.5 w-full rounded-xl border border-dashed border-border/60 py-3 font-mono text-xs text-ink-light hover:border-sage/30 hover:text-sage transition-colors">
                    + Add a bank account to receive INR
                  </button>
                ) : (
                  <div className="mt-1.5 space-y-1.5">
                    {bankAccounts.map((acct) => (
                      <button key={acct.bank_account_id} type="button"
                        onClick={() => setSelectedBank(acct)}
                        className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                          selectedBank?.bank_account_id === acct.bank_account_id ? "border-sage/40 bg-sage/5" : "border-border/60 hover:border-sage/20"
                        }`}>
                        <span className="text-lg">🏦</span>
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-xs font-semibold text-ink">{acct.bank_name}</p>
                          <p className="font-mono text-[10px] text-ink-light">••••{acct.account_number} · {acct.ifsc}</p>
                        </div>
                        {selectedBank?.bank_account_id === acct.bank_account_id && <span className="text-sage text-xs">✓</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {error && <p className="font-body text-sm text-fail">{error}</p>}

              <button type="submit" disabled={submitting || !selectedPair || !selectedBank}
                className="w-full rounded-xl bg-sage py-3.5 font-mono text-sm font-semibold text-cream transition-opacity disabled:opacity-50">
                {submitting ? "Creating order…" : "Get Deposit Address"}
              </button>
            </form>
          )}
        </>
      )}

      {step === "address" && order && (
        <div className="flex flex-col items-center gap-4">
          <h2 className="font-display text-xl text-ink">Send Crypto Here</h2>
          <p className="font-body text-sm text-ink-light text-center">
            Send exactly <strong>{order.input_amount} {order.input_currency}</strong> to this address on <strong>{order.blockchain}</strong>
          </p>

          <div className="rounded-2xl border border-border bg-white p-4">
            <QRCodeSVG value={order.deposit_address} size={160} bgColor="#ffffff" fgColor="#141513" />
          </div>

          <div className="w-full rounded-xl border border-border/60 bg-cream-dark/30 p-3">
            <p className="break-all font-mono text-xs text-ink">{order.deposit_address}</p>
          </div>

          <button onClick={copyAddress}
            className="w-full rounded-xl border border-sage/30 py-2.5 font-mono text-xs text-sage transition-colors hover:bg-sage/10">
            {copied ? "Copied ✓" : "Copy Address"}
          </button>

          <div className="w-full rounded-xl border border-border/60 bg-cream-dark/20 p-3 space-y-1">
            <div className="flex justify-between font-mono text-xs">
              <span className="text-ink-light">You send</span>
              <span className="font-semibold text-ink">{order.input_amount} {order.input_currency}</span>
            </div>
            <div className="flex justify-between font-mono text-xs">
              <span className="text-ink-light">You receive (est.)</span>
              <span className="font-semibold text-sage">₹{order.output_amount?.toLocaleString()}</span>
            </div>
            <div className="flex justify-between font-mono text-xs">
              <span className="text-ink-light">Bank</span>
              <span className="text-ink">••••{selectedBank?.account_number}</span>
            </div>
          </div>

          {orderStatus && (
            <div className={`rounded-full px-3 py-1 font-mono text-xs font-semibold ${OFFRAMP_STATUS_STYLE[orderStatus]}`}>
              {OFFRAMP_STATUS_LABEL[orderStatus]}
            </div>
          )}

          {isTerminal ? (
            <button onClick={onClose} className="w-full rounded-xl bg-sage py-3 font-mono text-sm font-semibold text-cream">
              {orderStatus === "PAYOUT_COMPLETED" ? "Done ✓" : "Close"}
            </button>
          ) : (
            <p className="animate-pulse font-mono text-xs text-ink-light">Waiting for deposit…</p>
          )}
        </div>
      )}

      {step === "done" && (
        <div className="flex flex-col items-center gap-4 py-6">
          <span className="text-5xl">✅</span>
          <h2 className="font-display text-xl text-ink">Payout Complete</h2>
          <p className="font-body text-sm text-ink-light text-center">INR has been credited to your bank account.</p>
          <button onClick={onClose} className="w-full rounded-xl bg-sage py-3 font-mono text-sm font-semibold text-cream">Done</button>
        </div>
      )}

      {showAddBank && (
        <AddBankAccountModal
          provider={provider}
          onClose={() => setShowAddBank(false)}
          onAdded={(acct) => { setBankAccounts((prev) => [...prev, acct]); setSelectedBank(acct); setShowAddBank(false); }}
        />
      )}
    </ModalShell>
  );
}

// ── Offramp orders list ───────────────────────────────────────────────────────

function OfframpOrdersList({ provider, reloadKey }: { provider: ProviderMeta; reloadKey: number }) {
  const [orders, setOrders] = useState<OfframpOrderDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 10;

  const fetchOrders = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/banking/${provider.id}/offramp/orders?page=${p}&limit=${limit}`);
      const d = await res.json();
      setOrders(d.data ?? []);
      setTotalCount(d.totalCount ?? 0);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [provider.id]);

  useEffect(() => { fetchOrders(page); }, [fetchOrders, page, reloadKey]);

  if (loading) return (
    <div className="space-y-2">{[1,2].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl border border-border/60 bg-cream-dark/30" />)}</div>
  );

  if (orders.length === 0) return (
    <div className="py-8 text-center">
      <p className="text-2xl">📭</p>
      <p className="mt-2 text-sm text-ink-light">No orders yet · tap Sell to get started</p>
    </div>
  );

  const totalPages = Math.ceil(totalCount / limit);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {orders.map((o) => (
          <div key={o.order_id} className="flex items-center gap-3 rounded-2xl border border-border/60 bg-cream-dark/30 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-lg">
              {o.status === "PAYOUT_COMPLETED" ? "✅" : o.status === "FAILED" ? "❌" : "⏳"}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs font-semibold text-ink">
                {o.input_amount} {o.input_currency}
                <span className="ml-1.5 font-normal text-ink-light">→ ₹{o.output_amount?.toLocaleString()}</span>
              </p>
              <p className="truncate font-mono text-[10px] text-ink-light">
                {o.created_at
                  ? new Date(o.created_at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                  : o.order_id.slice(-12)}
                {o.payout_utr && <> · UTR: {o.payout_utr}</>}
              </p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold ${OFFRAMP_STATUS_STYLE[o.status]}`}>
              {OFFRAMP_STATUS_LABEL[o.status]}
            </span>
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <button disabled={page <= 0} onClick={() => setPage((p) => p - 1)}
            className="rounded-xl border border-border/60 px-3 py-1.5 font-mono text-xs text-ink-light hover:text-ink disabled:opacity-40">← Prev</button>
          <span className="font-mono text-[10px] text-ink-light">{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}
            className="rounded-xl border border-border/60 px-3 py-1.5 font-mono text-xs text-ink-light hover:text-ink disabled:opacity-40">Next →</button>
        </div>
      )}
    </div>
  );
}

// ── Offramping tab ────────────────────────────────────────────────────────────

function OfframpingTab({ provider }: { provider: ProviderMeta }) {
  const [showSell, setShowSell] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const handleSuccess = useCallback(() => {
    setShowSell(false);
    setReloadKey((k) => k + 1);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {/* Header card */}
      <div className="rounded-3xl bg-gradient-to-br from-[#C4823A] to-[#9A5F20] p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-white/70">Offramping</p>
            <p className="mt-1 font-display text-2xl font-bold text-white">Crypto → INR</p>
            <p className="mt-0.5 font-mono text-[10px] text-white/60 uppercase tracking-wide">
              Send crypto · receive INR in your bank
            </p>
          </div>
          <span className="text-2xl">💱</span>
        </div>
        <button onClick={() => setShowSell(true)}
          className="mt-4 w-full rounded-xl bg-white py-2.5 font-mono text-xs font-semibold text-[#9A5F20]">
          Sell Crypto for INR
        </button>
      </div>

      {/* Orders list */}
      <p className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Order History</p>
      <OfframpOrdersList key={reloadKey} provider={provider} reloadKey={reloadKey} />

      {showSell && (
        <SellCryptoModal provider={provider} onClose={() => setShowSell(false)} onSuccess={handleSuccess} />
      )}
    </div>
  );
}

// ── Provider panel ────────────────────────────────────────────────────────────

type FeatureTab = "collection" | "payout" | "onramping" | "offramping";

const FEATURE_TABS: { key: FeatureTab; label: string; icon: string }[] = [
  { key: "onramping",  label: "Onramp",     icon: "🔄" },
  { key: "offramping", label: "Offramp",    icon: "💱" },
  { key: "collection", label: "Collection", icon: "📥" },
  { key: "payout",     label: "Payout",     icon: "💸" },
];

function ProviderPanel({ provider }: { provider: ProviderMeta }) {
  const [activeTab, setActiveTab] = useState<FeatureTab>("collection");

  return (
    <div className="flex flex-col gap-4">
      {/* Feature tab bar */}
      <div className="grid grid-cols-4 gap-1 rounded-xl border border-border/60 bg-cream-dark/20 p-1">
        {FEATURE_TABS.map((t) => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`flex flex-col items-center gap-0.5 rounded-lg py-2 transition-colors ${
              activeTab === t.key ? "bg-cream shadow-sm text-ink" : "text-ink-light hover:text-ink"
            }`}>
            <span className="text-sm leading-none">{t.icon}</span>
            <span className="font-mono text-[9px] font-semibold">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "collection"  && <CollectionTabFull provider={provider} />}
      {activeTab === "payout"      && <PayoutTab      provider={provider} />}
      {activeTab === "onramping"   && <OnrampingTab   provider={provider} />}
      {activeTab === "offramping"  && <OfframpingTab  provider={provider} />}
    </div>
  );
}

// ── Provider selector (multi-provider) ───────────────────────────────────────

function ProviderSelector({ providers, selected, onSelect }: {
  providers: ProviderMeta[]; selected: ProviderMeta; onSelect: (p: ProviderMeta) => void;
}) {
  if (providers.length <= 1) return null;
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {providers.map((p) => (
        <button key={p.id} onClick={() => onSelect(p)}
          className={`flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2 font-mono text-xs transition-colors ${
            selected.id === p.id
              ? "border-sage/40 bg-sage/10 text-sage"
              : "border-border/60 bg-cream-dark/30 text-ink-light hover:border-sage/20 hover:text-ink"
          }`}>
          <span>{p.flag}</span>
          <span>{p.name}</span>
        </button>
      ))}
    </div>
  );
}

// ── Banking platform list ─────────────────────────────────────────────────────

type BankingPlatform = "credible" | "spherepay" | "fuze" | "ripple-odl";

const BANKING_PLATFORMS = [
  {
    id: "credible" as BankingPlatform,
    icon: "🏦",
    name: "Credible Finance",
    tag: "Stablecoin Banking",
    description: "Onramp, offramp, collections & payouts — INR ↔ crypto rails for India & Southeast Asia",
    // Matches the payout currencies actually wired in credible.ts / payout/send —
    // India (INR), Indonesia (IDR), Philippines (PHP), Vietnam (VND).
    badge: "🇮🇳 🇮🇩 🇵🇭 🇻🇳",
    badgeColor: "text-orange-400 bg-orange-400/10",
  },
  {
    id: "fuze" as BankingPlatform,
    icon: "🌐",
    name: "Fuze Finance",
    tag: "Crypto + Fiat",
    description: "Global crypto & fiat infrastructure — onboard users, issue wallets, trade, remit across AED, USD, EUR, GBP, INR, USDT, USDC",
    badge: "UAE",
    badgeColor: "text-emerald-400 bg-emerald-400/10",
  },
  {
    id: "ripple-odl" as BankingPlatform,
    icon: "🌐",
    name: "Ripple Payments ODL",
    tag: "Cross-Border ODL",
    description: "On-Demand Liquidity — XRP-bridged cross-border payments, request-for-payment & settlement reporting",
    badge: "Beta",
    badgeColor: "text-slate-300 bg-slate-400/10",
  },
  {
    id: "spherepay" as BankingPlatform,
    icon: "🌐",
    name: "SpherePay",
    tag: "B2B Payments",
    description: "Global stablecoin payment rails — treasury, payroll, trade finance & payment acceptance",
    badge: "Global",
    badgeColor: "text-blue-400 bg-blue-400/10",
  },
];

function CredibleFinanceSection({ providers, loading, error }: {
  providers: ProviderMeta[];
  loading: boolean;
  error: string | null;
}) {
  const [selectedProvider, setSelectedProvider] = useState<ProviderMeta | null>(null);

  useEffect(() => {
    if (providers.length > 0 && !selectedProvider) setSelectedProvider(providers[0]);
  }, [providers, selectedProvider]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-12 animate-pulse rounded-xl bg-cream-dark/60" />
        <div className="h-44 animate-pulse rounded-3xl bg-cream-dark/60" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error || !selectedProvider ? (
        <div className="py-10 text-center">
          <p className="text-3xl">🔌</p>
          <p className="mt-3 font-semibold text-ink">Provider not configured</p>
          <p className="mt-1 text-sm text-ink-light">{error ?? "No providers available."}</p>
          <p className="mt-3 font-mono text-[10px] text-ink-light/60">
            Add CREDIBLE_FINANCE_API_KEY + CREDIBLE_FINANCE_API_SECRET to .env
          </p>
        </div>
      ) : (
        <>
          <ProviderSelector providers={providers} selected={selectedProvider} onSelect={setSelectedProvider} />
          <ProviderPanel key={selectedProvider.id} provider={selectedProvider} />
        </>
      )}
    </div>
  );
}

// ── SpherePay section ─────────────────────────────────────────────────────────

type SphereFlowType = "first-party" | "third-party";

const SPHERE_USE_CASES = [
  {
    icon: "🏛️",
    title: "Treasury Management",
    description: "First-party on-ramp/off-ramp for company treasury — same legal entity owns source and destination.",
    flow: "first-party" as SphereFlowType,
    pattern: "Onramper Account · Offloader Wallet",
  },
  {
    icon: "✅",
    title: "Payment Acceptance",
    description: "Platform fiat acceptance for incoming payments from customers — often third-party or Onramper pattern.",
    flow: "third-party" as SphereFlowType,
    pattern: "Onramper Account · Third-Party",
  },
  {
    icon: "💼",
    title: "Payroll & Disbursements",
    description: "Pay employees, contractors, or vendors — different entities, platform-mediated.",
    flow: "third-party" as SphereFlowType,
    pattern: "Business pays supplier",
  },
  {
    icon: "🌐",
    title: "Cross-border Trade Finance",
    description: "Supplier and invoice settlement across borders — stablecoin routing, multi-currency rails.",
    flow: "third-party" as SphereFlowType,
    pattern: "Third-Party Flows",
  },
];

const SPHERE_ROUTING_TABLE = [
  {
    outcome: "Same legal entity owns source and destination",
    guide: "First-Party Flows",
    pattern: "—",
  },
  {
    outcome: "Each on-ramp/off-ramp initiated explicitly via API",
    guide: "First-Party Flows",
    pattern: "One-off transfer",
  },
  {
    outcome: "Reusable fiat deposit instructions into customer's own wallet",
    guide: "First-Party Flows",
    pattern: "Onramper Account",
  },
  {
    outcome: "Reusable stablecoin-to-fiat cash-out to customer's own bank",
    guide: "First-Party Flows",
    pattern: "Offloader Wallet",
  },
  {
    outcome: "A business pays a supplier, vendor, or contractor",
    guide: "Third-Party Flows",
    pattern: "Business pays supplier",
  },
  {
    outcome: "A platform enables business customers to move funds",
    guide: "Third-Party Flows",
    pattern: "Platform serves business customers",
  },
  {
    outcome: "A bank or fintech embeds ramps for end users",
    guide: "Third-Party Flows",
    pattern: "Bank or fintech serves consumers",
  },
];

const SPHERE_SCOPING_CHECKLIST = [
  "Who owns the funds at each step",
  "Customer of record — who SpherePay must onboard and verify",
  "Sender and beneficiary (may differ from customer of record)",
  "Platform role — whether your platform is in the flow of funds",
  "Downstream users — businesses, consumers, or both",
  "Fiat currency and rail",
  "Stablecoin and network",
  "Transfer model — one-off API vs reusable deposit/cash-out instructions",
  "Balance model — movement/conversion only vs fiat balance holding",
  "Volume — monthly, average and maximum transaction size",
];

function RippleOdlSection({ providers }: { providers: ProviderMeta[] }) {
  const meta = providers.find((p) => p.id === "ripple-odl");
  const configured = !!meta?.configured;

  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [beneficiaryName, setBeneficiaryName] = useState("");
  const [beneficiaryAccountNumber, setBeneficiaryAccountNumber] = useState("");
  const [beneficiaryIfsc, setBeneficiaryIfsc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; status: string } | null>(null);

  const handleSend = async () => {
    setError(null);
    const amt = Number(amount);
    if (!amt || amt <= 0) { setError("Enter a valid amount"); return; }
    if (!beneficiaryName.trim() || !beneficiaryAccountNumber.trim() || !beneficiaryIfsc.trim()) {
      setError("Beneficiary name, account number, and routing code are required");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/banking/ripple-odl/payout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amt,
          description: description.trim() || undefined,
          beneficiaryName: beneficiaryName.trim(),
          beneficiaryAccountNumber: beneficiaryAccountNumber.trim(),
          beneficiaryIfsc: beneficiaryIfsc.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Payment failed");
      setResult({ id: data.id, status: data.status });
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Header card */}
      <div className="rounded-3xl bg-gradient-to-br from-[#1B2A4A] to-[#0E1830] p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono text-[10px] tracking-widest text-white/60 uppercase">Banking Provider</p>
            <p className="mt-1 font-display text-2xl font-bold text-white">Ripple Payments ODL</p>
            <p className="mt-0.5 font-mono text-[10px] text-white/60 uppercase tracking-wide">
              On-Demand Liquidity · XRP-bridged settlement
            </p>
          </div>
          <span className="text-3xl">🌐</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-white/10 p-2.5 text-center">
            <p className="font-mono text-lg font-bold text-white">T+0</p>
            <p className="font-mono text-[9px] text-white/60">Settlement</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2.5 text-center">
            <p className="font-mono text-lg font-bold text-white">XRP</p>
            <p className="font-mono text-[9px] text-white/60">Bridge asset</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2.5 text-center">
            <p className="font-mono text-lg font-bold text-white">RFP</p>
            <p className="font-mono text-[9px] text-white/60">+ Reports + SLS</p>
          </div>
        </div>
      </div>

      {/* Status banner */}
      {!configured ? (
        <div className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <span className="text-lg">🚧</span>
          <div>
            <p className="font-mono text-xs font-semibold text-amber-400">Integration in progress</p>
            <p className="font-mono text-[10px] text-ink-light">
              Set RIPPLE_ODL_CLIENT_ID, RIPPLE_ODL_CLIENT_SECRET, and RIPPLE_ODL_BASE_URL to activate. Field names have not yet been verified against a live RippleNet sandbox.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
          <span className="text-lg">✓</span>
          <p className="font-mono text-[10px] text-emerald-400">Credentials configured — send flow is live</p>
        </div>
      )}

      {/* Send payment (core orchestration-payments flow) */}
      <div className="rounded-2xl border border-border/60 bg-cream-dark/20 p-4">
        <p className="mb-3 font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">
          Send Payment
        </p>
        {result ? (
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
            <p className="font-mono text-xs font-semibold text-emerald-400">Payment {result.status}</p>
            <p className="mt-0.5 font-mono text-[10px] text-ink-light break-all">ID: {result.id}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <input
              type="number"
              inputMode="decimal"
              placeholder="Amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="rounded-xl border border-border/60 bg-cream px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-light/60"
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="rounded-xl border border-border/60 bg-cream px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-light/60"
            />
            <input
              type="text"
              placeholder="Beneficiary name"
              value={beneficiaryName}
              onChange={(e) => setBeneficiaryName(e.target.value)}
              className="rounded-xl border border-border/60 bg-cream px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-light/60"
            />
            <input
              type="text"
              placeholder="Beneficiary account number"
              value={beneficiaryAccountNumber}
              onChange={(e) => setBeneficiaryAccountNumber(e.target.value)}
              className="rounded-xl border border-border/60 bg-cream px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-light/60"
            />
            <input
              type="text"
              placeholder="Routing / bank code"
              value={beneficiaryIfsc}
              onChange={(e) => setBeneficiaryIfsc(e.target.value)}
              className="rounded-xl border border-border/60 bg-cream px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-light/60"
            />
            {error && <p className="font-mono text-[10px] text-red-400">{error}</p>}
            <button
              onClick={handleSend}
              disabled={submitting || !configured}
              className="rounded-xl bg-ink py-2.5 font-mono text-xs font-semibold text-cream disabled:opacity-40"
            >
              {submitting ? "Sending…" : "Send Payment"}
            </button>
          </div>
        )}
      </div>

      {/* Roadmap — remaining subsystems beyond core send */}
      <div>
        <p className="mb-2 font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Also Available (backend)</p>
        <div className="flex flex-col gap-2">
          {[
            { icon: "📥", title: "Receive & Lock", desc: "Lock an incoming payment to initiate settlement" },
            { icon: "🧾", title: "Request for Payment", desc: "Poll, accept, or decline inbound payment requests" },
            { icon: "📊", title: "Reports", desc: "PAYMENT_OPS, RECON, FAILURE_CONVERSION_SSA — JSON or CSV" },
            { icon: "💧", title: "Smart Liquidation (SLS)", desc: "Track large payments split into settlement tranches" },
          ].map((f) => (
            <div key={f.title} className="flex items-start gap-3 rounded-xl border border-border/40 bg-cream-dark/10 px-3 py-2.5">
              <span className="text-base leading-none">{f.icon}</span>
              <div>
                <p className="font-mono text-xs font-semibold text-ink">{f.title}</p>
                <p className="mt-0.5 font-mono text-[10px] text-ink-light">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SpherePaySection() {
  const [activeFlow, setActiveFlow] = useState<SphereFlowType | "all">("all");
  const [expandedRouting, setExpandedRouting] = useState(false);
  const [expandedScoping, setExpandedScoping] = useState(false);

  const filteredUseCases = activeFlow === "all"
    ? SPHERE_USE_CASES
    : SPHERE_USE_CASES.filter((u) => u.flow === activeFlow);

  return (
    <div className="flex flex-col gap-5">

      {/* Header card */}
      <div className="rounded-3xl bg-gradient-to-br from-[#3B3F8C] to-[#232660] p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono text-[10px] tracking-widest text-white/60 uppercase">Banking Provider</p>
            <p className="mt-1 font-display text-2xl font-bold text-white">SpherePay</p>
            <p className="mt-0.5 font-mono text-[10px] text-white/60 uppercase tracking-wide">
              Stablecoin payment rails · Global fiat settlement
            </p>
          </div>
          <span className="text-3xl">🌐</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-white/10 p-2.5 text-center">
            <p className="font-mono text-lg font-bold text-white">130+</p>
            <p className="font-mono text-[9px] text-white/60">Countries</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2.5 text-center">
            <p className="font-mono text-lg font-bold text-white">USDC</p>
            <p className="font-mono text-[9px] text-white/60">Stablecoin</p>
          </div>
          <div className="rounded-xl bg-white/10 p-2.5 text-center">
            <p className="font-mono text-lg font-bold text-white">API</p>
            <p className="font-mono text-[9px] text-white/60">First-class</p>
          </div>
        </div>
      </div>

      {/* Coming soon badge */}
      <div className="flex items-center gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
        <span className="text-lg">🚧</span>
        <div>
          <p className="font-mono text-xs font-semibold text-amber-400">Integration in progress</p>
          <p className="font-mono text-[10px] text-ink-light">SpherePay API credentials required to activate</p>
        </div>
      </div>

      {/* Flow type selector */}
      <div>
        <p className="mb-2 font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Flow Type</p>
        <div className="grid grid-cols-3 gap-1 rounded-xl border border-border/60 bg-cream-dark/20 p-1">
          {([["all", "All"], ["first-party", "First-Party"], ["third-party", "Third-Party"]] as const).map(([key, label]) => (
            <button key={key} onClick={() => setActiveFlow(key)}
              className={`rounded-lg py-2 font-mono text-[10px] font-semibold transition-colors ${
                activeFlow === key ? "bg-cream shadow-sm text-ink" : "text-ink-light hover:text-ink"
              }`}>
              {label}
            </button>
          ))}
        </div>
        <div className="mt-2 rounded-xl border border-border/40 bg-cream-dark/10 px-3 py-2">
          <p className="font-mono text-[10px] text-ink-light">
            <span className="text-ink font-semibold">First-party:</span> same legal entity owns source and destination.{" "}
            <span className="text-ink font-semibold">Third-party:</span> different entities, or platform-mediated flows.
          </p>
        </div>
      </div>

      {/* Use cases */}
      <div>
        <p className="mb-3 font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Solutions</p>
        <div className="grid grid-cols-1 gap-3">
          {filteredUseCases.map((uc) => (
            <div key={uc.title} className="rounded-2xl border border-border/60 bg-cream-dark/20 p-4">
              <div className="flex items-start gap-3">
                <span className="text-2xl leading-none">{uc.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-mono text-sm font-semibold text-ink">{uc.title}</p>
                    <span className={`rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold ${
                      uc.flow === "first-party"
                        ? "bg-blue-500/10 text-blue-400"
                        : "bg-purple-500/10 text-purple-400"
                    }`}>
                      {uc.flow === "first-party" ? "First-Party" : "Third-Party"}
                    </span>
                  </div>
                  <p className="mt-1 font-body text-xs text-ink-light leading-relaxed">{uc.description}</p>
                  <p className="mt-1.5 font-mono text-[10px] text-ink-light/70">Guide: {uc.pattern}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Implementation routing table */}
      <div className="rounded-2xl border border-border/60 bg-cream-dark/20 overflow-hidden">
        <button
          onClick={() => setExpandedRouting((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div>
            <p className="font-mono text-xs font-semibold text-ink">Implementation Guide Routing</p>
            <p className="font-mono text-[10px] text-ink-light">Route by discovery outcome → pick a build path</p>
          </div>
          <span className="font-mono text-xs text-ink-light">{expandedRouting ? "↑" : "↓"}</span>
        </button>
        {expandedRouting && (
          <div className="border-t border-border/40 px-4 pb-4 pt-3 space-y-2">
            {SPHERE_ROUTING_TABLE.map((row, i) => (
              <div key={i} className="rounded-xl border border-border/40 bg-cream-dark/30 p-3">
                <p className="font-body text-xs text-ink-light leading-snug">{row.outcome}</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold ${
                    row.guide.startsWith("First")
                      ? "bg-blue-500/10 text-blue-400"
                      : "bg-purple-500/10 text-purple-400"
                  }`}>
                    {row.guide}
                  </span>
                  {row.pattern !== "—" && (
                    <span className="font-mono text-[9px] text-ink-light">· {row.pattern}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Scoping checklist */}
      <div className="rounded-2xl border border-border/60 bg-cream-dark/20 overflow-hidden">
        <button
          onClick={() => setExpandedScoping((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div>
            <p className="font-mono text-xs font-semibold text-ink">Pre-build Scoping Checklist</p>
            <p className="font-mono text-[10px] text-ink-light">Confirm these with your SpherePay representative</p>
          </div>
          <span className="font-mono text-xs text-ink-light">{expandedScoping ? "↑" : "↓"}</span>
        </button>
        {expandedScoping && (
          <div className="border-t border-border/40 px-4 pb-4 pt-3 space-y-2">
            {SPHERE_SCOPING_CHECKLIST.map((item, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="mt-0.5 font-mono text-[10px] text-ink-light/60">{i + 1}.</span>
                <p className="font-body text-xs text-ink-light">{item}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Docs link */}
      <div className="rounded-2xl border border-border/60 bg-cream-dark/20 p-4">
        <p className="font-mono text-[10px] font-medium tracking-widest text-ink-light uppercase">Documentation</p>
        <p className="mt-2 font-body text-xs text-ink-light leading-relaxed">
          Full API reference, flow guides, and concept docs available at the SpherePay developer portal.
          Use <span className="font-mono text-ink">/llms.txt</span> to discover all available pages.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {[
            { label: "First-Party Flows", tag: "Guide" },
            { label: "Third-Party Flows", tag: "Guide" },
            { label: "Concepts", tag: "Reference" },
            { label: "API Reference", tag: "Reference" },
          ].map((link) => (
            <div key={link.label} className="flex items-center justify-between rounded-xl border border-border/40 px-3 py-2">
              <p className="font-mono text-[10px] text-ink">{link.label}</p>
              <span className="font-mono text-[9px] text-ink-light/60">{link.tag}</span>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}

// ── Main banking screen ───────────────────────────────────────────────────────

export function BankingScreen() {
  const [open, setOpen] = useState<BankingPlatform | null>(null);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/banking/providers")
      .then((r) => r.json())
      .then((data: ProviderMeta[]) => {
        if (Array.isArray(data) && data.length > 0) setProviders(data);
        else setError("No banking providers configured.");
      })
      .catch(() => setError("Failed to load banking providers."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <>
      <div className="flex flex-col gap-3">
        {BANKING_PLATFORMS.map((p) => (
          <button
            key={p.id}
            onClick={() => setOpen(p.id)}
            className="flex items-center gap-4 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-left transition-colors hover:border-[#3A3B37] active:bg-white/[0.04] w-full"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-2xl">
              {p.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-[#F2F0E8]">{p.name}</p>
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-[#A7A79A]">{p.tag}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${p.badgeColor}`}>{p.badge}</span>
              </div>
              <p className="truncate text-xs text-[#A7A79A] mt-0.5">{p.description}</p>
            </div>
            <svg className="shrink-0 text-[#A7A79A]" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        ))}
      </div>

      {/* Detail sheet */}
      {open && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[70] flex flex-col">
          <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(null)} />
          <div className="bg-[#141513] rounded-t-3xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[#2A2B27] shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-xl">{BANKING_PLATFORMS.find((p) => p.id === open)?.icon}</span>
                <div>
                  <p className="font-semibold text-[#F2F0E8] text-sm">
                    {BANKING_PLATFORMS.find((p) => p.id === open)?.name}
                  </p>
                  <p className="text-xs text-[#A7A79A]">
                    {BANKING_PLATFORMS.find((p) => p.id === open)?.tag}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setOpen(null)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-[#A7A79A] hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            {/* Scrollable content */}
            <div className="overflow-y-auto flex-1 p-4 pb-[calc(max(env(safe-area-inset-bottom),24px)+72px)]">
              {open === "credible" && (
                <CredibleFinanceSection providers={providers} loading={loading} error={error} />
              )}
              {open === "spherepay" && <SpherePaySection />}
              {open === "fuze" && <FuzeSection />}
              {open === "ripple-odl" && <RippleOdlSection providers={providers} />}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
