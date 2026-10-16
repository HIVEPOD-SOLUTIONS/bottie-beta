"use client";

import { useCallback, useEffect, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { authFetch } from "@/lib/api-auth-fetch";
import { friendlyEvmError, payEvmTransfer, pickPrivyWalletOrThrow, waitForEvmTx } from "@/lib/evm-pay";
import { arcAddressUrl, arcChain, arcTxUrl, ARC_USDC } from "@/lib/arc-chain";
import { useArcUsdcBalance } from "@/hooks/use-arc-balance";
import type { BusinessPolicy } from "@/lib/business/policy";

/**
 * Bluvfi for Business — a treasury agent for a small business, settled in
 * USDC on Arc. The owner funds the treasury, adds payees and bills (or pastes
 * an invoice), sets the limits, and the agent decides what to pay and when —
 * every decision signed into a public, verifiable log.
 */

type Payee = { id: string; name: string; kind: string; address: string; capUsd: number | null; allowlisted: boolean };
type Bill = { id: string; payeeId: string; payee: string; amountUsd: number; dueAt: string; memo: string | null; invoiceRef: string | null; status: string; ownerApproved: boolean; decisionNote: string | null; paidTx: string | null; source: string };
type Decision = { seq: number; kind: string; actor: string; summary: string; reasoning: string | null; amountUsd: number | null; txHash: string | null; createdAt: string };
type Snapshot = {
  id: string; name: string; treasuryAddress: string; custody: string; publicLog: boolean; policy: BusinessPolicy; balanceUsd: number | null;
  stats: { paidCount: number; paidUsd: number; payees: number }; payees: Payee[]; bills: Bill[]; decisions: Decision[];
};
type RunResult = { balanceUsd: number; considered: number; paid: { payee: string; amountUsd: number; txHash: string }[]; deferred: { payee: string; reason: string }[]; escalated: { payee: string; reason: string }[]; blocked: { payee: string; reason: string }[]; modelUsed: string | null };

const card = "rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4";
const input = "w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-2 text-sm text-[#F2F0E8] placeholder:text-[#A7A79A]/50 outline-none focus:border-[#8FAE82]";
const btn = "rounded-xl bg-[#8FAE82] px-4 py-2 text-sm font-semibold text-[#141513] disabled:opacity-50";
const btn2 = "rounded-xl bg-white/[0.06] px-3 py-2 text-xs font-semibold text-[#F2F0E8] disabled:opacity-50";
/** "defer[funds_after_reserve]: reason" → "defer: reason" (the bracket is the agent's de-duplication key). */
const noteText = (n: string) => n.replace(/^(w+)[[^]]*]:/, "$1:");
const usd = (n: number | null | undefined) => (n == null ? "…" : `$${n.toFixed(2)}`);

const STATUS: Record<string, string> = {
  scheduled: "text-sky-300 bg-sky-300/10", approval_needed: "text-amber-400 bg-amber-400/10", paying: "text-violet-300 bg-violet-300/10",
  paid: "text-green-400 bg-green-400/10", failed: "text-red-400 bg-red-400/10",
};
const KIND: Record<string, string> = { pay: "text-green-400", blocked: "text-red-400", failed: "text-red-400", escalate: "text-amber-400", defer: "text-sky-300" };

export function BusinessScreen() {
  const { getAccessToken } = usePrivy();
  const [list, setList] = useState<{ id: string; name: string }[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    const r = await authFetch("/api/business", {}, getAccessToken).catch(() => null);
    const d = r?.ok ? await r.json() : { businesses: [] };
    setList(d.businesses);
    setActiveId((cur) => cur ?? d.businesses[0]?.id ?? null);
  }, [getAccessToken]);
  useEffect(() => { void loadList(); }, [loadList]);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await authFetch("/api/business", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }, getAccessToken);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setActiveId(d.id); setName(""); await loadList();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (list === null) return <p className="py-10 text-center text-sm text-[#A7A79A]">Loading…</p>;

  return (
    <div className="flex flex-col gap-4 pb-24">
      {list.length === 0 ? (
        <div className={card}>
          <p className="text-lg font-semibold text-[#F2F0E8]">🏢 Bluvfi for Business</p>
          <p className="mt-1 text-sm text-[#A7A79A]">
            An AI treasurer for your business. It holds USDC on Arc, pays your vendors and contractors when bills are due — within limits you set and it can&apos;t override —
            and records every decision in a signed log anyone can verify.
          </p>
          <div className="mt-3 flex gap-2">
            <input className={input} placeholder="Business name" value={name} onChange={(e) => setName(e.target.value)} />
            <button className={btn} disabled={busy || name.trim().length < 2} onClick={create}>Create</button>
          </div>
          {err && <p className="mt-2 text-xs text-red-400">{err}</p>}
        </div>
      ) : (
        <>
          {list.length > 1 && (
            <div className="flex gap-2 overflow-x-auto">
              {list.map((b) => (
                <button key={b.id} onClick={() => setActiveId(b.id)} className={`shrink-0 rounded-full px-3 py-1 text-xs ${activeId === b.id ? "bg-[#F2F0E8] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A]"}`}>{b.name}</button>
              ))}
            </div>
          )}
          {activeId && <BusinessDashboard key={activeId} id={activeId} />}
        </>
      )}
    </div>
  );
}

function BusinessDashboard({ id }: { id: string }) {
  const { getAccessToken, sendTransaction } = usePrivy();
  const { wallets } = useWallets();
  const { arcUsdc, refresh: refreshMyArc } = useArcUsdcBalance(20_000);
  const [s, setS] = useState<Snapshot | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [tab, setTab] = useState<"bills" | "payees" | "policy" | "log">("bills");

  const load = useCallback(async () => {
    const r = await authFetch(`/api/business/${id}`, {}, getAccessToken).catch(() => null);
    if (r?.ok) setS(await r.json());
  }, [id, getAccessToken]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (action: string, body: Record<string, unknown> = {}, label = action) => {
    setBusy(label); setMsg(null);
    try {
      const r = await authFetch(`/api/business/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) }, getAccessToken);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed");
      await load();
      return d;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return null;
    } finally { setBusy(null); }
  };

  if (!s) return <p className="py-10 text-center text-sm text-[#A7A79A]">Loading your treasury…</p>;
  const pending = s.bills.filter((b) => b.status === "approval_needed");
  const open = s.bills.filter((b) => b.status === "scheduled" || b.status === "paying");
  const done = s.bills.filter((b) => b.status === "paid");
  // The audit page is server-rendered on the web only (not in the Android export), so point at the deployed site.
  const siteOrigin = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "") || (typeof window !== "undefined" ? window.location.origin : "");
  const auditUrl = `${siteOrigin}/audit/${s.id}`;

  return (
    <>
      {/* Treasury */}
      <div className={card}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-[#A7A79A]">
              {s.name} · treasury on Arc{" "}
              <span className={`ml-1 rounded-full px-2 py-0.5 text-[10px] ${s.custody === "circle" ? "bg-[#5B8DFF]/15 text-[#9DB8FF]" : "bg-white/[0.06] text-[#A7A79A]"}`}>
                {s.custody === "circle" ? "Circle wallet" : "Bluvfi-held key"}
              </span>
            </p>
            <p className="text-3xl font-semibold text-[#F2F0E8]">{usd(s.balanceUsd)} <span className="text-sm text-[#A7A79A]">USDC</span></p>
            <a href={arcAddressUrl(s.treasuryAddress)} target="_blank" rel="noopener noreferrer" className="block truncate font-mono text-[11px] text-[#8FAE82] underline">{s.treasuryAddress}</a>
          </div>
          <button className={btn} disabled={!!busy} onClick={async () => { const d = await act("run", {}, "run"); if (d) setRun(d); }}>
            {busy === "run" ? "Agent working…" : "▶ Run agent"}
          </button>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <Stat label="paid" value={`${s.stats.paidCount}`} />
          <Stat label="USDC moved" value={usd(s.stats.paidUsd)} />
          <Stat label="awaiting you" value={`${pending.length}`} warn={pending.length > 0} />
        </div>
        <FundAndWithdraw
          treasury={s.treasuryAddress}
          myArc={arcUsdc}
          busy={!!busy}
          onFund={async (amount) => {
            setBusy("fund"); setMsg(null);
            try {
              const { hash } = await payEvmTransfer({ chainId: arcChain.id, token: ARC_USDC, symbol: "USDC", decimals: 6, recipient: s.treasuryAddress as `0x${string}`, amount, wallet: pickPrivyWalletOrThrow(wallets), sendTransaction, label: "business-fund" });
              await waitForEvmTx(arcChain.id, hash);
              setMsg({ ok: true, text: `Funded ${amount} USDC.` });
              void refreshMyArc(); await load();
            } catch (e) { setMsg({ ok: false, text: friendlyEvmError(e, "Arc") }); } finally { setBusy(null); }
          }}
          onWithdraw={async (amount) => { const d = await act("withdraw", { amountUsd: Number(amount) }, "withdraw"); if (d) setMsg({ ok: true, text: `Withdrew ${amount} USDC to your Bluvfi wallet.` }); }}
        />
        {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</p>}
      </div>

      {run && (
        <div className={card}>
          <p className="text-sm font-semibold text-[#F2F0E8]">Agent run · {run.considered} bill(s) due soon · {run.modelUsed ? `decided with ${run.modelUsed}` : "rules only"}</p>
          {run.considered === 0 && <p className="mt-1 text-xs text-[#A7A79A]">Nothing due within the payment window.</p>}
          {run.paid.map((p, i) => <p key={`p${i}`} className="mt-1 text-xs text-green-400">✓ Paid {p.payee} {usd(p.amountUsd)} · <a className="underline" href={arcTxUrl(p.txHash)} target="_blank" rel="noopener noreferrer">tx</a></p>)}
          {run.escalated.map((p, i) => <p key={`e${i}`} className="mt-1 text-xs text-amber-400">⚑ {p.payee}: {p.reason}</p>)}
          {run.deferred.map((p, i) => <p key={`d${i}`} className="mt-1 text-xs text-sky-300">⏸ {p.payee}: {p.reason}</p>)}
          {run.blocked.map((p, i) => <p key={`b${i}`} className="mt-1 text-xs text-red-400">⛔ {p.payee}: {p.reason}</p>)}
        </div>
      )}

      {pending.length > 0 && (
        <div className={`${card} border-amber-500/30`}>
          <p className="text-sm font-semibold text-amber-400">Needs your decision</p>
          {pending.map((b) => (
            <div key={b.id} className="mt-2 rounded-xl bg-[#141513] p-3">
              <p className="text-sm text-[#F2F0E8]">{b.payee} · {usd(b.amountUsd)} · due {b.dueAt.slice(0, 10)}</p>
              {b.decisionNote && <p className="mt-0.5 text-[11px] text-[#A7A79A]">Agent: {noteText(b.decisionNote)}</p>}
              <div className="mt-2 flex gap-2">
                <button className={btn2} disabled={!!busy} onClick={() => act("approveBill", { billId: b.id })}>Approve</button>
                <button className={btn2} disabled={!!busy} onClick={() => act("cancelBill", { billId: b.id })}>Cancel bill</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 rounded-xl bg-white/[0.04] p-1">
        {(["bills", "payees", "policy", "log"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 rounded-lg py-1.5 text-xs font-semibold capitalize ${tab === t ? "bg-[#F2F0E8] text-[#141513]" : "text-[#A7A79A]"}`}>
            {t === "log" ? "Decision log" : t}
          </button>
        ))}
      </div>

      {tab === "bills" && <BillsPanel s={s} open={open} done={done} busy={!!busy} act={act} />}
      {tab === "payees" && <PayeesPanel s={s} busy={!!busy} act={act} />}
      {tab === "policy" && <PolicyPanel s={s} busy={!!busy} act={act} />}
      {tab === "log" && (
        <div className={card}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-[#F2F0E8]">Signed decision log</p>
            <div className="flex gap-2">
              <button className={btn2} disabled={!!busy} onClick={async () => { const d = await act("verify", {}, "verify"); if (d) setMsg({ ok: d.ok, text: d.ok ? `✓ ${d.entries} entries verified: hash chain intact, every entry signed by the treasury.` : `✗ Broken at #${d.brokenAt}: ${d.reason}` }); }}>Verify</button>
              <button className={btn2} disabled={!!busy} onClick={() => act("setPublicLog", { on: !s.publicLog })}>{s.publicLog ? "Make private" : "Make public"}</button>
            </div>
          </div>
          {s.publicLog && (
            <p className="mt-2 text-[11px] text-[#A7A79A]">Public link: <a className="text-[#8FAE82] underline break-all" href={auditUrl} target="_blank" rel="noopener noreferrer">{auditUrl}</a></p>
          )}
          <ol className="mt-3 space-y-2">
            {s.decisions.map((d) => (
              <li key={d.seq} className="rounded-xl bg-[#141513] p-3">
                <p className="text-xs text-[#F2F0E8]"><span className="mr-1 font-mono text-[#5C5D58]">#{d.seq}</span><span className={`mr-1 font-semibold ${KIND[d.kind] ?? "text-[#DCE8D5]"}`}>{d.kind}</span>{d.summary}</p>
                {d.reasoning && <p className="mt-0.5 text-[11px] text-[#A7A79A]">Why: {d.reasoning}</p>}
                <p className="mt-0.5 text-[10px] text-[#5C5D58]">{new Date(d.createdAt).toLocaleString()} · {d.actor}{d.txHash && <> · <a className="text-[#8FAE82] underline" href={arcTxUrl(d.txHash)} target="_blank" rel="noopener noreferrer">tx</a></>}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-xl bg-[#141513] py-2">
      <p className={`text-base font-semibold ${warn ? "text-amber-400" : "text-[#F2F0E8]"}`}>{value}</p>
      <p className="text-[10px] text-[#A7A79A]">{label}</p>
    </div>
  );
}

function FundAndWithdraw({ treasury, myArc, busy, onFund, onWithdraw }: { treasury: string; myArc: number | null; busy: boolean; onFund: (a: string) => void; onWithdraw: (a: string) => void }) {
  const [amount, setAmount] = useState("");
  const [copied, setCopied] = useState(false);
  const ok = Number(amount) > 0;
  return (
    <div className="mt-3 space-y-2">
      <div className="flex gap-2">
        <input className={input} inputMode="decimal" placeholder="Amount (USDC)" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
        <button className={btn2} disabled={busy || !ok} onClick={() => onFund(amount)}>Fund</button>
        <button className={btn2} disabled={busy || !ok} onClick={() => onWithdraw(amount)}>Withdraw</button>
      </div>
      <p className="text-[11px] text-[#A7A79A]">
        Fund sends USDC on Arc from your Bluvfi wallet (you have {myArc == null ? "…" : `$${myArc.toFixed(2)}`} there — add more from Wallet → Arc).
        Or send USDC on Arc from anywhere to{" "}
        <button className="font-mono text-[#8FAE82] underline" onClick={() => { void navigator.clipboard.writeText(treasury); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
          {copied ? "copied ✓" : `${treasury.slice(0, 8)}…${treasury.slice(-6)}`}
        </button>. Withdrawals always go to your own Bluvfi wallet.
      </p>
    </div>
  );
}

type Act = (action: string, body?: Record<string, unknown>, label?: string) => Promise<unknown>;

function BillsPanel({ s, open, done, busy, act }: { s: Snapshot; open: Bill[]; done: Bill[]; busy: boolean; act: Act }) {
  const [payeeId, setPayeeId] = useState(s.payees[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState(() => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [ref, setRef] = useState("");
  const [invoice, setInvoice] = useState("");
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className={card}>
        <p className="text-sm font-semibold text-[#F2F0E8]">Add a bill</p>
        {s.payees.length === 0 ? (
          <p className="mt-1 text-xs text-[#A7A79A]">Add a payee first (Payees tab).</p>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <select className={input} value={payeeId} onChange={(e) => setPayeeId(e.target.value)}>
              {s.payees.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input className={input} inputMode="decimal" placeholder="Amount USDC" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
            <input className={input} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            <input className={input} placeholder="Invoice # (optional)" value={ref} onChange={(e) => setRef(e.target.value)} />
            <input className={`${input} col-span-2`} placeholder="What it's for (optional)" value={memo} onChange={(e) => setMemo(e.target.value)} />
            <button className={`${btn} col-span-2`} disabled={busy || !payeeId || !(Number(amount) > 0)} onClick={async () => {
              const d = await act("addBill", { payeeId, amountUsd: Number(amount), dueAt: `${due}T12:00:00Z`, memo, invoiceRef: ref }, "addBill");
              if (d) { setAmount(""); setMemo(""); setRef(""); }
            }}>Add bill</button>
          </div>
        )}
        <p className="mt-3 text-sm font-semibold text-[#F2F0E8]">…or paste an invoice</p>
        <textarea className={`${input} mt-2 h-24`} placeholder="Paste the invoice text — the agent reads the payee, amount, due date and invoice number" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
        <button className={`${btn} mt-2 w-full`} disabled={busy || invoice.trim().length < 20} onClick={async () => {
          setNote(null);
          const d = (await act("addInvoice", { text: invoice }, "addInvoice")) as { filed: boolean; reason?: string; parsed?: { payeeName: string; amountUsd: number } } | null;
          if (d) { setNote(d.filed ? `Filed: ${d.parsed?.payeeName} $${d.parsed?.amountUsd}` : d.reason ?? "Not filed"); if (d.filed) setInvoice(""); }
        }}>{busy ? "Reading…" : "Read invoice"}</button>
        {note && <p className="mt-2 text-xs text-[#A7A79A]">{note}</p>}
      </div>

      <BillList title="Open" bills={open} busy={busy} act={act} />
      <BillList title="Paid" bills={done} busy={busy} act={act} />
    </div>
  );
}

function BillList({ title, bills, busy, act }: { title: string; bills: Bill[]; busy: boolean; act: Act }) {
  if (!bills.length) return null;
  return (
    <div className={card}>
      <p className="text-sm font-semibold text-[#F2F0E8]">{title}</p>
      {bills.map((b) => (
        <div key={b.id} className="mt-2 flex items-start justify-between gap-2 rounded-xl bg-[#141513] p-3">
          <div className="min-w-0">
            <p className="text-sm text-[#F2F0E8]">{b.payee} · {usd(b.amountUsd)}</p>
            <p className="text-[11px] text-[#A7A79A]">due {b.dueAt.slice(0, 10)}{b.invoiceRef ? ` · #${b.invoiceRef}` : ""}{b.memo ? ` · ${b.memo}` : ""}</p>
            {b.decisionNote && <p className="text-[11px] text-[#5C5D58]">Agent: {noteText(b.decisionNote)}</p>}
            {b.paidTx && <a className="text-[11px] text-[#8FAE82] underline" href={arcTxUrl(b.paidTx)} target="_blank" rel="noopener noreferrer">view payment</a>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <span className={`rounded-full px-2 py-0.5 text-[10px] ${STATUS[b.status] ?? "text-[#A7A79A]"}`}>{b.status.replace("_", " ")}</span>
            {b.status === "scheduled" && <button className="text-[10px] text-[#A7A79A] underline" disabled={busy} onClick={() => act("cancelBill", { billId: b.id })}>cancel</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

function PayeesPanel({ s, busy, act }: { s: Snapshot; busy: boolean; act: Act }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [kind, setKind] = useState("vendor");
  const [cap, setCap] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <div className={card}>
        <p className="text-sm font-semibold text-[#F2F0E8]">Add a vendor or contractor</p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <input className={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="vendor">Vendor</option>
            <option value="contractor">Contractor</option>
          </select>
          <input className={`${input} col-span-2 font-mono`} placeholder="Their 0x address (paid USDC on Arc)" value={address} onChange={(e) => setAddress(e.target.value.trim())} />
          <input className={input} inputMode="decimal" placeholder="Cap per bill (optional)" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ""))} />
          <button className={btn} disabled={busy || !name.trim() || !/^0x[0-9a-fA-F]{40}$/.test(address)} onClick={async () => {
            const d = await act("addPayee", { name, address, kind, capUsd: cap || null }, "addPayee");
            if (d) { setName(""); setAddress(""); setCap(""); }
          }}>Add</button>
        </div>
      </div>
      {s.payees.map((p) => (
        <div key={p.id} className={`${card} flex items-center justify-between gap-2`}>
          <div className="min-w-0">
            <p className="text-sm text-[#F2F0E8]">{p.name} <span className="text-[11px] text-[#A7A79A]">· {p.kind}{p.capUsd ? ` · cap ${usd(p.capUsd)}` : ""}</span></p>
            <p className="truncate font-mono text-[11px] text-[#A7A79A]">{p.address}</p>
          </div>
          <button className={btn2} disabled={busy} onClick={() => act("setPayeeAllowlisted", { payeeId: p.id, allowlisted: !p.allowlisted })}>
            {p.allowlisted ? "✓ Allowlisted" : "Blocked"}
          </button>
        </div>
      ))}
    </div>
  );
}

function PolicyPanel({ s, busy, act }: { s: Snapshot; busy: boolean; act: Act }) {
  const [p, setP] = useState<BusinessPolicy>(s.policy);
  const field = (k: keyof BusinessPolicy, label: string, hint: string) => (
    <label className="block">
      <span className="text-xs text-[#A7A79A]">{label}</span>
      <input className={input} inputMode="decimal" value={String(p[k])} onChange={(e) => setP({ ...p, [k]: Number(e.target.value.replace(/[^0-9.]/g, "")) || 0 })} />
      <span className="text-[10px] text-[#5C5D58]">{hint}</span>
    </label>
  );
  return (
    <div className={card}>
      <p className="text-sm font-semibold text-[#F2F0E8]">Limits the agent can&apos;t override</p>
      <div className="mt-2 grid grid-cols-2 gap-3">
        {field("dailyCapUsd", "Daily cap (USD)", "Most it pays in any 24h")}
        {field("perPaymentCapUsd", "Per-payment cap", "Above this needs you")}
        {field("approvalAboveUsd", "Ask me above", "Bills above this wait for your approval")}
        {field("reserveUsd", "Always keep", "Never spent by the agent")}
        {field("payWithinDays", "Pay this many days early", "0 = on the due date")}
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-[#F2F0E8]">
        <input type="checkbox" checked={p.autopay} onChange={(e) => setP({ ...p, autopay: e.target.checked })} />
        Autopay within limits (off = the agent only recommends)
      </label>
      <button className={`${btn} mt-3 w-full`} disabled={busy} onClick={() => act("updatePolicy", { policy: p }, "policy")}>Save limits</button>
      <p className="mt-2 text-[11px] text-[#A7A79A]">Payees must be allowlisted, duplicates of a recently paid invoice are held for you, and every change here is written to the signed log.</p>
    </div>
  );
}
