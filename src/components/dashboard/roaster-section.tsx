"use client";

import { useState, useEffect, useCallback } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction } from "@privy-io/react-auth/solana";
import { Connection } from "@solana/web3.js";

const SOL_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

// ── Types ─────────────────────────────────────────────────────────────────────

type DurationTier = "15m" | "6h" | "24h";
type BattleStatus = "open" | "live" | "judging" | "settled" | "voided";

interface BattleSide {
  name: string;
  pool_usdc: number;
  track_url?: string;
  creator_address?: string;
  rap_id?: string;
}

interface Battle {
  battle_id: string;
  topic: string;
  sides: [BattleSide, BattleSide];
  status: BattleStatus;
  duration_tier: DurationTier;
  starts_at: string;
  ends_at: string;
  creator_address: string;
  total_pool_usdc: number;
  winner_side?: 0 | 1;
  jury_transcript_url?: string;
  jury_irys_tx_id?: string;
  created_at: string;
}

interface Rap {
  rap_id: string;
  battle_id: string;
  side: 0 | 1;
  creator_address: string;
  angles: string[];
  bars?: string;
  track_url?: string;
  status: "generating" | "ready" | "failed";
  created_at: string;
}

interface LeaderboardEntry {
  rank: number;
  address: string;
  username?: string;
  wins: number;
  losses: number;
  total_backed_usdc: number;
  total_earned_usdc: number;
  battles_created: number;
  raps_created: number;
}

interface Backing {
  backing_id: string;
  battle_id: string;
  side: 0 | 1;
  amount_usdc: number;
  time_weight: number;
  potential_payout_usdc?: number;
  created_at: string;
}

type Tab = "browse" | "rap" | "create" | "leaderboard" | "my";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | undefined, d = 2) {
  if (n == null) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function statusLabel(s: BattleStatus) {
  const m: Record<BattleStatus, string> = { open: "Open", live: "Live", judging: "Judging…", settled: "Settled", voided: "Voided" };
  return m[s];
}

function timeLeft(endsAt: string) {
  const diff = new Date(endsAt).getTime() - Date.now();
  if (diff <= 0) return "Ended";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function userSignAndSendTx(b64: string, signTransaction: (input: any) => Promise<any>): Promise<string> {
  const conn = new Connection(SOL_RPC, "confirmed");
  const raw = Buffer.from(b64, "base64");
  const signed: Uint8Array = await (signTransaction as any)({ transaction: raw });
  const sig = await conn.sendRawTransaction(signed, { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[#A7A79A]">{label}</span>
      <span className="text-[#F2F0E8] font-medium">{value}</span>
    </div>
  );
}

// ── Battle Card ───────────────────────────────────────────────────────────────

function BattleCard({
  battle,
  onBack,
  onRap,
}: {
  battle: Battle;
  onBack: (b: Battle) => void;
  onRap: (b: Battle) => void;
}) {
  const totalPool = battle.total_pool_usdc;
  const sideAShare = totalPool > 0 ? (battle.sides[0].pool_usdc / totalPool) * 100 : 50;

  return (
    <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-[#F2F0E8] text-sm leading-snug">{battle.topic}</p>
          <p className="text-xs text-[#A7A79A] mt-0.5">{battle.duration_tier} · {timeLeft(battle.ends_at)}</p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${
          battle.status === "open" ? "text-yellow-400 bg-yellow-400/10" :
          battle.status === "live" ? "text-blue-400 bg-blue-400/10" :
          battle.status === "judging" ? "text-purple-400 bg-purple-400/10" :
          battle.status === "settled" ? "text-green-400 bg-green-400/10" :
          "text-red-400 bg-red-400/10"
        }`}>
          {statusLabel(battle.status)}
        </span>
      </div>

      {/* Pool bar */}
      <div>
        <div className="flex justify-between text-xs text-[#A7A79A] mb-1">
          <span>{battle.sides[0].name}</span>
          <span>{battle.sides[1].name}</span>
        </div>
        <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden flex">
          <div className="bg-blue-500 h-full transition-all" style={{ width: `${sideAShare}%` }} />
          <div className="bg-orange-500 h-full flex-1" />
        </div>
        <div className="flex justify-between text-xs mt-1">
          <span className="text-blue-400">${fmt(battle.sides[0].pool_usdc)}</span>
          <span className="text-[#A7A79A]">Total ${fmt(totalPool)}</span>
          <span className="text-orange-400">${fmt(battle.sides[1].pool_usdc)}</span>
        </div>
      </div>

      {/* Track links */}
      {(battle.sides[0].track_url || battle.sides[1].track_url) && (
        <div className="flex gap-2">
          {battle.sides.map((s, i) => s.track_url ? (
            <a key={i} href={s.track_url} target="_blank" rel="noopener noreferrer"
               className={`flex-1 text-center text-xs py-1.5 rounded-lg ${i === 0 ? "text-blue-400 bg-blue-400/10" : "text-orange-400 bg-orange-400/10"} hover:opacity-80`}>
              ▶ {s.name}
            </a>
          ) : null)}
        </div>
      )}

      {/* Winner banner */}
      {battle.status === "settled" && battle.winner_side !== undefined && (
        <div className="rounded-xl bg-green-400/10 border border-green-400/20 px-3 py-2 text-xs text-green-400 text-center font-medium">
          🏆 Winner: {battle.sides[battle.winner_side].name}
        </div>
      )}
      {battle.status === "voided" && (
        <div className="rounded-xl bg-red-400/10 border border-red-400/20 px-3 py-2 text-xs text-red-400 text-center font-medium">
          Voided — all stakes refunded
        </div>
      )}

      {/* Actions */}
      {(battle.status === "open" || battle.status === "live") && (
        <div className="flex gap-2">
          <button onClick={() => onRap(battle)}
            className="flex-1 rounded-xl border border-[#2A2B27] text-[#A7A79A] text-xs font-medium py-2 hover:border-[#3A3B37] hover:text-[#F2F0E8] transition-colors">
            🎤 Create Rap
          </button>
          <button onClick={() => onBack(battle)}
            className="flex-1 rounded-xl bg-[#F2F0E8] text-[#141513] text-xs font-semibold py-2 hover:bg-white transition-colors">
            💰 Back a Side
          </button>
        </div>
      )}

      {(battle.jury_transcript_url || battle.jury_irys_tx_id) && (
        <div className="flex gap-2">
          {battle.jury_transcript_url && (
            <a href={battle.jury_transcript_url} target="_blank" rel="noopener noreferrer"
               className="flex-1 text-center text-xs text-[#A7A79A] hover:text-[#F2F0E8] transition-colors py-1 rounded-lg border border-[#2A2B27]">
              Jury transcript ↗
            </a>
          )}
          {battle.jury_irys_tx_id && (
            <a href={`https://gateway.irys.xyz/${battle.jury_irys_tx_id}`} target="_blank" rel="noopener noreferrer"
               className="flex-1 text-center text-xs text-[#A7A79A] hover:text-[#F2F0E8] transition-colors py-1 rounded-lg border border-[#2A2B27]">
              Verify on Irys ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Back Side Sheet ───────────────────────────────────────────────────────────

function BackSideSheet({
  battle,
  solanaAddress,
  signTransaction,
  onClose,
  onSuccess,
}: {
  battle: Battle;
  solanaAddress: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: (input: any) => Promise<any>;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [side, setSide] = useState<0 | 1>(0);
  const [amount, setAmount] = useState("10");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const amountNum = Math.max(0, Number(amount) || 0);
  const fee = amountNum * 0.0125;
  const net = amountNum - fee;
  const myPool = battle.sides[side].pool_usdc;
  const otherPool = battle.sides[side === 0 ? 1 : 0].pool_usdc;
  const estimatedPayout = net > 0 ? net + (net / (myPool + net)) * otherPool : 0;

  async function handleBack() {
    if (!amountNum || amountNum <= 0) { setError("Enter a valid amount"); return; }
    setError(null);
    setLoading(true);
    try {
      const r = await fetch(`/api/roaster/battles/${battle.battle_id}/back`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, amount_usdc: amountNum, backer_address: solanaAddress }),
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error ?? "Failed to prepare transaction");
      await userSignAndSendTx(data.transaction, signTransaction);
      setSuccess(`Backed ${battle.sides[side].name} with $${fmt(amountNum)} USDC!`);
      setTimeout(() => onSuccess(), 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-semibold text-[#F2F0E8]">{battle.topic}</p>
      <div>
        <p className="text-xs text-[#A7A79A] mb-2">Pick a side</p>
        <div className="grid grid-cols-2 gap-2">
          {([0, 1] as const).map((s) => (
            <button key={s} onClick={() => setSide(s)}
              className={`rounded-xl border p-3 text-sm font-medium transition-colors ${
                side === s ? "border-[#F2F0E8] text-[#F2F0E8] bg-white/[0.08]" : "border-[#2A2B27] text-[#A7A79A] hover:border-[#3A3B37]"
              }`}>
              {battle.sides[s].name}
              <span className="block text-xs font-normal mt-0.5 text-[#A7A79A]">Pool: ${fmt(battle.sides[s].pool_usdc)}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-[#A7A79A] mb-1.5">Amount (USDC)</p>
        <input type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)}
          className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 text-[#F2F0E8] text-sm outline-none focus:border-[#4A4B47] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
        <div className="flex gap-2 mt-2">
          {[5, 10, 25, 50].map((v) => (
            <button key={v} onClick={() => setAmount(String(v))}
              className="flex-1 rounded-lg bg-white/[0.06] py-1.5 text-xs text-[#A7A79A] hover:text-[#F2F0E8] transition-colors">
              ${v}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] p-3 flex flex-col gap-1.5">
        <InfoRow label="Backing amount" value={`$${fmt(amountNum)} USDC`} />
        <InfoRow label="Platform fee (1.25%)" value={`-$${fmt(fee)}`} />
        <div className="border-t border-[#2A2B27] my-0.5" />
        <InfoRow label="Net into pool" value={`$${fmt(net)} USDC`} />
        {estimatedPayout > 0 && (
          <>
            <div className="border-t border-[#2A2B27] my-0.5" />
            <div className="flex items-center justify-between text-sm">
              <span className="text-[#A7A79A]">Est. payout if {battle.sides[side].name} wins</span>
              <span className="text-green-400 font-semibold">${fmt(estimatedPayout)}</span>
            </div>
          </>
        )}
      </div>

      <p className="text-xs text-[#A7A79A]">
        Earlier backing earns a higher time-weight — you earn more of the winning pool the earlier you back.
      </p>

      {error && <p className="text-xs text-red-400 bg-red-400/10 rounded-xl px-3 py-2">{error}</p>}
      {success && <p className="text-xs text-green-400 bg-green-400/10 rounded-xl px-3 py-2">{success}</p>}

      <div className="flex gap-2">
        <button onClick={onClose}
          className="flex-1 rounded-xl border border-[#2A2B27] text-[#A7A79A] text-sm py-3 hover:border-[#3A3B37] transition-colors">
          Cancel
        </button>
        <button onClick={handleBack} disabled={loading || !amountNum || !!success}
          className="flex-1 rounded-xl bg-[#F2F0E8] text-[#141513] text-sm font-semibold py-3 hover:bg-white transition-colors disabled:opacity-50">
          {loading ? "Signing…" : `Back ${battle.sides[side].name}`}
        </button>
      </div>
    </div>
  );
}

// ── Create Rap Form ───────────────────────────────────────────────────────────

function CreateRapForm({
  battle,
  solanaAddress,
  onClose,
  onSuccess,
}: {
  battle: Battle;
  solanaAddress: string;
  onClose: () => void;
  onSuccess: (rap: Rap) => void;
}) {
  const [side, setSide] = useState<0 | 1>(0);
  const [angles, setAngles] = useState(["", "", ""]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Rap | null>(null);

  function setAngle(i: number, val: string) {
    setAngles((prev) => prev.map((a, idx) => idx === i ? val : a));
  }

  const filledAngles = angles.filter((a) => a.trim().length > 0);
  const sideAlreadyLocked = !!battle.sides[side].rap_id;

  async function handleCreate() {
    if (filledAngles.length === 0) { setError("Enter at least one angle"); return; }
    if (sideAlreadyLocked) { setError("This side already has a rap — first to finish locks the side"); return; }
    setError(null);
    setLoading(true);
    try {
      const r = await fetch(`/api/roaster/battles/${battle.battle_id}/raps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side, angles: filledAngles, creator_address: solanaAddress }),
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error ?? "Failed");
      setResult(data);
      setTimeout(() => onSuccess(data), 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-semibold text-[#F2F0E8]">{battle.topic}</p>

      <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] px-3 py-2.5 text-xs text-[#A7A79A]">
        AI writes every bar and produces the full audio track from your angles. Creating a rap is free — you earn <span className="text-[#F2F0E8]">0.60%</span> of all backing on this battle and receive an IP Revenue NFT at settlement.
      </div>

      <div>
        <p className="text-xs text-[#A7A79A] mb-2">Pick your side</p>
        <div className="grid grid-cols-2 gap-2">
          {([0, 1] as const).map((s) => (
            <button key={s} onClick={() => setSide(s)}
              className={`rounded-xl border p-3 text-sm font-medium transition-colors relative ${
                side === s ? "border-[#F2F0E8] text-[#F2F0E8] bg-white/[0.08]" : "border-[#2A2B27] text-[#A7A79A] hover:border-[#3A3B37]"
              }`}>
              {battle.sides[s].name}
              {battle.sides[s].rap_id && (
                <span className="block text-xs font-normal mt-0.5 text-red-400">Locked</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs text-[#A7A79A] mb-1.5">Creative angles <span className="text-[#5A5B57]">(what the AI should emphasize)</span></p>
        {angles.map((a, i) => (
          <input key={i} type="text" placeholder={`Angle ${i + 1}${i === 0 ? " (required)" : " (optional)"}`}
            value={a} onChange={(e) => setAngle(i, e.target.value)}
            className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 text-[#F2F0E8] text-sm outline-none focus:border-[#4A4B47] placeholder:text-[#5A5B57] mb-2 last:mb-0" />
        ))}
        <div className="grid grid-cols-3 gap-1.5 mt-2">
          {["wordplay", "storytelling", "braggadocio", "social commentary", "humor", "metaphors"].map((s) => (
            <button key={s} onClick={() => {
              const idx = angles.findIndex((a) => a.trim() === "");
              if (idx >= 0) setAngle(idx, s);
            }}
              className="rounded-lg bg-white/[0.04] border border-[#2A2B27] py-1.5 text-xs text-[#A7A79A] hover:text-[#F2F0E8] hover:border-[#3A3B37] transition-colors">
              {s}
            </button>
          ))}
        </div>
      </div>

      {sideAlreadyLocked && (
        <p className="text-xs text-red-400 bg-red-400/10 rounded-xl px-3 py-2">This side is already locked by another creator.</p>
      )}
      {error && <p className="text-xs text-red-400 bg-red-400/10 rounded-xl px-3 py-2">{error}</p>}
      {result && (
        <div className="rounded-xl bg-green-400/10 border border-green-400/20 px-3 py-2.5 text-xs text-green-400">
          ✓ Rap submitted! AI is generating bars + producing your track…
          <span className="block text-[#A7A79A] mt-1">Rap ID: {result.rap_id}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={onClose}
          className="flex-1 rounded-xl border border-[#2A2B27] text-[#A7A79A] text-sm py-3 hover:border-[#3A3B37] transition-colors">
          Cancel
        </button>
        <button onClick={handleCreate} disabled={loading || filledAngles.length === 0 || sideAlreadyLocked || !!result}
          className="flex-1 rounded-xl bg-[#F2F0E8] text-[#141513] text-sm font-semibold py-3 hover:bg-white transition-colors disabled:opacity-50">
          {loading ? "Generating…" : "Create Rap"}
        </button>
      </div>
    </div>
  );
}

// ── Create Battle Form ────────────────────────────────────────────────────────

function CreateBattleForm({
  solanaAddress,
  signTransaction,
  onSuccess,
}: {
  solanaAddress: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTransaction: (input: any) => Promise<any>;
  onSuccess: () => void;
}) {
  const [topic, setTopic] = useState("");
  const [sideA, setSideA] = useState("");
  const [sideB, setSideB] = useState("");
  const [duration, setDuration] = useState<DurationTier>("6h");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleCreate() {
    if (!topic.trim()) { setError("Topic is required"); return; }
    if (!sideA.trim() || !sideB.trim()) { setError("Both side names are required"); return; }
    setError(null);
    setLoading(true);
    try {
      const r = await fetch("/api/roaster/battles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          side_a_name: sideA.trim(),
          side_b_name: sideB.trim(),
          duration_tier: duration,
          creator_address: solanaAddress,
        }),
      });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error ?? "Failed to create battle");
      await userSignAndSendTx(data.bond_transaction, signTransaction);
      setSuccess(`Battle created! ID: ${data.battle_id}`);
      setTimeout(() => onSuccess(), 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl bg-yellow-400/10 border border-yellow-400/20 px-3 py-2.5 text-xs text-yellow-400">
        Creating a battle requires a <strong>non-refundable 10 USDC bond</strong> deposited on-chain. You earn 0.25% of all backing volume as the creator.
      </div>

      <div>
        <p className="text-xs text-[#A7A79A] mb-1.5">Battle topic</p>
        <input type="text" placeholder="e.g. AI vs Human Creativity" value={topic}
          onChange={(e) => setTopic(e.target.value)}
          className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 text-[#F2F0E8] text-sm outline-none focus:border-[#4A4B47] placeholder:text-[#5A5B57]" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-xs text-[#A7A79A] mb-1.5">Side A name</p>
          <input type="text" placeholder="e.g. Robots" value={sideA}
            onChange={(e) => setSideA(e.target.value)}
            className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-3 text-[#F2F0E8] text-sm outline-none focus:border-[#4A4B47] placeholder:text-[#5A5B57]" />
        </div>
        <div>
          <p className="text-xs text-[#A7A79A] mb-1.5">Side B name</p>
          <input type="text" placeholder="e.g. Humans" value={sideB}
            onChange={(e) => setSideB(e.target.value)}
            className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-3 text-[#F2F0E8] text-sm outline-none focus:border-[#4A4B47] placeholder:text-[#5A5B57]" />
        </div>
      </div>

      <div>
        <p className="text-xs text-[#A7A79A] mb-1.5">Duration</p>
        <div className="grid grid-cols-3 gap-2">
          {(["15m", "6h", "24h"] as DurationTier[]).map((d) => (
            <button key={d} onClick={() => setDuration(d)}
              className={`rounded-xl border py-2.5 text-sm font-medium transition-colors ${
                duration === d ? "border-[#F2F0E8] text-[#F2F0E8] bg-white/[0.08]" : "border-[#2A2B27] text-[#A7A79A] hover:border-[#3A3B37]"
              }`}>
              {d}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] p-3 flex flex-col gap-1.5">
        <InfoRow label="Creation bond" value="10 USDC (non-refundable)" />
        <InfoRow label="Creator fee earned" value="0.25% of all backing volume" />
        <InfoRow label="Duration" value={duration === "15m" ? "15 minutes" : duration === "6h" ? "6 hours" : "24 hours"} />
      </div>

      {error && <p className="text-xs text-red-400 bg-red-400/10 rounded-xl px-3 py-2">{error}</p>}
      {success && <p className="text-xs text-green-400 bg-green-400/10 rounded-xl px-3 py-2">{success}</p>}

      <button onClick={handleCreate} disabled={loading || !!success}
        className="w-full rounded-xl bg-[#F2F0E8] text-[#141513] text-sm font-semibold py-3 hover:bg-white transition-colors disabled:opacity-50">
        {loading ? "Signing…" : "Create Battle (10 USDC bond)"}
      </button>
    </div>
  );
}

// ── Leaderboard Tab ───────────────────────────────────────────────────────────

function LeaderboardTab() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [metric, setMetric] = useState<"earnings" | "wins" | "battles_created">("earnings");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/roaster/leaderboard?limit=20&metric=${metric}`);
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error ?? "Failed");
      setEntries(data.entries ?? []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load leaderboard");
    } finally {
      setLoading(false);
    }
  }, [metric]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-white/[0.04] p-1">
        {(["earnings", "wins", "battles_created"] as const).map((m) => (
          <button key={m} onClick={() => setMetric(m)}
            className={`rounded-lg py-1.5 text-xs font-medium transition-colors ${metric === m ? "bg-white/[0.1] text-[#F2F0E8]" : "text-[#A7A79A]"}`}>
            {m === "earnings" ? "Top Earners" : m === "wins" ? "Most Wins" : "Top Creators"}
          </button>
        ))}
      </div>

      {loading && Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-14 rounded-xl bg-white/[0.04] animate-pulse" />
      ))}

      {error && <div className="rounded-xl bg-red-400/10 border border-red-400/20 px-3 py-2.5 text-xs text-red-400">{error}</div>}

      {!loading && !error && entries.length === 0 && (
        <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] p-6 text-center">
          <p className="text-[#A7A79A] text-sm">No entries yet</p>
        </div>
      )}

      {entries.map((e) => (
        <div key={e.address} className="flex items-center gap-3 rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3">
          <span className={`text-sm font-bold w-6 shrink-0 ${e.rank <= 3 ? "text-yellow-400" : "text-[#A7A79A]"}`}>
            #{e.rank}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[#F2F0E8]">{e.username ?? shortAddr(e.address)}</p>
            <p className="text-xs text-[#A7A79A]">{e.wins}W · {e.losses}L · {e.battles_created} battles · {e.raps_created ?? 0} raps</p>
          </div>
          <div className="text-right">
            {metric === "earnings" && <p className="text-sm font-semibold text-green-400">${fmt(e.total_earned_usdc)}</p>}
            {metric === "wins" && <p className="text-sm font-semibold text-[#F2F0E8]">{e.wins} wins</p>}
            {metric === "battles_created" && <p className="text-sm font-semibold text-[#F2F0E8]">{e.battles_created}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── My Activity Tab ───────────────────────────────────────────────────────────

type MyTab = "backings" | "battles" | "raps";

interface BattleWallet {
  address: string;
  balance_usdc: number;
  pending_payouts_usdc: number;
}

function MyActivityTab({ solanaAddress }: { solanaAddress: string }) {
  const [myTab, setMyTab] = useState<MyTab>("backings");
  const [backings, setBackings] = useState<Backing[]>([]);
  const [myBattles, setMyBattles] = useState<Battle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [wallet, setWallet] = useState<BattleWallet | null>(null);

  const referralLink = `https://roaster.gg?ref=${solanaAddress}`;

  function copyReferral() {
    navigator.clipboard.writeText(referralLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  useEffect(() => {
    if (!solanaAddress) return;
    fetch(`/api/roaster/wallet/${solanaAddress}`)
      .then((r) => r.json())
      .then((data) => { if (!data.error) setWallet(data); })
      .catch(() => {});
  }, [solanaAddress]);

  useEffect(() => {
    if (!solanaAddress) return;
    setLoading(true);
    setError(null);

    if (myTab === "backings") {
      fetch(`/api/roaster/backings?backer_address=${solanaAddress}&limit=20`)
        .then((r) => r.json())
        .then((data) => { if (data.error) throw new Error(data.error); setBackings(data.backings ?? []); })
        .catch((err) => setError(err.message ?? "Failed"))
        .finally(() => setLoading(false));
    } else if (myTab === "battles") {
      fetch(`/api/roaster/battles?creator_address=${solanaAddress}&limit=20`)
        .then((r) => r.json())
        .then((data) => { if (data.error) throw new Error(data.error); setMyBattles(data.battles ?? []); })
        .catch((err) => setError(err.message ?? "Failed"))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, [solanaAddress, myTab]);

  return (
    <div className="flex flex-col gap-3">
      {/* Battle Wallet */}
      {wallet && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 flex flex-col gap-3">
          <p className="text-xs font-semibold text-[#F2F0E8] uppercase tracking-wide">Battle Wallet</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] p-3">
              <p className="text-xs text-[#A7A79A] mb-1">Balance</p>
              <p className="text-base font-bold text-[#F2F0E8]">${wallet.balance_usdc.toFixed(2)}</p>
              <p className="text-xs text-[#A7A79A]">USDC</p>
            </div>
            <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] p-3">
              <p className="text-xs text-[#A7A79A] mb-1">Pending Payouts</p>
              <p className="text-base font-bold text-green-400">${wallet.pending_payouts_usdc.toFixed(2)}</p>
              <p className="text-xs text-[#A7A79A]">USDC</p>
            </div>
          </div>
        </div>
      )}
      {/* Referral link */}
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-[#F2F0E8] uppercase tracking-wide">Your Referral Link</p>
          <span className="text-xs text-[#A7A79A]">Earn 0.10% per backing</span>
        </div>
        <div className="flex gap-2">
          <p className="flex-1 rounded-xl bg-white/[0.03] border border-[#2A2B27] px-3 py-2 text-xs text-[#A7A79A] truncate font-mono">
            {referralLink}
          </p>
          <button onClick={copyReferral}
            className="shrink-0 rounded-xl bg-white/[0.06] border border-[#2A2B27] px-3 py-2 text-xs font-medium text-[#F2F0E8] hover:bg-white/[0.1] transition-colors">
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="text-xs text-[#A7A79A]">Share this link — when someone backs a battle through your link, you earn 0.10% of their backing automatically.</p>
      </div>

      {/* Sub-tabs */}
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-white/[0.04] p-1">
        {(["backings", "battles", "raps"] as MyTab[]).map((t) => (
          <button key={t} onClick={() => setMyTab(t)}
            className={`rounded-lg py-1.5 text-xs font-medium transition-colors capitalize ${myTab === t ? "bg-white/[0.1] text-[#F2F0E8]" : "text-[#A7A79A]"}`}>
            {t === "backings" ? "My Backings" : t === "battles" ? "My Battles" : "My Raps"}
          </button>
        ))}
      </div>

      {loading && Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-16 rounded-xl bg-white/[0.04] animate-pulse" />
      ))}

      {error && <div className="rounded-xl bg-red-400/10 border border-red-400/20 px-3 py-2.5 text-xs text-red-400">{error}</div>}

      {/* Backings */}
      {!loading && myTab === "backings" && (
        backings.length === 0 ? (
          <div className="rounded-2xl bg-white/[0.03] border border-[#2A2B27] p-6 text-center">
            <p className="text-[#A7A79A] text-sm">You haven't backed any battles yet</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[#A7A79A]">{backings.length} backing{backings.length !== 1 ? "s" : ""}</p>
            {backings.map((b) => (
              <div key={b.backing_id} className="rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-[#F2F0E8]">Battle {b.battle_id.slice(0, 8)}…</p>
                    <p className="text-xs text-[#A7A79A]">Side {b.side === 0 ? "A" : "B"} · weight {b.time_weight.toFixed(3)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-[#F2F0E8]">${fmt(b.amount_usdc)}</p>
                    {b.potential_payout_usdc != null && (
                      <p className="text-xs text-green-400">→ ${fmt(b.potential_payout_usdc)}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* My Battles */}
      {!loading && myTab === "battles" && (
        myBattles.length === 0 ? (
          <div className="rounded-2xl bg-white/[0.03] border border-[#2A2B27] p-6 text-center">
            <p className="text-[#A7A79A] text-sm">You haven't created any battles yet</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[#A7A79A]">{myBattles.length} battle{myBattles.length !== 1 ? "s" : ""} created</p>
            {myBattles.map((b) => (
              <div key={b.battle_id} className="rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <p className="text-sm font-medium text-[#F2F0E8] leading-snug">{b.topic}</p>
                  <span className={`text-xs rounded-full px-2 py-0.5 shrink-0 ${
                    b.status === "settled" ? "text-green-400 bg-green-400/10" :
                    b.status === "voided" ? "text-red-400 bg-red-400/10" :
                    b.status === "judging" ? "text-purple-400 bg-purple-400/10" :
                    "text-yellow-400 bg-yellow-400/10"
                  }`}>{b.status}</span>
                </div>
                <div className="flex justify-between text-xs text-[#A7A79A]">
                  <span>{b.sides[0].name} vs {b.sides[1].name}</span>
                  <span>Pool: ${fmt(b.total_pool_usdc)}</span>
                </div>
                {b.status === "settled" && b.winner_side !== undefined && (
                  <p className="text-xs text-green-400 mt-1">🏆 {b.sides[b.winner_side].name} won</p>
                )}
                {(b.jury_transcript_url || b.jury_irys_tx_id) && (
                  <div className="flex gap-2 mt-1">
                    {b.jury_transcript_url && (
                      <a href={b.jury_transcript_url} target="_blank" rel="noopener noreferrer"
                         className="text-xs text-[#A7A79A] hover:text-[#F2F0E8]">
                        Jury transcript ↗
                      </a>
                    )}
                    {b.jury_irys_tx_id && (
                      <a href={`https://gateway.irys.xyz/${b.jury_irys_tx_id}`} target="_blank" rel="noopener noreferrer"
                         className="text-xs text-[#A7A79A] hover:text-[#F2F0E8]">
                        Verify on Irys ↗
                      </a>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}

      {/* My Raps — note: no list-raps-by-creator endpoint yet, direct user to browse */}
      {!loading && myTab === "raps" && (
        <div className="rounded-2xl bg-white/[0.03] border border-[#2A2B27] p-6 text-center flex flex-col gap-2">
          <p className="text-2xl">🎤</p>
          <p className="text-sm font-medium text-[#F2F0E8]">Track your raps</p>
          <p className="text-xs text-[#A7A79A]">
            If you know a rap ID, ask Bluvfi to look it up — or check the battle page to see your track once it's generated.
          </p>
          <p className="text-xs text-[#A7A79A]">
            As a rap creator you earn <span className="text-[#F2F0E8]">0.60%</span> of all backing volume and receive an IP Revenue NFT at settlement — win or lose.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Rap Tab (select battle to rap on) ────────────────────────────────────────

function RapTab({
  solanaAddress,
  preselectedBattle,
}: {
  solanaAddress: string;
  preselectedBattle?: Battle | null;
}) {
  const [battles, setBattles] = useState<Battle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Battle | null>(preselectedBattle ?? null);
  const [done, setDone] = useState<Rap | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const r = await fetch("/api/roaster/battles?status=open&limit=20");
        const data = await r.json();
        if (!r.ok || data.error) throw new Error(data.error ?? "Failed");
        setBattles(data.battles ?? []);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!done || done.status !== "generating") return;
    const interval = setInterval(async () => {
      try {
        const r = await fetch(`/api/roaster/raps/${done.rap_id}`);
        const data: Rap = await r.json();
        if (data.status === "ready" || data.status === "failed") {
          setDone(data);
          clearInterval(interval);
        }
      } catch { /* keep polling */ }
    }, 4000);
    return () => clearInterval(interval);
  }, [done]);

  if (done) return (
    <div className="flex flex-col gap-4">
      <div className={`rounded-2xl border p-4 text-center ${
        done.status === "failed" ? "bg-red-400/10 border-red-400/20" :
        done.status === "ready" ? "bg-green-400/10 border-green-400/20" :
        "bg-white/[0.03] border-[#2A2B27]"
      }`}>
        <p className="text-2xl mb-2">{done.status === "failed" ? "❌" : done.status === "ready" ? "🎵" : "🎤"}</p>
        {done.status === "generating" && (
          <>
            <p className="text-sm font-semibold text-[#F2F0E8]">Generating…</p>
            <p className="text-xs text-[#A7A79A] mt-1">AI is writing your bars and producing the track. Checking every few seconds…</p>
          </>
        )}
        {done.status === "ready" && (
          <>
            <p className="text-sm font-semibold text-green-400">Track ready!</p>
            <p className="text-xs text-[#A7A79A] mt-1">You'll earn 0.60% of all backing volume and receive an IP Revenue NFT at settlement.</p>
            {done.track_url && (
              <a href={done.track_url} target="_blank" rel="noopener noreferrer"
                 className="mt-3 inline-block rounded-xl bg-green-400/20 border border-green-400/30 px-4 py-2 text-xs font-semibold text-green-400 hover:bg-green-400/30 transition-colors">
                ▶ Listen to your track
              </a>
            )}
            {done.bars && (
              <details className="mt-3 text-left">
                <summary className="text-xs text-[#A7A79A] cursor-pointer hover:text-[#F2F0E8]">View bars</summary>
                <pre className="mt-2 text-xs text-[#F2F0E8] whitespace-pre-wrap font-mono bg-white/[0.04] rounded-xl p-3">{done.bars}</pre>
              </details>
            )}
          </>
        )}
        {done.status === "failed" && (
          <>
            <p className="text-sm font-semibold text-red-400">Generation failed</p>
            <p className="text-xs text-[#A7A79A] mt-1">AI couldn't generate the rap. Try again with different angles.</p>
          </>
        )}
        <p className="text-xs text-[#5A5B57] mt-2">Rap ID: {done.rap_id}</p>
      </div>
      <button onClick={() => { setDone(null); setSelected(null); }}
        className="w-full rounded-xl border border-[#2A2B27] text-[#A7A79A] text-sm py-3 hover:border-[#3A3B37] transition-colors">
        Create Another
      </button>
    </div>
  );

  if (selected) return (
    <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-[#F2F0E8]">Create Rap</p>
        <button onClick={() => setSelected(null)} className="text-[#A7A79A] hover:text-white text-sm">✕</button>
      </div>
      {solanaAddress ? (
        <CreateRapForm battle={selected} solanaAddress={solanaAddress}
          onClose={() => setSelected(null)} onSuccess={(rap) => setDone(rap)} />
      ) : (
        <p className="text-xs text-[#A7A79A]">Connect a Solana wallet to create raps.</p>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] px-3 py-2.5 text-xs text-[#A7A79A]">
        Pick a battle to rap on. AI writes every bar and produces the full audio track from your angles. Creating a rap is <span className="text-[#F2F0E8]">free</span> — first to finish a side locks it.
      </div>

      {loading && Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-16 rounded-xl bg-white/[0.04] animate-pulse" />
      ))}

      {error && <div className="rounded-xl bg-red-400/10 border border-red-400/20 px-3 py-2.5 text-xs text-red-400">{error}</div>}

      {!loading && !error && battles.length === 0 && (
        <div className="rounded-2xl bg-white/[0.03] border border-[#2A2B27] p-6 text-center">
          <p className="text-[#A7A79A] text-sm">No open battles to rap on</p>
        </div>
      )}

      {battles.map((b) => (
        <button key={b.battle_id} onClick={() => setSelected(b)}
          className="flex items-center gap-4 rounded-xl border border-[#2A2B27] bg-[#1B1C19] p-3 text-left hover:border-[#3A3B37] transition-colors w-full">
          <span className="text-xl shrink-0">🎤</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[#F2F0E8] truncate">{b.topic}</p>
            <p className="text-xs text-[#A7A79A]">
              {b.sides[0].name} {b.sides[0].rap_id ? "🔒" : "✓"} vs {b.sides[1].name} {b.sides[1].rap_id ? "🔒" : "✓"}
              {" · "}{timeLeft(b.ends_at)} left
            </p>
          </div>
          <svg className="shrink-0 text-[#A7A79A]" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      ))}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function RoasterSection() {
  const { user } = usePrivy();
  const { signTransaction } = useSignTransaction();
  const solanaAddress = (user?.linkedAccounts?.find(
    (a) => a.type === "wallet" && (a as { chainType?: string }).chainType === "solana",
  ) as { address?: string } | undefined)?.address ?? "";

  const [tab, setTab] = useState<Tab>("browse");
  const [battles, setBattles] = useState<Battle[]>([]);
  const [statusFilter, setStatusFilter] = useState<BattleStatus | "all">("open");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [backingBattle, setBackingBattle] = useState<Battle | null>(null);
  const [rapBattle, setRapBattle] = useState<Battle | null>(null);

  const loadBattles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter !== "all" ? `?status=${statusFilter}&limit=20` : "?limit=20";
      const r = await fetch(`/api/roaster/battles${qs}`);
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error ?? "Failed");
      setBattles(data.battles ?? []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load battles");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    if (tab === "browse") loadBattles();
  }, [tab, loadBattles]);

  const TABS: { key: Tab; label: string }[] = [
    { key: "browse", label: "Browse" },
    { key: "rap", label: "Rap" },
    { key: "create", label: "Create" },
    { key: "leaderboard", label: "Board" },
    { key: "my", label: "Mine" },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Stats strip */}
      <div className="flex flex-col gap-1">
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] p-2.5 text-center">
            <p className="text-xs text-[#A7A79A]">Creation Bond</p>
            <p className="text-sm font-semibold text-[#F2F0E8]">10 USDC</p>
          </div>
          <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] p-2.5 text-center">
            <p className="text-xs text-[#A7A79A]">Platform Fee</p>
            <p className="text-sm font-semibold text-[#F2F0E8]">1.25%</p>
          </div>
          <div className="rounded-xl bg-white/[0.03] border border-[#2A2B27] p-2.5 text-center">
            <p className="text-xs text-[#A7A79A]">Settlement</p>
            <p className="text-sm font-semibold text-[#F2F0E8]">AI Jury</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-xl bg-white/[0.04] p-1">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${tab === t.key ? "bg-white/[0.1] text-[#F2F0E8]" : "text-[#A7A79A]"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Inline Back Side Sheet */}
      {backingBattle && (
        <div className="rounded-2xl border border-[#3A3B37] bg-[#1B1C19] p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-[#F2F0E8]">Back a Side</p>
            <button onClick={() => setBackingBattle(null)} className="text-[#A7A79A] hover:text-white text-sm">✕</button>
          </div>
          {solanaAddress ? (
            <BackSideSheet battle={backingBattle} solanaAddress={solanaAddress}
              signTransaction={signTransaction}
              onClose={() => setBackingBattle(null)}
              onSuccess={() => { setBackingBattle(null); loadBattles(); }} />
          ) : (
            <p className="text-xs text-[#A7A79A]">Connect a Solana wallet to back battles.</p>
          )}
        </div>
      )}

      {/* Browse Tab */}
      {tab === "browse" && !backingBattle && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-1.5 flex-wrap">
            {(["all", "open", "live", "judging", "settled", "voided"] as const).map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  statusFilter === s ? "bg-[#F2F0E8] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A] hover:text-[#F2F0E8]"
                }`}>
                {s === "all" ? "All" : statusLabel(s as BattleStatus)}
              </button>
            ))}
          </div>

          {loading && Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-44 rounded-2xl bg-white/[0.04] animate-pulse" />
          ))}

          {error && (
            <div className="rounded-xl bg-red-400/10 border border-red-400/20 px-3 py-2.5 text-xs text-red-400">
              {error} <button onClick={loadBattles} className="ml-2 underline">Retry</button>
            </div>
          )}

          {!loading && !error && battles.length === 0 && (
            <div className="rounded-2xl bg-white/[0.03] border border-[#2A2B27] p-8 text-center">
              <p className="text-2xl mb-2">🎤</p>
              <p className="text-[#A7A79A] text-sm">No battles found</p>
              <button onClick={() => setTab("create")} className="mt-3 text-xs text-[#F2F0E8] underline">Create the first one</button>
            </div>
          )}

          {battles.map((b) => (
            <BattleCard key={b.battle_id} battle={b} onBack={setBackingBattle} onRap={(battle) => { setRapBattle(battle); setTab("rap"); }} />
          ))}
        </div>
      )}

      {/* Rap Tab */}
      {tab === "rap" && <RapTab solanaAddress={solanaAddress} preselectedBattle={rapBattle} />}

      {/* Create Tab */}
      {tab === "create" && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <p className="text-sm font-semibold text-[#F2F0E8] mb-4">Create a Battle</p>
          {solanaAddress ? (
            <CreateBattleForm solanaAddress={solanaAddress} signTransaction={signTransaction}
              onSuccess={() => { setTab("browse"); loadBattles(); }} />
          ) : (
            <p className="text-xs text-[#A7A79A]">Connect a Solana wallet to create battles.</p>
          )}
        </div>
      )}

      {/* Leaderboard Tab */}
      {tab === "leaderboard" && <LeaderboardTab />}

      {/* My Activity Tab */}
      {tab === "my" && (
        solanaAddress ? <MyActivityTab solanaAddress={solanaAddress} /> : (
          <div className="rounded-2xl bg-white/[0.03] border border-[#2A2B27] p-6 text-center">
            <p className="text-[#A7A79A] text-sm">Connect a Solana wallet to see your activity.</p>
          </div>
        )
      )}

      {/* How it works */}
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 flex flex-col gap-2.5">
        <p className="text-xs font-semibold text-[#F2F0E8] uppercase tracking-wide">How It Works</p>
        {[
          ["🎤", "Create", "Pick a topic + two sides, deposit 10 USDC bond"],
          ["🎵", "Rap", "Pick a side + angles — AI writes bars and produces the track (free)"],
          ["💰", "Back", "Back a side with USDC — earlier = higher time-weight in pool"],
          ["⚖️", "Judge", "AI Jury (Claude + GPT + Gemini) scores both songs on craft dimensions"],
          ["🏆", "Win", "Winners split the losing pool; IP Revenue NFTs mint to rap creators"],
        ].map(([icon, title, desc]) => (
          <div key={title} className="flex gap-3 items-start">
            <span className="text-base shrink-0">{icon}</span>
            <div>
              <p className="text-xs font-semibold text-[#F2F0E8]">{title}</p>
              <p className="text-xs text-[#A7A79A]">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Fee structure */}
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 flex flex-col gap-2">
        <p className="text-xs font-semibold text-[#F2F0E8] uppercase tracking-wide">Fee Split (per backing)</p>
        {[["Creator", "0.25%"], ["Rap Creators", "0.60%"], ["Protocol", "0.30%"], ["Referral", "0.10%"]].map(([label, pct]) => (
          <InfoRow key={label} label={label} value={pct} />
        ))}
      </div>

      {/* IP Revenue NFTs */}
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 flex flex-col gap-2">
        <p className="text-xs font-semibold text-[#F2F0E8] uppercase tracking-wide">IP Revenue NFTs</p>
        <p className="text-xs text-[#A7A79A]">
          16 NFTs mint per battle at settlement (top 8 bar creators per side, Metaplex Core). Win or lose — you own the IP of your side's track.
          Once protocol reaches $10K revenue, 60% of streaming/licensing income flows to backers (time-weighted), 30% to NFT holders, 10% to protocol.
        </p>
      </div>
    </div>
  );
}
