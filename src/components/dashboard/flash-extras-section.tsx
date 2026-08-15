"use client";

import { useState, useCallback, useEffect } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction } from "@privy-io/react-auth/solana";
import { Transaction, Keypair } from "@solana/web3.js";
import { Connection } from "@solana/web3.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SignFn = (...args: any[]) => Promise<any>;

// Swap, liquidity, staking, and rewards are all WithAction txs — they go to mainnet Solana, not ER

async function signAndSendTx(base64Tx: string, signTransaction: SignFn): Promise<string> {
  const txBuf = Buffer.from(base64Tx, "base64");
  const tx = Transaction.from(txBuf);
  const result = await signTransaction({ transaction: tx });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signed: Transaction = result?.signedTransaction ?? result;
  const serialized = signed.serialize();
  const b64 = Buffer.from(serialized).toString("base64");
  const resp = await fetch(SOL_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [b64, { encoding: "base64" }] }),
  });
  const data = await resp.json() as { result?: string; error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
  return data.result ?? "";
}

function fmt(n: number | null | undefined, d = 4) {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: d });
}

type TxStatus = { sig: string } | { error: string } | null;

function TxResult({ status, onClose }: { status: TxStatus; onClose: () => void }) {
  if (!status) return null;
  const isErr = "error" in status;
  return (
    <div className={`mt-3 p-3 rounded-xl text-xs ${isErr ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}>
      {isErr ? <span>Error: {status.error}</span> : (
        <span>Sent! <a href={`https://solscan.io/tx/${status.sig}`} target="_blank" rel="noreferrer" className="underline">View on Solscan</a></span>
      )}
      <button onClick={onClose} className="ml-3 opacity-60 hover:opacity-100">✕</button>
    </div>
  );
}

const TOKENS = ["SOL", "USDC", "BTC", "ETH", "JitoSOL"];

// ── Swap ──────────────────────────────────────────────────────────────────────

function SwapPanel({ solanaAddress, signTransaction }: { solanaAddress: string; signTransaction: SignFn }) {
  const [inSym, setInSym] = useState("SOL");
  const [outSym, setOutSym] = useState("USDC");
  const [amountIn, setAmountIn] = useState("");
  const [quote, setQuote] = useState<{ amountOut: number | null; fee: number | null } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  const fetchQuote = useCallback(async () => {
    const amt = parseFloat(amountIn);
    if (!amt || inSym === outSym) { setQuote(null); return; }
    setQuoteLoading(true);
    try {
      const r = await fetch(`/api/flash/swap-quote?inSymbol=${inSym}&outSymbol=${outSym}&amountIn=${amt}`);
      if (r.ok) setQuote(await r.json());
    } finally { setQuoteLoading(false); }
  }, [inSym, outSym, amountIn]);

  useEffect(() => {
    const t = setTimeout(fetchQuote, 600);
    return () => clearTimeout(t);
  }, [fetchQuote]);

  const swap = async () => {
    const amt = parseFloat(amountIn);
    if (!amt || inSym === outSym) return;
    setLoading(true); setStatus(null);
    try {
      const r = await fetch("/api/flash/build-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: solanaAddress, inSymbol: inSym, outSymbol: outSym, amountIn: amt }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction } = await r.json() as { transaction: string };
      const sig = await signAndSendTx(transaction, signTransaction);
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-zinc-400">From</label>
          <div className="flex gap-2">
            <select value={inSym} onChange={e => setInSym(e.target.value)} className="bg-zinc-800 rounded-lg px-2 py-2 text-sm text-white border border-zinc-700">
              {TOKENS.filter(t => t !== outSym).map(t => <option key={t}>{t}</option>)}
            </select>
            <input type="number" min="0" value={amountIn} onChange={e => setAmountIn(e.target.value)}
              placeholder="0.00" className="flex-1 bg-zinc-800 rounded-lg px-3 py-2 text-sm text-white border border-zinc-700" />
          </div>
        </div>
        <div className="flex items-end pb-1">
          <button onClick={() => { setInSym(outSym); setOutSym(inSym); setQuote(null); }} className="text-zinc-400 hover:text-white text-lg px-2">⇄</button>
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-xs text-zinc-400">To</label>
          <select value={outSym} onChange={e => setOutSym(e.target.value)} className="w-full bg-zinc-800 rounded-lg px-2 py-2 text-sm text-white border border-zinc-700">
            {TOKENS.filter(t => t !== inSym).map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {quote && (
        <div className="bg-zinc-800/50 rounded-xl p-3 text-xs space-y-1">
          <div className="flex justify-between"><span className="text-zinc-400">You receive</span><span className="text-white font-medium">{fmt(quote.amountOut)} {outSym}</span></div>
          <div className="flex justify-between"><span className="text-zinc-400">Fee</span><span className="text-zinc-300">{fmt(quote.fee)} {outSym}</span></div>
        </div>
      )}
      {quoteLoading && <p className="text-xs text-zinc-500">Fetching quote…</p>}

      <button onClick={swap} disabled={loading || !amountIn || inSym === outSym}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
        {loading ? "Swapping…" : "Swap"}
      </button>
      <TxResult status={status} onClose={() => setStatus(null)} />
    </div>
  );
}

// ── FLP Liquidity ─────────────────────────────────────────────────────────────

type LiqMode = "flp-add" | "flp-remove" | "sflp-add" | "sflp-remove" | "flp-reward";

function LiquidityPanel({ solanaAddress, signTransaction }: { solanaAddress: string; signTransaction: SignFn }) {
  const [mode, setMode] = useState<LiqMode>("flp-add");
  const [symbol, setSymbol] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<{ lpAmount?: number | null; amountOut?: number | null; fee: number | null; lpPrice?: number | null } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  const needsAmount = mode !== "flp-reward";
  const needsQuote = mode !== "flp-reward";

  const fetchQuote = useCallback(async () => {
    if (!needsQuote) { setQuote(null); return; }
    const amt = parseFloat(amount);
    if (!amt) { setQuote(null); return; }
    setQuoteLoading(true);
    try {
      const actionMap: Record<LiqMode, string> = {
        "flp-add": "add", "flp-remove": "remove",
        "sflp-add": "sflp-add", "sflp-remove": "sflp-remove", "flp-reward": "add",
      };
      const r = await fetch(`/api/flash/liquidity-quote?action=${actionMap[mode]}&symbol=${symbol}&amount=${amt}`);
      if (r.ok) setQuote(await r.json());
    } finally { setQuoteLoading(false); }
  }, [mode, needsQuote, symbol, amount]);

  useEffect(() => {
    const t = setTimeout(fetchQuote, 600);
    return () => clearTimeout(t);
  }, [fetchQuote]);

  const submit = async () => {
    const amt = parseFloat(amount);
    if (needsAmount && !amt) return;
    setLoading(true); setStatus(null);
    try {
      let url = ""; let body: Record<string, unknown> = { ownerAddress: solanaAddress };
      if (mode === "flp-add")      { url = "/api/flash/build-add-liquidity";     body = { ...body, inSymbol: symbol, amountIn: amt }; }
      if (mode === "flp-remove")   { url = "/api/flash/build-remove-liquidity";  body = { ...body, outSymbol: symbol, lpAmountIn: amt }; }
      if (mode === "sflp-add")     { url = "/api/flash/build-add-compounding";   body = { ...body, inSymbol: symbol, amountIn: amt }; }
      if (mode === "sflp-remove")  { url = "/api/flash/build-remove-compounding"; body = { ...body, outSymbol: symbol, sflpAmountIn: amt }; }
      if (mode === "flp-reward")   { url = "/api/flash/collect-flp-reward"; }
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await r.text());
      const { transaction } = await r.json() as { transaction: string };
      const sig = await signAndSendTx(transaction, signTransaction);
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  const MODES: { id: LiqMode; label: string }[] = [
    { id: "flp-add", label: "Add FLP" },
    { id: "flp-remove", label: "Remove FLP" },
    { id: "sflp-add", label: "Add sFLP" },
    { id: "sflp-remove", label: "Remove sFLP" },
    { id: "flp-reward", label: "Collect Rewards" },
  ];

  const btnLabel = () => {
    if (loading) return "Processing…";
    if (mode === "flp-add") return "Add FLP Liquidity";
    if (mode === "flp-remove") return "Remove FLP Liquidity";
    if (mode === "sflp-add") return "Add sFLP Liquidity";
    if (mode === "sflp-remove") return "Remove sFLP Liquidity";
    return "Collect FLP Rewards";
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {MODES.map(m => (
          <button key={m.id} onClick={() => { setMode(m.id); setQuote(null); setAmount(""); setStatus(null); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${mode === m.id ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"}`}>
            {m.label}
          </button>
        ))}
      </div>

      {mode === "flp-reward" ? (
        <p className="text-xs text-zinc-400 py-2">Collect your accumulated FLP staking rewards (paid in USDC).</p>
      ) : (
        <div className="flex gap-2">
          <select value={symbol} onChange={e => setSymbol(e.target.value)} className="bg-zinc-800 rounded-lg px-2 py-2 text-sm text-white border border-zinc-700">
            {TOKENS.map(t => <option key={t}>{t}</option>)}
          </select>
          <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder={mode.includes("add") ? "Amount to deposit" : mode === "flp-remove" ? "FLP amount" : "sFLP amount"}
            className="flex-1 bg-zinc-800 rounded-lg px-3 py-2 text-sm text-white border border-zinc-700" />
        </div>
      )}

      {quote && (
        <div className="bg-zinc-800/50 rounded-xl p-3 text-xs space-y-1">
          {mode === "flp-add" && (
            <>
              <div className="flex justify-between"><span className="text-zinc-400">FLP you receive</span><span className="text-white font-medium">{fmt((quote as {lpAmount?: number|null}).lpAmount)} FLP</span></div>
              {(quote as {lpPrice?: number|null}).lpPrice && <div className="flex justify-between"><span className="text-zinc-400">FLP price</span><span className="text-zinc-300">${fmt((quote as {lpPrice?: number|null}).lpPrice)}</span></div>}
            </>
          )}
          {mode === "sflp-add" && (
            <>
              <div className="flex justify-between"><span className="text-zinc-400">sFLP you receive</span><span className="text-white font-medium">{fmt((quote as {sflpAmount?: number|null}).sflpAmount)} sFLP</span></div>
              {(quote as {sflpPrice?: number|null}).sflpPrice && <div className="flex justify-between"><span className="text-zinc-400">sFLP price</span><span className="text-zinc-300">${fmt((quote as {sflpPrice?: number|null}).sflpPrice)}</span></div>}
            </>
          )}
          {(mode === "flp-remove" || mode === "sflp-remove") && (
            <div className="flex justify-between"><span className="text-zinc-400">You receive</span><span className="text-white font-medium">{fmt((quote as {amountOut?: number|null}).amountOut)} {symbol}</span></div>
          )}
          <div className="flex justify-between"><span className="text-zinc-400">Fee</span><span className="text-zinc-300">{fmt(quote.fee)}</span></div>
        </div>
      )}
      {quoteLoading && <p className="text-xs text-zinc-500">Fetching quote…</p>}

      <button onClick={submit} disabled={loading || (needsAmount && !amount)}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
        {btnLabel()}
      </button>
      <TxResult status={status} onClose={() => setStatus(null)} />
    </div>
  );
}

// ── FLASH Staking ─────────────────────────────────────────────────────────────

type StakeTab = "stake" | "unstake" | "cancel-unstake" | "withdraw" | "reward";

function StakingPanel({ solanaAddress, signTransaction }: { solanaAddress: string; signTransaction: SignFn }) {
  const [tab, setTab] = useState<StakeTab>("stake");
  const [amount, setAmount] = useState("");
  const [requestId, setRequestId] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  const needsAmount = tab === "stake" || tab === "unstake";
  const needsRequestId = tab === "cancel-unstake" || tab === "withdraw";

  const submit = async () => {
    if (needsAmount && !parseFloat(amount)) return;
    if (needsRequestId && !requestId) return;
    setLoading(true); setStatus(null);
    try {
      let url = ""; let body: Record<string, unknown> = { ownerAddress: solanaAddress };
      if (tab === "stake")          { url = "/api/flash/build-stake";    body.amount = parseFloat(amount); }
      if (tab === "unstake")        { url = "/api/flash/build-unstake";  body.amount = parseFloat(amount); }
      if (tab === "cancel-unstake") { url = "/api/flash/cancel-unstake"; body.withdrawRequestId = parseInt(requestId); }
      if (tab === "withdraw")       { url = "/api/flash/withdraw-flash"; body.withdrawRequestId = parseInt(requestId); }
      if (tab === "reward")         { url = "/api/flash/collect-stake-reward"; }
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(await r.text());
      const { transaction } = await r.json() as { transaction: string };
      const sig = await signAndSendTx(transaction, signTransaction);
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  const TABS: { id: StakeTab; label: string }[] = [
    { id: "stake", label: "Stake" },
    { id: "unstake", label: "Unstake" },
    { id: "cancel-unstake", label: "Cancel Unstake" },
    { id: "withdraw", label: "Withdraw" },
    { id: "reward", label: "Collect Rewards" },
  ];

  const btnLabel = () => {
    if (loading) return "Processing…";
    const map: Record<StakeTab, string> = {
      stake: "Stake FLASH", unstake: "Request Unstake", "cancel-unstake": "Cancel Unstake",
      withdraw: "Withdraw FLASH", reward: "Collect FLASH Rewards",
    };
    return map[tab];
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setStatus(null); setAmount(""); setRequestId(""); }}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${tab === t.id ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {needsAmount && (
        <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)}
          placeholder="FLASH amount"
          className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm text-white border border-zinc-700" />
      )}

      {needsRequestId && (
        <div className="space-y-1">
          <input type="number" min="0" value={requestId} onChange={e => setRequestId(e.target.value)}
            placeholder="Withdraw request ID (0, 1, 2…)"
            className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm text-white border border-zinc-700" />
          <p className="text-[10px] text-zinc-500">The index of the unstake request in your stake account.</p>
        </div>
      )}

      {tab === "reward" && (
        <p className="text-xs text-zinc-400 py-1">Collect your accumulated FLASH token staking rewards.</p>
      )}

      <button onClick={submit} disabled={loading || (needsAmount && !amount) || (needsRequestId && !requestId)}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
        {btnLabel()}
      </button>
      <TxResult status={status} onClose={() => setStatus(null)} />
    </div>
  );
}

// ── Rebates & Referral ────────────────────────────────────────────────────────

function RebatesPanel({ solanaAddress, signTransaction }: { solanaAddress: string; signTransaction: SignFn }) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  const collect = async () => {
    setLoading(true); setStatus(null);
    try {
      const r = await fetch("/api/flash/collect-rebate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: solanaAddress }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction } = await r.json() as { transaction: string };
      const sig = await signAndSendTx(transaction, signTransaction);
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">Collect your earned trading fee rebates in USDC.</p>
      <button onClick={collect} disabled={loading}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
        {loading ? "Collecting…" : "Collect Rebates"}
      </button>
      <TxResult status={status} onClose={() => setStatus(null)} />
    </div>
  );
}

function ReferralPanel({ solanaAddress, signTransaction }: { solanaAddress: string; signTransaction: SignFn }) {
  const [referrer, setReferrer] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  const create = async () => {
    if (!referrer) return;
    setLoading(true); setStatus(null);
    try {
      const r = await fetch("/api/flash/create-referral", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: solanaAddress, referrerAddress: referrer }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction } = await r.json() as { transaction: string };
      const sig = await signAndSendTx(transaction, signTransaction);
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">Link a referrer wallet to earn rebates on your trades.</p>
      <input value={referrer} onChange={e => setReferrer(e.target.value)}
        placeholder="Referrer wallet address"
        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm text-white border border-zinc-700" />
      <button onClick={create} disabled={loading || !referrer}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
        {loading ? "Processing…" : "Set Referrer"}
      </button>
      <TxResult status={status} onClose={() => setStatus(null)} />
    </div>
  );
}

// ── Migrate FLP ↔ sFLP ────────────────────────────────────────────────────────

function MigratePanel({ solanaAddress, signTransaction }: { solanaAddress: string; signTransaction: SignFn }) {
  const [direction, setDirection] = useState<"to-sflp" | "to-flp">("to-sflp");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  const submit = async () => {
    const amt = parseFloat(amount);
    if (!amt) return;
    setLoading(true); setStatus(null);
    try {
      const url = direction === "to-sflp" ? "/api/flash/migrate-stake" : "/api/flash/migrate-flp";
      const bodyKey = direction === "to-sflp" ? "flpAmount" : "sflpAmount";
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: solanaAddress, [bodyKey]: amt }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction } = await r.json() as { transaction: string };
      const sig = await signAndSendTx(transaction, signTransaction);
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">Convert between staked FLP (manual rewards) and sFLP (auto-compounding).</p>
      <div className="flex gap-1">
        {([["to-sflp", "FLP → sFLP"], ["to-flp", "sFLP → FLP"]] as const).map(([id, label]) => (
          <button key={id} onClick={() => { setDirection(id); setAmount(""); setStatus(null); }}
            className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${direction === id ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"}`}>
            {label}
          </button>
        ))}
      </div>
      <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)}
        placeholder={direction === "to-sflp" ? "FLP amount to convert" : "sFLP amount to convert"}
        className="w-full bg-zinc-800 rounded-lg px-3 py-2 text-sm text-white border border-zinc-700" />
      <button onClick={submit} disabled={loading || !amount}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
        {loading ? "Processing…" : direction === "to-sflp" ? "Migrate to sFLP" : "Migrate to FLP"}
      </button>
      <TxResult status={status} onClose={() => setStatus(null)} />
    </div>
  );
}

// ── Collect Revenue ───────────────────────────────────────────────────────────

function CollectRevenuePanel({ solanaAddress, signTransaction }: { solanaAddress: string; signTransaction: SignFn }) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  const collect = async () => {
    setLoading(true); setStatus(null);
    try {
      const r = await fetch("/api/flash/collect-revenue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: solanaAddress }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction } = await r.json() as { transaction: string };
      const sig = await signAndSendTx(transaction, signTransaction);
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">Collect your referral program revenue share (paid in USDC). Only available if you have referred active traders.</p>
      <button onClick={collect} disabled={loading}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
        {loading ? "Collecting…" : "Collect Revenue"}
      </button>
      <TxResult status={status} onClose={() => setStatus(null)} />
    </div>
  );
}

// ── Trade Vault ───────────────────────────────────────────────────────────────

function TradeVaultPanel({ solanaAddress, signTransaction }: { solanaAddress: string; signTransaction: SignFn }) {
  const [action, setAction] = useState<"deposit" | "withdraw">("deposit");
  const [symbol, setSymbol] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  const submit = async () => {
    const amt = parseFloat(amount);
    if (!amt) return;
    setLoading(true); setStatus(null);
    try {
      const url = action === "deposit" ? "/api/flash/deposit-direct" : "/api/flash/withdrawal";
      const r = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: solanaAddress, tokenSymbol: symbol, amount: amt }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction } = await r.json() as { transaction: string };
      const sig = await signAndSendTx(transaction, signTransaction);
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">Fund or withdraw from your Flash trade vault — the on-chain escrow that backs open positions.</p>
      <div className="flex gap-2 bg-zinc-800 rounded-xl p-1">
        {(["deposit", "withdraw"] as const).map(a => (
          <button key={a} onClick={() => { setAction(a); setStatus(null); setAmount(""); }}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${action === a ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-white"}`}>
            {a === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <select value={symbol} onChange={e => setSymbol(e.target.value)} className="bg-zinc-800 rounded-lg px-2 py-2 text-sm text-white border border-zinc-700">
          {TOKENS.map(t => <option key={t}>{t}</option>)}
        </select>
        <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)}
          placeholder="Amount"
          className="flex-1 bg-zinc-800 rounded-lg px-3 py-2 text-sm text-white border border-zinc-700" />
      </div>
      <button onClick={submit} disabled={loading || !amount}
        className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
        {loading ? "Processing…" : action === "deposit" ? "Deposit to Vault" : "Withdraw from Vault"}
      </button>
      <TxResult status={status} onClose={() => setStatus(null)} />
    </div>
  );
}

// ── Main section ──────────────────────────────────────────────────────────────

// ── Session Keys ──────────────────────────────────────────────────────────────

const SESSION_KEY = "flash_session_keypair";
const SOL_RPC_URL = "https://api.mainnet-beta.solana.com";

function loadStoredSession(): { pubkey: string; secretKey: number[]; expiresAt: number } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.expiresAt < Date.now()) { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}

function SessionPanel({ solanaAddress, signTransaction }: { solanaAddress: string; signTransaction: SignFn }) {
  const [session, setSession] = useState<{ pubkey: string; expiresAt: number } | null>(null);
  const [duration, setDuration] = useState(8);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TxStatus>(null);

  useEffect(() => {
    const s = loadStoredSession();
    if (s) setSession({ pubkey: s.pubkey, expiresAt: s.expiresAt });
  }, []);

  const createSession = async () => {
    setLoading(true); setStatus(null);
    try {
      const sessionKp = Keypair.generate();
      const sessionPubkey = sessionKp.publicKey.toBase58();

      const r = await fetch("/api/flash/create-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: solanaAddress, sessionSignerPubkey: sessionPubkey, durationHours: duration }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction: base64Tx } = await r.json() as { transaction: string };

      // Deserialize, have the session keypair sign first, then Privy owner signs
      const txBuf = Buffer.from(base64Tx, "base64");
      const tx = Transaction.from(txBuf);
      tx.partialSign(sessionKp);
      const partialSerialized = tx.serialize({ requireAllSignatures: false });
      const partialB64 = Buffer.from(partialSerialized).toString("base64");

      const result = await signTransaction({ transaction: Buffer.from(partialB64, "base64") });
      const signed: Transaction = result?.signedTransaction ?? result;
      const finalSerialized = signed.serialize();

      const conn = new Connection(SOL_RPC_URL, "confirmed");
      const sig = await conn.sendRawTransaction(finalSerialized, { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");

      const expiresAt = Date.now() + duration * 60 * 60 * 1000;
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        pubkey: sessionPubkey,
        secretKey: Array.from(sessionKp.secretKey),
        expiresAt,
      }));
      setSession({ pubkey: sessionPubkey, expiresAt });
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  const revokeSession = async () => {
    const stored = loadStoredSession();
    if (!stored) { setStatus({ error: "No active session found" }); return; }
    setLoading(true); setStatus(null);
    try {
      const r = await fetch("/api/flash/revoke-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerAddress: solanaAddress, sessionSignerPubkey: stored.pubkey }),
      });
      if (!r.ok) throw new Error(await r.text());
      const { transaction: base64Tx } = await r.json() as { transaction: string };
      const sig = await signAndSendTx(base64Tx, signTransaction);
      localStorage.removeItem(SESSION_KEY);
      setSession(null);
      setStatus({ sig });
    } catch (e) { setStatus({ error: (e as Error).message }); }
    finally { setLoading(false); }
  };

  const expiresIn = session
    ? Math.max(0, Math.round((session.expiresAt - Date.now()) / (1000 * 60)))
    : null;

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">
        A trading session lets Bluvfi execute Flash trades without a wallet popup every time. The session keypair is stored locally in your browser and expires automatically.
      </p>

      {session ? (
        <div className="rounded-xl bg-green-500/10 border border-green-500/20 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-sm text-green-400 font-medium">Session active</span>
          </div>
          <p className="text-xs text-zinc-400">Expires in ~{expiresIn}m</p>
          <p className="text-xs text-zinc-500 font-mono truncate">{session.pubkey}</p>
        </div>
      ) : (
        <div className="space-y-2">
          <label className="text-xs text-zinc-400">Duration</label>
          <div className="flex gap-1 flex-wrap">
            {[1, 4, 8, 24].map(h => (
              <button key={h} onClick={() => setDuration(h)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${duration === h ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-white"}`}>
                {h}h
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        {!session && (
          <button onClick={createSession} disabled={loading}
            className="flex-1 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
            {loading ? "Creating…" : "Start Session"}
          </button>
        )}
        {session && (
          <button onClick={revokeSession} disabled={loading}
            className="flex-1 py-3 rounded-xl bg-red-600/80 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-semibold transition-colors">
            {loading ? "Revoking…" : "End Session"}
          </button>
        )}
      </div>
      <TxResult status={status} onClose={() => setStatus(null)} />
    </div>
  );
}

type Tab = "swap" | "liquidity" | "staking" | "vault" | "rebates" | "referral" | "migrate" | "revenue" | "session";

const TABS: { id: Tab; label: string }[] = [
  { id: "swap", label: "Swap" },
  { id: "liquidity", label: "Liquidity" },
  { id: "staking", label: "Staking" },
  { id: "migrate", label: "Migrate" },
  { id: "vault", label: "Trade Vault" },
  { id: "rebates", label: "Rebates" },
  { id: "revenue", label: "Revenue" },
  { id: "referral", label: "Referral" },
  { id: "session", label: "Session" },
];

export function FlashExtrasSection() {
  const { user, authenticated } = usePrivy();
  const { signTransaction } = useSignTransaction();
  const [tab, setTab] = useState<Tab>("swap");

  const solanaAddress = user?.linkedAccounts?.find(
    (a) => a.type === "wallet" && (a as { chainType?: string }).chainType === "solana"
  ) as { address?: string } | undefined;
  const solAddr = solanaAddress?.address ?? "";

  if (!authenticated || !solAddr) {
    return (
      <div className="rounded-2xl bg-zinc-900 border border-zinc-800 p-6 text-center text-sm text-zinc-400">
        Connect your Solana wallet to use Flash features.
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-zinc-900 border border-zinc-800 overflow-hidden">
      {/* Tab bar */}
      <div className="flex overflow-x-auto scrollbar-none border-b border-zinc-800">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex-shrink-0 px-4 py-3 text-sm font-medium transition-colors border-b-2 ${
              tab === t.id ? "border-blue-500 text-white" : "border-transparent text-zinc-400 hover:text-white"
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Panel */}
      <div className="p-4">
        {tab === "swap" && <SwapPanel solanaAddress={solAddr} signTransaction={signTransaction} />}
        {tab === "liquidity" && <LiquidityPanel solanaAddress={solAddr} signTransaction={signTransaction} />}
        {tab === "staking" && <StakingPanel solanaAddress={solAddr} signTransaction={signTransaction} />}
        {tab === "vault" && <TradeVaultPanel solanaAddress={solAddr} signTransaction={signTransaction} />}
        {tab === "rebates" && <RebatesPanel solanaAddress={solAddr} signTransaction={signTransaction} />}
        {tab === "revenue" && <CollectRevenuePanel solanaAddress={solAddr} signTransaction={signTransaction} />}
        {tab === "referral" && <ReferralPanel solanaAddress={solAddr} signTransaction={signTransaction} />}
        {tab === "migrate" && <MigratePanel solanaAddress={solAddr} signTransaction={signTransaction} />}
        {tab === "session" && <SessionPanel solanaAddress={solAddr} signTransaction={signTransaction} />}
      </div>
    </div>
  );
}
