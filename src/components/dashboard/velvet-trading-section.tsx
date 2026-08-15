"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useWallets } from "@privy-io/react-auth";
import { usePrivy } from "@privy-io/react-auth";
import { useChatSheet } from "@/contexts/chat-context";

// ── Types ─────────────────────────────────────────────────────────────────────

interface VaultSummary {
  portfolioId: string;   // portfolio contract address
  name: string;
  symbol: string;
  portfolio_address: string;
  rebalancing_address: string;
  asset_management_config: string;
  token_exclusion_manager: string;
  is_public: boolean;
  manual?: boolean;      // true = user added manually
}

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  vault_balance: string;
}

interface VaultDetail {
  name: string;
  symbol: string;
  portfolio_address: string;
  vault_address: string;
  rebalancing_address: string;
  asset_management_config: string;
  token_exclusion_manager: string;
  total_supply: string;
  user_balance: string;
  ownership_pct: string;
  underlying_tokens: TokenInfo[];
}

type ActionType = "deposit" | "withdraw" | "rebalance" | "weights";

interface VaultPrefs {
  added: string[];
  hidden: string[];
}

async function fetchPrefs(token: string | null): Promise<VaultPrefs> {
  const res = await fetch("/api/velvet/vault-prefs", {
    headers: token ? { Authorization: `Bearer ${token}` } as Record<string, string> : {},
  });
  if (!res.ok) return { added: [], hidden: [] };
  return res.json();
}

async function upsertPref(portfolioAddress: string, status: "added" | "hidden", token: string | null) {
  await fetch("/api/velvet/vault-prefs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } as Record<string, string>,
    body: JSON.stringify({ portfolioAddress, status }),
  });
}

async function deletePref(portfolioAddress: string, token: string | null) {
  await fetch(`/api/velvet/vault-prefs?portfolio=${encodeURIComponent(portfolioAddress)}`, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } as Record<string, string> : {},
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_CHAIN_ID = "0x2105"; // 8453

async function switchToBase(provider: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_ID }] });
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: BASE_CHAIN_ID,
          chainName: "Base",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://mainnet.base.org"],
          blockExplorerUrls: ["https://basescan.org"],
        }],
      });
    } else throw err;
  }
}

function toHex(value: string | number): string {
  return `0x${BigInt(value).toString(16)}`;
}

// ── Action sheet portal ───────────────────────────────────────────────────────

function ActionSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-t-3xl bg-[#1B1C19] border-t border-[#2A2B27] max-h-[85dvh] flex flex-col">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-[#2A2B27] flex-none">
          <h3 className="text-base font-semibold text-[#F2F0E8]">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1.5 text-[#A7A79A] hover:bg-white/[0.06]">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 px-6 py-4 pb-10">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ── Shared field primitives ───────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="mb-1.5 block text-xs font-medium text-[#A7A79A]">{label}</label>
      {children}
    </div>
  );
}

function StyledInput({ value, onChange, placeholder, type = "text" }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82] placeholder:text-[#A7A79A]/50"
    />
  );
}

function TokenSelect({ tokens, value, onChange, placeholder = "Select token" }: {
  tokens: TokenInfo[]; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]"
    >
      <option value="">{placeholder}</option>
      {tokens.map((t) => (
        <option key={t.address} value={t.address}>
          {t.symbol} — {Number(t.vault_balance).toFixed(4)} in vault
        </option>
      ))}
    </select>
  );
}

function SubmitBtn({ label, loading, disabled, onClick }: {
  label: string; loading: boolean; disabled: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className="mt-2 w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-50"
    >
      {loading ? "Processing…" : label}
    </button>
  );
}

function TxResult({ hash, error }: { hash?: string; error?: string }) {
  if (error) return <p className="mt-3 rounded-xl bg-red-900/20 px-3 py-2 text-xs text-red-400">{error}</p>;
  if (hash) return (
    <div className="mt-3 rounded-xl bg-green-900/20 px-3 py-2 text-xs text-green-400">
      ✓ Sent —{" "}
      <a href={`https://basescan.org/tx/${hash}`} target="_blank" rel="noreferrer" className="underline">
        view on Basescan
      </a>
    </div>
  );
  return null;
}

// ── Common Base tokens for deposit ────────────────────────────────────────────

const COMMON_TOKENS = [
  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC",  decimals: 6  },
  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH",  decimals: 18 },
  { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8  },
  { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH", decimals: 18 },
];

// ── Deposit Sheet ─────────────────────────────────────────────────────────────

function DepositSheet({ vault, walletAddress, getToken, onClose }: {
  vault: VaultDetail; walletAddress: string; getToken: () => Promise<string | null>; onClose: () => void;
}) {
  const { wallets } = useWallets();
  const [tokenAddr, setTokenAddr] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string>();
  const [error, setError] = useState<string>();

  const handleDeposit = async () => {
    if (!tokenAddr || !amount) return;
    setLoading(true); setError(undefined); setTxHash(undefined);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const meta = COMMON_TOKENS.find((t) => t.address.toLowerCase() === tokenAddr.toLowerCase());
      const decimals = meta?.decimals ?? 18;
      const rawAmount = BigInt(Math.round(Number(amount) * 10 ** decimals)).toString();

      const res = await fetch("/api/velvet/tx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: "deposit", portfolio: vault.portfolio_address, depositToken: tokenAddr, depositAmount: rawAmount, user: walletAddress }),
      });
      if (!res.ok) throw new Error(await res.text());
      const txData = await res.json();

      const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
      if (!wallet) throw new Error("No wallet connected");
      const provider = await wallet.getEthereumProvider();
      await switchToBase(provider as Parameters<typeof switchToBase>[0]);
      const hash = await (provider as { request: (a: { method: string; params: unknown[] }) => Promise<string> }).request({
        method: "eth_sendTransaction",
        params: [{ from: walletAddress, to: txData.to, data: txData.data, gas: toHex(Math.ceil(Number(txData.gasLimit) * 1.2)) }],
      });
      setTxHash(hash);
    } catch (e: unknown) { setError((e as Error)?.message ?? "Failed"); }
    finally { setLoading(false); }
  };

  return (
    <ActionSheet title={`Deposit — ${vault.name}`} onClose={onClose}>
      <p className="mb-4 text-xs text-[#A7A79A]">
        Deposit tokens into your vault. You&apos;ll receive portfolio tokens representing your share.
      </p>
      <div className="mb-4 rounded-xl bg-white/[0.03] px-4 py-3 text-xs">
        <p className="font-medium text-[#F2F0E8] mb-2">Current vault holdings</p>
        {vault.underlying_tokens.length === 0
          ? <p className="text-[#A7A79A]">Vault is empty — deposit to get started</p>
          : vault.underlying_tokens.map((t) => (
            <div key={t.address} className="flex justify-between py-0.5 text-[#A7A79A]">
              <span>{t.symbol}</span><span>{Number(t.vault_balance).toFixed(4)}</span>
            </div>
          ))}
      </div>
      <Field label="Token to deposit">
        <select value={tokenAddr} onChange={(e) => setTokenAddr(e.target.value)}
          className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] outline-none focus:border-[#8FAE82]">
          <option value="">Select token</option>
          {COMMON_TOKENS.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
        </select>
      </Field>
      <Field label="Amount">
        <StyledInput value={amount} onChange={setAmount} placeholder="e.g. 10" type="number" />
      </Field>
      <SubmitBtn label="Deposit" loading={loading} disabled={!tokenAddr || !amount} onClick={handleDeposit} />
      <TxResult hash={txHash} error={error} />
    </ActionSheet>
  );
}

// ── Withdraw Sheet ────────────────────────────────────────────────────────────

function WithdrawSheet({ vault, walletAddress, getToken, onClose }: {
  vault: VaultDetail; walletAddress: string; getToken: () => Promise<string | null>; onClose: () => void;
}) {
  const { wallets } = useWallets();
  const [withdrawToken, setWithdrawToken] = useState("");
  const [portfolioAmount, setPortfolioAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash] = useState<string>();
  const [error, setError] = useState<string>();

  const handleWithdraw = async () => {
    if (!withdrawToken || !portfolioAmount) return;
    setLoading(true); setError(undefined); setTxHash(undefined);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const rawAmount = BigInt(Math.round(Number(portfolioAmount) * 1e18)).toString();

      const res = await fetch("/api/velvet/tx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: "withdraw", portfolio: vault.portfolio_address, withdrawToken, withdrawAmount: rawAmount, user: walletAddress }),
      });
      if (!res.ok) throw new Error(await res.text());
      const txData = await res.json();

      const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
      if (!wallet) throw new Error("No wallet connected");
      const provider = await wallet.getEthereumProvider();
      await switchToBase(provider as Parameters<typeof switchToBase>[0]);
      const hash = await (provider as { request: (a: { method: string; params: unknown[] }) => Promise<string> }).request({
        method: "eth_sendTransaction",
        params: [{ from: walletAddress, to: txData.to, data: txData.data, gas: toHex(Math.ceil(Number(txData.gasLimit) * 1.2)) }],
      });
      setTxHash(hash);
    } catch (e: unknown) { setError((e as Error)?.message ?? "Failed"); }
    finally { setLoading(false); }
  };

  return (
    <ActionSheet title={`Withdraw — ${vault.name}`} onClose={onClose}>
      <p className="mb-4 text-xs text-[#A7A79A]">
        You hold <span className="font-medium text-[#F2F0E8]">{Number(vault.user_balance).toFixed(6)}</span> portfolio tokens
        ({vault.ownership_pct}% of vault).
      </p>
      <Field label="Portfolio tokens to burn">
        <StyledInput value={portfolioAmount} onChange={setPortfolioAmount}
          placeholder={`Max ${Number(vault.user_balance).toFixed(6)}`} type="number" />
      </Field>
      <Field label="Receive as">
        <TokenSelect tokens={vault.underlying_tokens} value={withdrawToken} onChange={setWithdrawToken} placeholder="Select token to receive" />
      </Field>
      <SubmitBtn label="Withdraw" loading={loading} disabled={!withdrawToken || !portfolioAmount} onClick={handleWithdraw} />
      <TxResult hash={txHash} error={error} />
    </ActionSheet>
  );
}

// ── Rebalance / Adjust Weights Sheet ─────────────────────────────────────────

function RebalanceSheet({ vault, walletAddress, getToken, onClose, mode }: {
  vault: VaultDetail; walletAddress: string; getToken: () => Promise<string | null>; onClose: () => void;
  mode: "rebalance" | "weights";
}) {
  const { wallets } = useWallets();
  const [sellToken, setSellToken] = useState("");
  const [buyToken, setBuyToken]   = useState("");
  const [buyInput, setBuyInput]   = useState("");
  const [sellAmount, setSellAmount] = useState("");
  const [slippage, setSlippage]   = useState("100");
  const [loading, setLoading] = useState(false);
  const [txHash, setTxHash]   = useState<string>();
  const [error, setError]     = useState<string>();

  const isWeights = mode === "weights";
  const sellMeta  = vault.underlying_tokens.find((t) => t.address === sellToken);
  const effectiveBuy = isWeights ? buyToken : buyInput;

  const handleSubmit = async () => {
    if (!sellToken || !effectiveBuy || !sellAmount) return;
    setLoading(true); setError(undefined); setTxHash(undefined);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      const decimals = sellMeta?.decimals ?? 18;
      const rawAmount = BigInt(Math.round(Number(sellAmount) * 10 ** decimals)).toString();
      const remaining = vault.underlying_tokens.map((t) => t.address).filter((a) => a !== sellToken);
      if (!remaining.includes(effectiveBuy)) remaining.push(effectiveBuy);

      const res = await fetch("/api/velvet/tx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: "rebalance",
          rebalanceAddress: vault.rebalancing_address,
          sellToken, buyToken: effectiveBuy, sellAmount: rawAmount,
          slippage, remainingTokens: remaining, owner: walletAddress,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const txData = await res.json();

      const wallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
      if (!wallet) throw new Error("No wallet connected");
      const provider = await wallet.getEthereumProvider();
      await switchToBase(provider as Parameters<typeof switchToBase>[0]);
      const hash = await (provider as { request: (a: { method: string; params: unknown[] }) => Promise<string> }).request({
        method: "eth_sendTransaction",
        params: [{ from: walletAddress, to: txData.to, data: txData.data,
          gas: toHex(Math.ceil(Number(txData.estimateGas ?? txData.gasLimit) * 1.2)),
          ...(txData.gasPrice ? { gasPrice: toHex(txData.gasPrice) } : {}),
        }],
      });
      setTxHash(hash);
    } catch (e: unknown) { setError((e as Error)?.message ?? "Failed"); }
    finally { setLoading(false); }
  };

  return (
    <ActionSheet title={isWeights ? `Adjust Weights — ${vault.name}` : `Rebalance — ${vault.name}`} onClose={onClose}>
      <p className="mb-4 text-xs text-[#A7A79A]">
        {isWeights
          ? "Shift allocation between existing vault tokens without changing the token list."
          : "Swap one vault token for a different token, changing vault composition."}
      </p>
      <Field label="Sell token">
        <TokenSelect tokens={vault.underlying_tokens} value={sellToken} onChange={setSellToken} placeholder="Select token to sell" />
      </Field>
      <Field label={`Sell amount${sellMeta ? ` (${sellMeta.symbol})` : ""}`}>
        <StyledInput value={sellAmount} onChange={setSellAmount}
          placeholder={sellMeta ? `Max ${Number(sellMeta.vault_balance).toFixed(4)}` : "Amount"} type="number" />
      </Field>
      <Field label={isWeights ? "Buy more of" : "Buy token (address on Base)"}>
        {isWeights
          ? <TokenSelect tokens={vault.underlying_tokens.filter((t) => t.address !== sellToken)} value={buyToken} onChange={setBuyToken} placeholder="Select token to buy more of" />
          : <StyledInput value={buyInput} onChange={setBuyInput} placeholder="0x… token contract address" />
        }
      </Field>
      <Field label="Slippage tolerance (basis points — 100 = 1%)">
        <StyledInput value={slippage} onChange={setSlippage} placeholder="100" type="number" />
      </Field>
      <SubmitBtn
        label={isWeights ? "Adjust Weights" : "Rebalance"}
        loading={loading}
        disabled={!sellToken || !effectiveBuy || !sellAmount}
        onClick={handleSubmit}
      />
      <TxResult hash={txHash} error={error} />
    </ActionSheet>
  );
}

// ── Add Vault Sheet ───────────────────────────────────────────────────────────

function AddVaultSheet({ walletAddress, getToken, onAdded, onClose }: {
  walletAddress: string;
  getToken: () => Promise<string | null>;
  onAdded: (vault: VaultSummary) => void;
  onClose: () => void;
}) {
  const [addr, setAddr] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const handleAdd = async () => {
    const trimmed = addr.trim();
    if (!trimmed.startsWith("0x") || trimmed.length !== 42) {
      setError("Enter a valid 0x… contract address");
      return;
    }
    setLoading(true); setError(undefined);
    try {
      const token = await getToken();
      const res = await fetch(
        `/api/velvet/portfolio-by-address?portfolio=${encodeURIComponent(trimmed)}&address=${encodeURIComponent(walletAddress)}`,
        { headers: token ? { Authorization: `Bearer ${token}` } as Record<string, string> : {} },
      );
      if (!res.ok) throw new Error(await res.text());
      const detail = await res.json() as VaultDetail;
      await upsertPref(trimmed, "added", token);
      onAdded({
        portfolioId: trimmed,
        name: detail.name,
        symbol: detail.symbol,
        portfolio_address: trimmed,
        rebalancing_address: detail.rebalancing_address,
        asset_management_config: detail.asset_management_config,
        token_exclusion_manager: detail.token_exclusion_manager,
        is_public: true,
        manual: true,
      });
      onClose();
    } catch (e: unknown) {
      setError((e as Error)?.message ?? "Failed to load vault — check the address");
    } finally {
      setLoading(false);
    }
  };

  return (
    <ActionSheet title="Add Vault" onClose={onClose}>
      <p className="mb-4 text-xs text-[#A7A79A]">
        Paste a Velvet Capital portfolio contract address on Base mainnet to connect your vault.
      </p>
      <Field label="Portfolio contract address">
        <StyledInput value={addr} onChange={setAddr} placeholder="0x…" />
      </Field>
      <p className="mb-4 text-xs text-[#A7A79A]">
        Find your portfolio address on{" "}
        <a href="https://velvet.capital" target="_blank" rel="noreferrer" className="text-[#8FAE82] underline">velvet.capital</a>
        {" "}→ My Portfolios → click a vault → copy the contract address from the URL or details.
      </p>
      <SubmitBtn label="Connect Vault" loading={loading} disabled={!addr.trim()} onClick={handleAdd} />
      {error && <p className="mt-3 rounded-xl bg-red-900/20 px-3 py-2 text-xs text-red-400">{error}</p>}
    </ActionSheet>
  );
}

// ── Vault Card ────────────────────────────────────────────────────────────────

function VaultCard({ vault, walletAddress, getToken, onRemove }: {
  vault: VaultSummary;
  walletAddress: string;
  getToken: () => Promise<string | null>;
  onRemove?: () => void;
}) {
  const [detail, setDetail]       = useState<VaultDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [action, setAction]       = useState<ActionType | null>(null);
  const loadedRef = useRef(false);

  // Pre-load detail on mount so actions open instantly
  const loadDetail = useCallback(async () => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoadingDetail(true); setDetailError(undefined);
    try {
      const token = await getToken();
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
      let res: Response;
      if (vault.manual) {
        res = await fetch(
          `/api/velvet/portfolio-by-address?portfolio=${encodeURIComponent(vault.portfolio_address)}&address=${encodeURIComponent(walletAddress)}`,
          { headers },
        );
      } else {
        res = await fetch(
          `/api/velvet/portfolio-info?address=${encodeURIComponent(walletAddress)}&portfolioId=${encodeURIComponent(vault.portfolioId)}`,
          { headers },
        );
      }
      if (!res.ok) throw new Error(await res.text());
      setDetail(await res.json());
    } catch (e: unknown) {
      setDetailError((e as Error)?.message ?? "Failed to load vault details");
    } finally {
      setLoadingDetail(false);
    }
  }, [getToken, vault, walletAddress]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const ACTIONS: { key: ActionType; label: string; icon: string }[] = [
    { key: "deposit",   label: "Deposit",   icon: "↓" },
    { key: "withdraw",  label: "Withdraw",  icon: "↑" },
    { key: "rebalance", label: "Rebalance", icon: "⇄" },
    { key: "weights",   label: "Weights",   icon: "⚖" },
  ];

  return (
    <>
      <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
        {/* Header */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#8FAE82]/10 text-lg shrink-0">🏦</div>
            <div>
              <div className="flex items-center gap-1.5">
                <p className="font-semibold text-[#F2F0E8] text-sm">{vault.name}</p>
                {vault.manual && (
                  <span className="rounded-full bg-[#8FAE82]/15 px-1.5 py-0.5 text-[9px] font-medium text-[#8FAE82]">manual</span>
                )}
              </div>
              <p className="text-xs text-[#A7A79A]">{vault.symbol} · Base</p>
            </div>
          </div>
          <button onClick={onRemove} title="Remove vault" className="text-[#A7A79A] hover:text-red-400 text-xs px-1 pt-0.5">×</button>
        </div>

        {/* Stats */}
        {detail && (
          <div className="mb-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-white/[0.03] px-3 py-2">
              <p className="text-[10px] text-[#A7A79A]">Your balance</p>
              <p className="text-xs font-semibold text-[#F2F0E8]">{Number(detail.user_balance).toFixed(4)} tokens</p>
            </div>
            <div className="rounded-xl bg-white/[0.03] px-3 py-2">
              <p className="text-[10px] text-[#A7A79A]">Your share</p>
              <p className="text-xs font-semibold text-[#F2F0E8]">{detail.ownership_pct}%</p>
            </div>
          </div>
        )}

        {/* Token list */}
        {detail && detail.underlying_tokens.length > 0 && (
          <div className="mb-3 rounded-xl bg-white/[0.03] px-3 py-2.5">
            <p className="text-[10px] text-[#A7A79A] mb-1.5 font-medium">Vault tokens</p>
            {detail.underlying_tokens.map((t) => (
              <div key={t.address} className="flex justify-between text-xs py-0.5">
                <span className="text-[#F2F0E8]">{t.symbol}</span>
                <span className="text-[#A7A79A]">{Number(t.vault_balance).toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}

        {loadingDetail && (
          <div className="mb-3 h-12 rounded-xl bg-white/[0.03] animate-pulse" />
        )}

        {detailError && (
          <p className="mb-3 text-xs text-red-400">{detailError}</p>
        )}

        {/* Action buttons */}
        <div className="grid grid-cols-4 gap-2">
          {ACTIONS.map((btn) => (
            <button
              key={btn.key}
              onClick={() => { if (detail) setAction(btn.key); }}
              disabled={!detail}
              className="flex flex-col items-center gap-1 rounded-xl border border-[#2A2B27] bg-[#141513] py-2.5 px-1 transition-colors hover:border-[#8FAE82]/40 hover:bg-white/[0.03] disabled:opacity-40"
            >
              <span className="text-base text-[#8FAE82]">{btn.icon}</span>
              <span className="text-[10px] font-medium text-[#A7A79A]">{btn.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Action sheets */}
      {detail && action === "deposit" && (
        <DepositSheet vault={detail} walletAddress={walletAddress} getToken={getToken} onClose={() => setAction(null)} />
      )}
      {detail && action === "withdraw" && (
        <WithdrawSheet vault={detail} walletAddress={walletAddress} getToken={getToken} onClose={() => setAction(null)} />
      )}
      {detail && (action === "rebalance" || action === "weights") && (
        <RebalanceSheet vault={detail} walletAddress={walletAddress} getToken={getToken} onClose={() => setAction(null)} mode={action} />
      )}
    </>
  );
}

// ── Main Section ──────────────────────────────────────────────────────────────

export function VelvetTradingSection() {
  const { user, getAccessToken } = usePrivy();
  const { open: openChat, sendMessage } = useChatSheet();
  const [vaults, setVaults]         = useState<VaultSummary[]>([]);
  const [loading, setLoading]       = useState(false);
  const [loaded, setLoaded]         = useState(false);
  const [showAdd, setShowAdd]       = useState(false);

  const walletAddress = user?.smartWallet?.address ?? user?.wallet?.address ?? "";
  const getToken = useCallback(() => getAccessToken(), [getAccessToken]);

  // Load prefs + API vaults, merge and apply hidden filter
  const loadVaults = useCallback(async () => {
    if (!walletAddress) return;
    setLoading(true);
    try {
      const token = await getToken();
      const authHeaders: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

      const [prefsRes, portfoliosRes] = await Promise.all([
        fetch("/api/velvet/vault-prefs", { headers: authHeaders }).catch(() => null),
        fetch(`/api/velvet/portfolios?address=${encodeURIComponent(walletAddress)}`, { headers: authHeaders }).catch(() => null),
      ]);

      const prefs: VaultPrefs = prefsRes?.ok
        ? await prefsRes.json()
        : { added: [], hidden: [] };

      const hidden = new Set(prefs.hidden.map((a) => a.toLowerCase()));

      const apiVaults: VaultSummary[] = [];
      if (portfoliosRes?.ok) {
        const data = await portfoliosRes.json();
        for (const p of (data.portfolios ?? [])) {
          if (!hidden.has((p.portfolio_address as string).toLowerCase())) {
            apiVaults.push({ ...p, manual: false });
          }
        }
      }

      // Merge manually-added vaults from DB (skip if already from API or hidden)
      const apiAddresses = new Set(apiVaults.map((v) => v.portfolio_address.toLowerCase()));
      const manualVaults: VaultSummary[] = prefs.added
        .filter((a) => !apiAddresses.has(a.toLowerCase()))
        .map((address) => ({
          portfolioId: address,
          name: "Loading…",
          symbol: "—",
          portfolio_address: address,
          rebalancing_address: "",
          asset_management_config: "",
          token_exclusion_manager: "",
          is_public: true,
          manual: true,
        }));

      setVaults([...apiVaults, ...manualVaults]);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }, [walletAddress, getToken]);

  useEffect(() => {
    if (walletAddress && !loaded && !loading) loadVaults();
  }, [walletAddress, loaded, loading, loadVaults]);

  const handleVaultAdded = (vault: VaultSummary) => {
    setVaults((prev) => [...prev.filter((v) => v.portfolio_address !== vault.portfolio_address), vault]);
  };

  const handleRemove = async (address: string, manual: boolean) => {
    const snapshot = vaults;
    setVaults((prev) => prev.filter((v) => v.portfolio_address.toLowerCase() !== address.toLowerCase()));
    try {
      const token = await getToken();
      if (manual) {
        await deletePref(address, token);
      } else {
        await upsertPref(address, "hidden", token);
      }
    } catch {
      setVaults(snapshot);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Header row with Add button */}
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-[#A7A79A]">On-chain vaults · Base mainnet</p>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-xl bg-[#8FAE82]/15 px-3 py-1.5 text-xs font-semibold text-[#8FAE82] hover:bg-[#8FAE82]/25 transition-colors"
        >
          <span>+</span> Add vault
        </button>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <>{[0, 1].map((i) => (
          <div key={i} className="h-36 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] animate-pulse" />
        ))}</>
      )}

      {/* Empty state */}
      {!loading && loaded && vaults.length === 0 && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-6 flex flex-col gap-3">
          <div className="text-center">
            <p className="text-2xl mb-1">🏦</p>
            <p className="text-sm font-semibold text-[#F2F0E8]">No vaults connected</p>
            <p className="text-xs text-[#A7A79A] mt-1">
              Create a vault on Velvet Capital, then add it here to deposit, withdraw, and rebalance.
            </p>
          </div>
          <div className="flex flex-col gap-2 mt-1">
            <button
              onClick={() => setShowAdd(true)}
              className="w-full rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513]"
            >
              + Add existing vault
            </button>
            <a
              href="https://velvet.capital"
              target="_blank"
              rel="noreferrer"
              className="w-full rounded-2xl border border-[#2A2B27] py-3 text-sm font-medium text-[#A7A79A] text-center hover:bg-white/[0.04] transition-colors"
            >
              Create vault on Velvet Capital ↗
            </a>
            <button
              onClick={() => { sendMessage("How do I get started with Velvet Capital on-chain vaults?"); openChat(); }}
              className="w-full rounded-2xl border border-[#2A2B27] py-3 text-sm font-medium text-[#A7A79A] text-center hover:bg-white/[0.04] transition-colors"
            >
              💬 Ask Bluvfi how to get started
            </button>
          </div>
          {walletAddress && (
            <p className="text-center text-[10px] text-[#A7A79A]">
              Connect with <span className="font-mono text-[#8FAE82]">{walletAddress.slice(0, 6)}…{walletAddress.slice(-4)}</span> on velvet.capital
            </p>
          )}
        </div>
      )}

      {/* Vault cards */}
      {!loading && vaults.map((vault) => (
        <VaultCard
          key={vault.portfolio_address}
          vault={vault}
          walletAddress={walletAddress}
          getToken={getToken}
          onRemove={() => handleRemove(vault.portfolio_address, !!vault.manual)}
        />
      ))}

      {/* AI help button when vaults exist */}
      {!loading && vaults.length > 0 && (
        <button
          onClick={() => { sendMessage("Help me manage my Velvet Capital vaults."); openChat(); }}
          className="rounded-xl bg-white/[0.04] px-4 py-2.5 text-xs font-medium text-[#A7A79A] text-center hover:bg-white/[0.07] transition-colors"
        >
          💬 Ask Bluvfi for vault advice
        </button>
      )}

      {/* Add vault sheet */}
      {showAdd && (
        <AddVaultSheet
          walletAddress={walletAddress}
          getToken={getToken}
          onAdded={handleVaultAdded}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
