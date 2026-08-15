"use client";

import { useState, useEffect, useCallback } from "react";

// ── Types (mirrored from lib/nosana.ts for client use) ──────────────────────

type DeploymentStatus =
  | "DRAFT" | "STARTING" | "RUNNING" | "STOPPING"
  | "STOPPED" | "ARCHIVED" | "ERROR" | "INSUFFICIENT_FUNDS";

interface Market {
  address: string;
  name: string;
  gpu: string;
  vram: number;
  price_per_hour_usd: number;
  type: "PREMIUM" | "COMMUNITY";
}

interface JobDefinitionOp {
  type: string;
  id: string;
  args?: { image?: string; cmd?: string | string[]; expose?: number; env?: Record<string, string> };
}

interface JobDefinition {
  version: string;
  type: string;
  ops: JobDefinitionOp[];
}

interface Deployment {
  id: string;
  name: string;
  status: DeploymentStatus;
  strategy: string;
  market: string;
  replicas: number;
  timeout: number;
  job_definition?: JobDefinition;
  endpoint?: string;
  created_at: string;
  updated_at: string;
  price_per_hour_usd?: number;
}

interface Credits {
  assignedCredits: number;
  reservedCredits: number;
  settledCredits: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<DeploymentStatus, string> = {
  DRAFT: "text-[#A7A79A] bg-white/[0.06]",
  STARTING: "text-yellow-400 bg-yellow-400/10",
  RUNNING: "text-green-400 bg-green-400/10",
  STOPPING: "text-orange-400 bg-orange-400/10",
  STOPPED: "text-[#A7A79A] bg-white/[0.06]",
  ARCHIVED: "text-[#555] bg-white/[0.04]",
  ERROR: "text-red-400 bg-red-400/10",
  INSUFFICIENT_FUNDS: "text-red-400 bg-red-400/10",
};

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch { return iso; }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const j = JSON.parse(text); msg = j.error ?? j.message ?? msg; } catch { /* */ }
    throw new Error(msg);
  }
  return JSON.parse(text) as T;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[status] ?? "text-[#A7A79A] bg-white/[0.06]"}`}>
      {status}
    </span>
  );
}

function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
    </div>
  );
}

function ErrorMsg({ msg }: { msg: string }) {
  return <p className="text-sm text-red-400 py-6 text-center">{msg}</p>;
}

// ── Deployments tab ──────────────────────────────────────────────────────────

function DeploymentCard({ dep, onRefresh }: { dep: Deployment; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function act(action: "start" | "stop" | "archive") {
    setBusy(true); setErr("");
    try {
      await apiFetch(`/api/nosana/deployments/${dep.id}/${action}`, { method: "POST" });
      onRefresh();
    } catch (e: any) {
      setErr(e.message ?? "Failed");
    } finally {
      setBusy(false);
    }
  }

  const image = dep.job_definition?.ops?.[0]?.args?.image;
  const canArchive = dep.status === "STOPPED" || dep.status === "ERROR" || dep.status === "DRAFT";

  return (
    <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-[#F2F0E8] truncate">{dep.name}</p>
          <p className="text-xs text-[#A7A79A] mt-0.5 truncate font-mono">{dep.id}</p>
        </div>
        <StatusBadge status={dep.status} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[#A7A79A]">
        {image && (
          <span className="col-span-2 truncate">Image: <span className="text-[#F2F0E8] font-mono">{image}</span></span>
        )}
        <span>Market: <span className="text-[#F2F0E8] font-mono">{dep.market.slice(0, 8)}…</span></span>
        {dep.price_per_hour_usd != null && (
          <span>Cost: <span className="text-[#F2F0E8]">${dep.price_per_hour_usd.toFixed(3)}/hr</span></span>
        )}
        <span>Replicas: <span className="text-[#F2F0E8]">{dep.replicas}</span></span>
        <span>Created: <span className="text-[#F2F0E8]">{fmtDate(dep.created_at)}</span></span>
        <span className="col-span-2">Strategy: <span className="text-[#F2F0E8]">{dep.strategy}</span></span>
      </div>

      {dep.endpoint && (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-green-400/5 border border-green-400/20 px-3 py-2">
          <span className="text-xs text-[#A7A79A] shrink-0">Endpoint</span>
          <a
            href={dep.endpoint}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-green-400 underline truncate flex-1"
          >
            {dep.endpoint}
          </a>
        </div>
      )}

      {dep.status === "INSUFFICIENT_FUNDS" && (
        <div className="mt-3 rounded-xl bg-red-400/5 border border-red-400/20 px-3 py-2 text-xs text-red-400">
          Insufficient NOS credits — top up on the{" "}
          <a href="https://dashboard.nosana.io" target="_blank" rel="noreferrer" className="underline">
            Nosana dashboard
          </a>{" "}
          then restart.
        </div>
      )}

      {err && <p className="mt-2 text-xs text-red-400">{err}</p>}

      <div className="mt-3 flex gap-2">
        {(dep.status === "DRAFT" || dep.status === "STOPPED") && (
          <button
            onClick={() => act("start")}
            disabled={busy}
            className="flex-1 rounded-xl bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513] disabled:opacity-50"
          >
            {busy ? "…" : dep.status === "DRAFT" ? "Start" : "Restart"}
          </button>
        )}
        {dep.status === "RUNNING" && (
          <button
            onClick={() => act("stop")}
            disabled={busy}
            className="flex-1 rounded-xl border border-orange-400/40 text-orange-400 py-2 text-xs font-semibold disabled:opacity-50"
          >
            {busy ? "…" : "Stop"}
          </button>
        )}
        {dep.status === "INSUFFICIENT_FUNDS" && (
          <button
            onClick={() => act("start")}
            disabled={busy}
            className="flex-1 rounded-xl bg-[#8FAE82] py-2 text-xs font-semibold text-[#141513] disabled:opacity-50"
          >
            {busy ? "…" : "Retry Start"}
          </button>
        )}
        {canArchive && (
          <button
            onClick={() => act("archive")}
            disabled={busy}
            className="rounded-xl border border-[#2A2B27] text-[#A7A79A] px-3 py-2 text-xs disabled:opacity-50"
          >
            Archive
          </button>
        )}
      </div>
    </div>
  );
}

function DeploymentsTab() {
  const [deps, setDeps] = useState<Deployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const data = await apiFetch<{ deployments: Deployment[] }>("/api/nosana/deployments");
      setDeps(data.deployments);
    } catch (e: any) {
      setErr(e.message ?? "Failed to load deployments");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <Spinner />;
  if (err) return <ErrorMsg msg={err} />;
  if (deps.length === 0)
    return <p className="text-sm text-[#A7A79A] text-center py-8">No deployments yet. Use the Deploy tab to launch your first GPU workload.</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[#A7A79A]">{deps.length} deployment{deps.length !== 1 ? "s" : ""}</p>
        <button onClick={load} className="text-xs text-[#8FAE82] hover:underline">Refresh</button>
      </div>
      {deps.map((d) => (
        <DeploymentCard key={d.id} dep={d} onRefresh={load} />
      ))}
    </div>
  );
}

// ── Deploy tab ───────────────────────────────────────────────────────────────

function DeployTab() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loadingMarkets, setLoadingMarkets] = useState(true);
  const [marketsErr, setMarketsErr] = useState("");

  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [cmd, setCmd] = useState("");
  const [market, setMarket] = useState("");
  const [port, setPort] = useState("");
  const [strategy, setStrategy] = useState<"SIMPLE" | "SIMPLE-EXTEND" | "SCHEDULED" | "INFINITE">("SIMPLE");
  const [timeout, setTimeout_] = useState("60");
  const [replicas, setReplicas] = useState("1");

  const [busy, setBusy] = useState(false);
  const [deployErr, setDeployErr] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<Market[]>("/api/nosana/markets");
        setMarkets(data);
        if (data.length > 0) setMarket(data[0].address);
      } catch (e: any) {
        setMarketsErr(e.message ?? "Failed to load markets");
      } finally {
        setLoadingMarkets(false);
      }
    })();
  }, []);

  async function handleDeploy() {
    if (!name.trim() || !image.trim() || !market) return;
    setBusy(true); setDeployErr(""); setSuccess("");
    try {
      const job_definition = {
        version: "0.1",
        type: "container",
        meta: { trigger: "api" },
        ops: [{
          type: "container/run",
          id: "main",
          args: {
            image: image.trim(),
            gpu: true,
            ...(cmd.trim() ? { cmd: cmd.trim() } : {}),
            ...(port ? { expose: Number(port) } : {}),
          },
        }],
      };
      const dep = await apiFetch<Deployment>("/api/nosana/deployments", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          market,
          timeout: Number(timeout) || 60,
          replicas: Number(replicas) || 1,
          strategy,
          job_definition,
        }),
      });
      // Auto-start
      await apiFetch(`/api/nosana/deployments/${dep.id}/start`, { method: "POST" });
      setSuccess(`Deployment "${dep.name}" started! Switch to the Deployments tab to track progress.`);
      setName(""); setImage(""); setCmd(""); setPort("");
    } catch (e: any) {
      setDeployErr(e.message ?? "Deployment failed");
    } finally {
      setBusy(false);
    }
  }

  const selectedMarket = markets.find(m => m.address === market);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-[#2A2B27] bg-[#141513] p-4">
        <p className="text-xs text-[#A7A79A] mb-3 leading-relaxed">
          Deploy any Docker container onto a decentralized GPU host. Billing is credit-based — no wallet signing required.
        </p>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs font-medium text-[#A7A79A] mb-1 block">Deployment name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-llm-inference"
              className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-[#A7A79A] mb-1 block">Docker image</label>
            <input
              value={image}
              onChange={e => setImage(e.target.value)}
              placeholder="ollama/ollama:latest"
              className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-[#A7A79A] mb-1 block">Entrypoint command <span className="text-[#555]">(optional)</span></label>
            <input
              value={cmd}
              onChange={e => setCmd(e.target.value)}
              placeholder="serve --model llama3"
              className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] font-mono outline-none focus:border-[#8FAE82]"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-[#A7A79A] mb-1 block">Expose port <span className="text-[#555]">(optional — for HTTP endpoints)</span></label>
            <input
              value={port}
              onChange={e => setPort(e.target.value)}
              placeholder="e.g. 8080"
              type="number"
              className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-[#A7A79A] mb-1 block">Strategy</label>
            <select
              value={strategy}
              onChange={e => setStrategy(e.target.value as typeof strategy)}
              className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
            >
              <option value="SIMPLE">SIMPLE — single run until timeout</option>
              <option value="SIMPLE-EXTEND">SIMPLE-EXTEND — extends on activity</option>
              <option value="SCHEDULED">SCHEDULED — cron-based</option>
              <option value="INFINITE">INFINITE — never auto-stops</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {strategy !== "INFINITE" && (
              <div>
                <label className="text-xs font-medium text-[#A7A79A] mb-1 block">Timeout (min)</label>
                <input
                  value={timeout}
                  onChange={e => setTimeout_(e.target.value)}
                  type="number"
                  min="1"
                  className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
                />
              </div>
            )}
            <div className={strategy === "INFINITE" ? "col-span-2" : ""}>
              <label className="text-xs font-medium text-[#A7A79A] mb-1 block">Replicas</label>
              <input
                value={replicas}
                onChange={e => setReplicas(e.target.value)}
                type="number"
                min="1"
                className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-[#A7A79A] mb-1 block">GPU market</label>
            {loadingMarkets ? (
              <div className="rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#A7A79A]">Loading markets…</div>
            ) : marketsErr ? (
              <div className="rounded-xl border border-red-400/30 px-3 py-2 text-xs text-red-400">{marketsErr}</div>
            ) : (
              <select
                value={market}
                onChange={e => setMarket(e.target.value)}
                className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
              >
                {markets.map(m => (
                  <option key={m.address} value={m.address}>
                    {m.name} — {m.gpu} {m.vram}GB · ${m.price_per_hour_usd.toFixed(3)}/hr [{m.type}]
                  </option>
                ))}
              </select>
            )}
          </div>

          {selectedMarket && (() => {
            const mins = Number(timeout) || 60;
            const reps = Number(replicas) || 1;
            const estimatedCost = strategy === "INFINITE"
              ? null
              : selectedMarket.price_per_hour_usd * (mins / 60) * reps;
            return (
              <div className="rounded-xl bg-white/[0.04] px-3 py-2 flex flex-col gap-1.5 text-xs text-[#A7A79A]">
                <div className="flex items-center gap-3">
                  <span>GPU: <span className="text-[#F2F0E8] font-medium">{selectedMarket.gpu}</span></span>
                  <span>VRAM: <span className="text-[#F2F0E8] font-medium">{selectedMarket.vram}GB</span></span>
                  <span className={`ml-auto rounded-full px-2 py-0.5 font-medium ${selectedMarket.type === "PREMIUM" ? "text-yellow-400 bg-yellow-400/10" : "text-[#8FAE82] bg-[#8FAE82]/10"}`}>
                    {selectedMarket.type}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t border-white/[0.06] pt-1.5">
                  <span>Estimated cost</span>
                  <span className="font-semibold text-[#F2F0E8]">
                    {estimatedCost != null
                      ? `~${estimatedCost.toFixed(4)} NOS (${mins}min × ${reps} replica${reps !== 1 ? "s" : ""})`
                      : "Runs until manually stopped"}
                  </span>
                </div>
              </div>
            );
          })()}
        </div>

        {deployErr && <p className="mt-3 text-xs text-red-400">{deployErr}</p>}
        {success && <p className="mt-3 text-xs text-green-400">{success}</p>}

        <button
          onClick={handleDeploy}
          disabled={busy || !name.trim() || !image.trim() || !market}
          className="mt-4 w-full rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513] disabled:opacity-50"
        >
          {busy ? "Deploying…" : "Deploy on GPU"}
        </button>
      </div>
    </div>
  );
}

// ── Markets tab ──────────────────────────────────────────────────────────────

function MarketsTab() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<"ALL" | "PREMIUM" | "COMMUNITY">("ALL");

  useEffect(() => {
    (async () => {
      try {
        setMarkets(await apiFetch<Market[]>("/api/nosana/markets"));
      } catch (e: any) {
        setErr(e.message ?? "Failed");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Spinner />;
  if (err) return <ErrorMsg msg={err} />;

  const shown = filter === "ALL" ? markets : markets.filter(m => m.type === filter);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {(["ALL", "PREMIUM", "COMMUNITY"] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${filter === f ? "bg-[#8FAE82] text-[#141513]" : "border border-[#2A2B27] text-[#A7A79A]"}`}
          >
            {f}
          </button>
        ))}
      </div>

      {shown.length === 0 && <p className="text-sm text-[#A7A79A] text-center py-6">No markets found.</p>}

      {shown.map(m => (
        <div key={m.address} className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-[#F2F0E8]">{m.name}</p>
              <p className="text-xs text-[#A7A79A] mt-0.5 truncate">{m.address}</p>
            </div>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium shrink-0 ${m.type === "PREMIUM" ? "text-yellow-400 bg-yellow-400/10" : "text-[#8FAE82] bg-[#8FAE82]/10"}`}>
              {m.type}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-xl bg-white/[0.04] px-3 py-2 text-center">
              <p className="text-[#A7A79A]">GPU</p>
              <p className="font-semibold text-[#F2F0E8] mt-0.5">{m.gpu}</p>
            </div>
            <div className="rounded-xl bg-white/[0.04] px-3 py-2 text-center">
              <p className="text-[#A7A79A]">VRAM</p>
              <p className="font-semibold text-[#F2F0E8] mt-0.5">{m.vram}GB</p>
            </div>
            <div className="rounded-xl bg-white/[0.04] px-3 py-2 text-center">
              <p className="text-[#A7A79A]">Price</p>
              <p className="font-semibold text-[#F2F0E8] mt-0.5">${m.price_per_hour_usd.toFixed(3)}/hr</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Credits tab ──────────────────────────────────────────────────────────────

interface SpendingTransaction {
  date: string;
  amount: number;
  deployment_id?: string;
  description?: string;
}

function CreditsTab() {
  const [credits, setCredits] = useState<Credits | null>(null);
  const [history, setHistory] = useState<SpendingTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [c, h] = await Promise.all([
          apiFetch<Credits>("/api/nosana/credits"),
          apiFetch<{ transactions: SpendingTransaction[] }>("/api/nosana/credits?history=1"),
        ]);
        setCredits(c);
        setHistory(h.transactions);
      } catch (e: any) {
        setErr(e.message ?? "Failed to load credits");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Spinner />;
  if (err) return <ErrorMsg msg={err} />;
  if (!credits) return null;

  const available = credits.assignedCredits - credits.reservedCredits - credits.settledCredits;

  return (
    <div className="flex flex-col gap-4">
      {/* Balance card */}
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-5">
        <p className="text-xs text-[#A7A79A] mb-1">Available credits</p>
        <p className="text-3xl font-bold text-[#F2F0E8]">
          {available.toFixed(4)}
          <span className="text-base font-normal text-[#A7A79A] ml-1">NOS</span>
        </p>
        <div className="mt-4 grid grid-cols-3 gap-2 text-xs text-center">
          <div className="rounded-xl bg-white/[0.04] p-2">
            <p className="text-[#A7A79A]">Assigned</p>
            <p className="font-semibold text-[#F2F0E8] mt-0.5">{credits.assignedCredits.toFixed(2)}</p>
          </div>
          <div className="rounded-xl bg-white/[0.04] p-2">
            <p className="text-[#A7A79A]">Reserved</p>
            <p className="font-semibold text-[#F2F0E8] mt-0.5">{credits.reservedCredits.toFixed(2)}</p>
          </div>
          <div className="rounded-xl bg-white/[0.04] p-2">
            <p className="text-[#A7A79A]">Settled</p>
            <p className="font-semibold text-[#F2F0E8] mt-0.5">{credits.settledCredits.toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* Spending history */}
      {history.length > 0 && (
        <div>
          <p className="text-xs font-medium text-[#A7A79A] mb-2">Spending history</p>
          <div className="flex flex-col gap-2">
            {history.map((tx, i) => (
              <div key={i} className="flex items-center justify-between rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3">
                <div>
                  <p className="text-xs text-[#F2F0E8]">{tx.description ?? tx.deployment_id ?? "Usage"}</p>
                  <p className="text-xs text-[#A7A79A] mt-0.5">{fmtDate(tx.date)}</p>
                </div>
                <p className="text-sm font-semibold text-red-400">-{tx.amount.toFixed(4)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length === 0 && (
        <p className="text-sm text-[#A7A79A] text-center py-4">No spending history yet.</p>
      )}

      {/* Top-up CTA */}
      <a
        href="https://dashboard.nosana.io"
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-center gap-2 rounded-2xl border border-[#2A2B27] py-3 text-sm text-[#A7A79A] hover:text-[#F2F0E8] hover:border-[#3A3B37] transition-colors"
      >
        <span>↗</span>
        <span>Top up credits on Nosana dashboard</span>
      </a>
    </div>
  );
}

// ── Root component ───────────────────────────────────────────────────────────

type Tab = "deployments" | "deploy" | "markets" | "credits";

const TABS: { key: Tab; label: string }[] = [
  { key: "deployments", label: "Deployments" },
  { key: "deploy",      label: "Deploy" },
  { key: "markets",     label: "Markets" },
  { key: "credits",     label: "Credits" },
];

export function NosanaSection() {
  const [tab, setTab] = useState<Tab>("deployments");

  return (
    <div className="flex flex-col gap-4">
      {/* Intro */}
      <div className="rounded-2xl border border-[#2A2B27] bg-[#141513] p-4">
        <div className="flex items-center gap-3 mb-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#8FAE82]/10 text-xl">⚙️</div>
          <div>
            <p className="font-semibold text-[#F2F0E8] text-sm">Nosana GPU Cloud</p>
            <p className="text-xs text-[#A7A79A]">Decentralized AI compute on Solana</p>
          </div>
        </div>
        <p className="text-xs text-[#A7A79A] leading-relaxed">
          Deploy containerized AI workloads on a decentralized network of GPU hosts. Pay with NOS credits — no on-chain signing needed. Markets range from community GPUs to premium NVIDIA cards.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 rounded-xl bg-white/[0.04] p-1">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-lg py-1.5 text-xs font-medium transition-colors ${tab === t.key ? "bg-[#1B1C19] text-[#F2F0E8]" : "text-[#A7A79A]"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {tab === "deployments" && <DeploymentsTab />}
      {tab === "deploy"      && <DeployTab />}
      {tab === "markets"     && <MarketsTab />}
      {tab === "credits"     && <CreditsTab />}
    </div>
  );
}
