import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { businessAccounts } from "@/lib/db/schema";
import { listDecisions, verifyDecisionLog } from "@/lib/business/ledger";
import { arcAddressUrl, arcTxUrl } from "@/lib/arc-chain";

/**
 * Public, read-only decision log of a business's treasury agent — shown only
 * when the owner has made it public. Verified live on every load: the hash
 * chain is recomputed and every entry's signature is checked against the
 * treasury address.
 */

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  created: "Created", payee_added: "Payee added", bill_added: "Bill filed", run: "Agent run", pay: "Paid",
  defer: "Deferred", escalate: "Escalated", blocked: "Blocked by policy", approve: "Owner approved",
  cancel: "Cancelled", withdraw: "Withdrawal", policy: "Policy change", failed: "Payment failed", public_log: "Visibility",
};
const KIND_COLOR: Record<string, string> = {
  pay: "text-green-400", blocked: "text-red-400", failed: "text-red-400", escalate: "text-amber-400", defer: "text-sky-300", run: "text-[#A7A79A]",
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Treasury decision log · ${id.slice(0, 8)} · Bluvfi for Business` };
}

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [b] = await db.select().from(businessAccounts).where(eq(businessAccounts.id, id)).limit(1);
  if (!b || !b.publicLog) notFound();
  const [entries, verification] = await Promise.all([listDecisions(b.id, 500), verifyDecisionLog(b.id, b.treasuryAddress)]);
  const paid = entries.filter((e) => e.kind === "pay");
  const paidUsd = paid.reduce((s, e) => s + Number(e.amountUsdc ?? 0), 0);

  return (
    <main className="min-h-screen bg-[#141513] px-4 py-8 text-[#F2F0E8]">
      {/* Public page for auditors and reviewers on any screen: drop the app's "mobile only" overlay. */}
      <style>{".desktop-blocker{display:none!important}"}</style>
      <div className="mx-auto max-w-3xl">
        <p className="text-xs uppercase tracking-widest text-[#8FAE82]">Bluvfi for Business · treasury decision log</p>
        <h1 className="mt-1 text-2xl font-semibold">{b.name}</h1>
        <p className="mt-1 text-xs text-[#A7A79A]">
          Treasury on Arc:{" "}
          <a className="font-mono text-[#8FAE82] underline" href={arcAddressUrl(b.treasuryAddress)} target="_blank" rel="noopener noreferrer">{b.treasuryAddress}</a>
        </p>

        <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${verification.ok ? "border-green-700/40 bg-green-900/10 text-green-300" : "border-red-700/40 bg-red-900/10 text-red-300"}`}>
          {verification.ok
            ? `✓ Verified just now: ${verification.entries} entries, every hash links to the one before it and every entry is signed by the treasury address.`
            : `✗ Verification failed at entry #${verification.brokenAt}: ${verification.reason}.`}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-[#1B1C19] p-3"><p className="text-lg font-semibold">{paid.length}</p><p className="text-[11px] text-[#A7A79A]">payments made</p></div>
          <div className="rounded-xl bg-[#1B1C19] p-3"><p className="text-lg font-semibold">${paidUsd.toFixed(2)}</p><p className="text-[11px] text-[#A7A79A]">USDC paid on Arc</p></div>
          <div className="rounded-xl bg-[#1B1C19] p-3"><p className="text-lg font-semibold">{entries.length}</p><p className="text-[11px] text-[#A7A79A]">logged decisions</p></div>
        </div>

        <ol className="mt-6 space-y-2">
          {entries.map((e) => (
            <li key={e.seq} className="rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm">
                  <span className="mr-2 font-mono text-[11px] text-[#5C5D58]">#{e.seq}</span>
                  <span className={`mr-2 text-xs font-semibold ${KIND_COLOR[e.kind] ?? "text-[#DCE8D5]"}`}>{KIND_LABEL[e.kind] ?? e.kind}</span>
                  {e.summary}
                </p>
                <p className="text-[11px] text-[#A7A79A]">{e.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC · {e.actor}</p>
              </div>
              {e.reasoning && <p className="mt-1 text-xs text-[#DCE8D5]">Why: {e.reasoning}</p>}
              {e.txHash && (
                <a className="mt-1 inline-block font-mono text-[11px] text-[#8FAE82] underline" href={arcTxUrl(e.txHash)} target="_blank" rel="noopener noreferrer">tx {e.txHash.slice(0, 18)}…</a>
              )}
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-[#5C5D58]">What the agent saw · hash · signature</summary>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[#141513] p-2 text-[10px] text-[#A7A79A]">{(() => { try { return JSON.stringify(JSON.parse(e.inputs), null, 2); } catch { return e.inputs; } })()}</pre>
                <p className="mt-1 break-all font-mono text-[10px] text-[#5C5D58]">hash {e.hash}<br />prev {e.prevHash}<br />sig {e.signature}</p>
              </details>
            </li>
          ))}
        </ol>

        <p className="mt-6 text-[11px] leading-relaxed text-[#5C5D58]">
          How to verify independently: each entry&apos;s hash is sha256 of JSON [businessId, seq, kind, actor, summary, inputs, reasoning, billId, amountUsdc, txHash, prevHash, createdAt ISO];
          prevHash is the previous entry&apos;s hash (the first is &quot;genesis:&lt;businessId&gt;&quot;); signature is an EIP-191 personal_sign of the hash by the treasury address.
          Raw JSON: /api/business/{b.id}/log
        </p>
      </div>
    </main>
  );
}
