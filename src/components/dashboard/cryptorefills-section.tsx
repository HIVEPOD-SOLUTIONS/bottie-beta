"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { parsePhoneNumberWithError, type CountryCode } from "libphonenumber-js";
import { QRCodeSVG } from "qrcode.react";
import {
  payCryptorefillsOrder,
  pollCryptorefillsOrder,
  pickEvmWallet,
  friendlyPayError,
  validatePartnerOrder,
  createPartnerOrder,
  pollPartnerOrder,
  RAIL_LABEL,
} from "@/lib/cryptorefills-client";
import { usePaymentsContext } from "@/contexts/payments-context";
import { walletRailFor, sendFromWallet } from "@/lib/wallet-send";
import { COUNTRIES, CountrySelector, getCountry, type CountryEntry } from "./bills-countries";
import { kindOf, cardCategoryOf, type CrCardCategory } from "@/lib/cryptorefills-categories";
import type { CrBrand, CrCatalogItem, CrDelivery, CrOrderStatus, CrPaymentMethod, CrPartnerOrder, CrRail } from "@/lib/cryptorefills";

/** "base"/"solana" = gasless USDC over x402; "other" = any coin via deposit address (partner API). */
type PayWith = CrRail | "other";

/**
 * Cryptorefills under Bills → Browse. Gift cards, phone refills and eSIMs paid
 * with USDC on Base over x402: the user's Privy wallet signs an EIP-3009
 * authorization (no transaction, no gas) and Cryptorefills relays it.
 * Server side lives in lib/cryptorefills.ts and /api/cryptorefills/*.
 */

type Tab = "cards" | "topup" | "esim";
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "cards", label: "Gift Cards", icon: "🎁" },
  { key: "topup", label: "Phone Refills", icon: "📱" },
  { key: "esim", label: "eSIM Data", icon: "🌐" },
];

const tabOf = kindOf;
const cardTabOf = cardCategoryOf;

// Gift-card sub-filters, same set as the Bitrefill browser.
type CardTab = "all" | CrCardCategory;
const CARD_TABS: { key: CardTab; label: string; icon: string }[] = [
  { key: "all", label: "All", icon: "⚡" },
  { key: "entertainment", label: "Entertainment", icon: "🎬" },
  { key: "gaming", label: "Gaming", icon: "🎮" },
  { key: "shopping", label: "Shopping", icon: "🛍️" },
  { key: "food", label: "Food", icon: "🍔" },
  { key: "vpn", label: "Privacy", icon: "🔒" },
  { key: "travel", label: "Travel", icon: "✈️" },
];

const CATEGORY_EMOJI: Record<string, string> = {
  "e-sim": "📡", "e-commerce": "🛒", retail: "🛍️", food: "🍔", groceries: "🥦", apparel_clothing: "👕",
  entertainment: "🎬", streaming: "📺", games: "🎮", electronics: "💻", travel_flights: "✈️", home: "🏠",
  health_beauty: "💄", sports_fitness: "🏋️", charity_donations: "💚",
  mobile_talk_time: "📞", mobile_credits: "📱", mobile_data: "📶", mobile_bundle: "📦",
};

function prettyCategory(c: string): string {
  return c.replace(/[_-]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Official Cryptorefills brand art on its brand colour; category emoji if there's none or it fails to load. */
function BrandLogo({ brand, size = "h-11 w-11" }: { brand: CrBrand; size?: string }) {
  const [failed, setFailed] = useState(false);
  if (!brand.logo_url || failed) {
    return (
      <div className={`flex ${size} shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-xl`}>
        {CATEGORY_EMOJI[brand.category] ?? "🎁"}
      </div>
    );
  }
  return (
    <div className={`${size} shrink-0 overflow-hidden rounded-xl`} style={{ backgroundColor: brand.bg_color ?? "#2A2B27" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={brand.logo_url} alt={brand.brand_name} loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
    </div>
  );
}

// ── Brand list ───────────────────────────────────────────────────────────────

export function CryptorefillsDetail() {
  const [country, setCountry] = useState<CountryEntry>(() => {
    try {
      const saved = localStorage.getItem("cr_country");
      if (saved) return getCountry(saved);
    } catch { /* storage unavailable */ }
    return COUNTRIES[0];
  });
  const [tab, setTab] = useState<Tab>("cards");
  const [cardTab, setCardTab] = useState<CardTab>("all");
  const [query, setQuery] = useState("");
  const [brands, setBrands] = useState<CrBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<CrBrand | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/cryptorefills/brands?country=${country.code.toLowerCase()}`)
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(data.error ?? "Couldn't load products");
        setBrands(data.brands ?? []);
      })
      .catch((e) => { if (!cancelled) { setBrands([]); setError(e.message ?? "Couldn't load products"); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [country, retry]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>(); // the catalogue repeats some brands (e.g. NordPass ×3)
    return brands.filter((b) => {
      if (seen.has(b.brand_name)) return false;
      const match =
        tabOf(b.category) === tab &&
        (tab !== "cards" || cardTab === "all" || cardTabOf(b) === cardTab) &&
        (!q || b.brand_name.toLowerCase().includes(q) || b.category.includes(q));
      if (match) seen.add(b.brand_name);
      return match;
    });
  }, [brands, tab, cardTab, query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-3xl bg-[#8FAE82] p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-[#141513]/70">Cryptorefills</p>
            <p className="mt-1 text-2xl font-bold text-[#141513]">{loading ? "…" : brands.length} brands</p>
            <p className="mt-0.5 text-xs text-[#141513]/60">
              {country.flag} {country.name} · Pay with USDC on Base · No gas
            </p>
          </div>
          <CountrySelector
            selected={country}
            onChange={(c) => {
              setCountry(c);
              try { localStorage.setItem("cr_country", c.code); } catch { /* ignore */ }
            }}
          />
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setCardTab("all"); setQuery(""); }}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key ? "bg-[#F2F0E8] text-[#141513]" : "bg-white/[0.06] text-[#A7A79A]"
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === "cards" && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {CARD_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => { setCardTab(t.key); setQuery(""); }}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                cardTab === t.key
                  ? "bg-[#8FAE82]/20 text-[#8FAE82] border border-[#8FAE82]/40"
                  : "bg-white/[0.04] text-[#A7A79A] border border-transparent"
              }`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A7A79A]">🔍</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === "topup" ? "Search carrier…" : tab === "esim" ? "Search eSIM plans…" : "Search brands…"}
          className="w-full rounded-2xl border border-[#2A2B27] bg-[#1B1C19] py-2.5 pl-9 pr-4 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
        />
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-[68px] animate-pulse rounded-2xl border border-[#2A2B27] bg-[#1B1C19]" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-8 text-center">
          <p className="mb-2 text-2xl">{error ? "⚠️" : "🔍"}</p>
          <p className="text-sm text-[#A7A79A]">
            {error ?? (query ? `No results for "${query}"` : `Nothing in this section for ${country.name} yet`)}
          </p>
          {error && (
            <button onClick={() => setRetry((n) => n + 1)} className="mt-3 text-xs text-[#8FAE82] underline">Retry</button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visible.slice(0, 150).map((b) => (
            <button
              key={b.brand_name}
              onClick={() => setSelected(b)}
              className="flex w-full items-center gap-3 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-left transition-colors hover:border-[#3A3B37] active:bg-white/[0.04]"
            >
              <BrandLogo brand={b} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-[#F2F0E8]">{b.brand_name}</p>
                <p className="truncate text-xs text-[#A7A79A]">
                  {prettyCategory(b.category)}{b.min && b.max ? ` · ${b.min} – ${b.max}` : ""}
                </p>
              </div>
              <span className="shrink-0 rounded-xl bg-[#8FAE82]/15 px-3 py-1.5 text-xs font-semibold text-[#8FAE82]">
                {tab === "topup" ? "Refill" : tab === "esim" ? "Get plan" : "Buy"}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected && (
        <CryptorefillsCheckout brand={selected} country={country} tab={tab} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ── Checkout ─────────────────────────────────────────────────────────────────

type Step = "form" | "quoting" | "confirmPrice" | "signing" | "settling" | "polling" | "deposit" | "done" | "error";

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function CryptorefillsCheckout({
  brand, country, tab, onClose,
}: {
  brand: CrBrand;
  country: CountryEntry;
  tab: Tab;
  onClose: () => void;
}) {
  const { user, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { refetch: refetchPayments } = usePaymentsContext();
  const isTopup = tab === "topup";

  // Payment choice. "other" appears only when the server has a Cryptorefills Partner ID.
  const [payWith, setPayWith] = useState<PayWith>("base");
  const [methods, setMethods] = useState<CrPaymentMethod[]>([]);
  const [partnerEnabled, setPartnerEnabled] = useState(false);
  const [coin, setCoin] = useState("USDT");
  const [network, setNetwork] = useState("");
  const [deposit, setDeposit] = useState<CrPartnerOrder | null>(null);
  const [depositState, setDepositState] = useState<string>("awaiting_payment");

  useEffect(() => {
    fetch("/api/cryptorefills/payment-methods")
      .then((r) => r.json())
      .then((d) => { setPartnerEnabled(!!d.partnerEnabled); setMethods(d.methods ?? []); })
      .catch(() => {});
  }, []);

  const coins = useMemo(() => [...new Set(methods.map((m) => m.coin))], [methods]);
  const networksForCoin = useMemo(() => methods.filter((m) => m.coin === coin), [methods, coin]);
  useEffect(() => {
    if (networksForCoin.length && !networksForCoin.some((m) => m.network === network)) setNetwork(networksForCoin[0].network);
  }, [networksForCoin, network]);

  const [items, setItems] = useState<CrCatalogItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [picked, setPicked] = useState<CrCatalogItem | null>(null);
  const [rangeValue, setRangeValue] = useState<string>("");
  const [rangeQuote, setRangeQuote] = useState<number | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [email, setEmail] = useState(user?.email?.address ?? user?.google?.email ?? "");
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [msg, setMsg] = useState<string | null>(null);
  const [priceConfirm, setPriceConfirm] = useState<{ amount: number; resolve: (ok: boolean) => void } | null>(null);
  const [order, setOrder] = useState<CrOrderStatus | null>(null);
  const pollAbort = useRef(new AbortController());

  useEffect(() => () => pollAbort.current.abort(), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/cryptorefills/catalog?country=${country.code.toLowerCase()}&brand=${encodeURIComponent(brand.brand_name)}`)
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(data.error);
        const list: CrCatalogItem[] = data.items ?? [];
        setItems(list);
        setPicked(list.length === 1 ? list[0] : null);
        if (list.length === 1 && list[0].is_range && list[0].min_value) setRangeValue(String(list[0].min_value));
      })
      .catch((e) => { if (!cancelled) { setStep("error"); setMsg(e.message || "Couldn't load this brand."); } })
      .finally(() => { if (!cancelled) setLoadingItems(false); });
    return () => { cancelled = true; };
  }, [brand.brand_name, country.code]);

  // Range products have no catalogue price; quote the chosen amount (debounced).
  const rangeNum = Number(rangeValue);
  const rangeValid = !!picked?.is_range && rangeNum >= (picked.min_value ?? 0) && rangeNum <= (picked.max_value ?? Infinity);
  useEffect(() => {
    setRangeQuote(null);
    if (!picked?.is_range || !rangeValid) return;
    setQuoting(true);
    const t = setTimeout(() => {
      const qs = new URLSearchParams({
        productId: picked.product_id, country: country.code.toLowerCase(), brand: picked.brand_name, value: String(rangeNum),
      });
      fetch(`/api/cryptorefills/price?${qs}`)
        .then((r) => r.json())
        .then((d) => setRangeQuote(d.quote ? Number(d.quote.price_usdc) : null))
        .catch(() => setRangeQuote(null))
        .finally(() => setQuoting(false));
    }, 400);
    return () => { clearTimeout(t); setQuoting(false); };
  }, [picked, rangeNum, rangeValid, country.code]);

  const priceUsd = picked ? (picked.is_range ? rangeQuote : Number(picked.price_usdc)) : null;

  const handleOutcome = useCallback((o: CrOrderStatus) => {
    setOrder(o);
    refetchPayments?.();
    if (o.status === "completed") { setStep("done"); return; }
    setStep("error");
    setMsg(o.status === "processing"
      ? `Still processing after 10 minutes. Your code will arrive by email; if not, contact support@cryptorefills.com with order ${o.order_id}.`
      : `The order ${o.status}. If you were charged, Cryptorefills refunds automatically. Contact support@cryptorefills.com with order ${o.order_id}.`);
  }, [refetchPayments]);

  const pay = useCallback(async () => {
    if (!picked || priceUsd === null) return;
    setMsg(null);

    let beneficiary = email.trim();
    if (isTopup) {
      try {
        beneficiary = parsePhoneNumberWithError(phone.trim(), country.code as CountryCode).format("E.164");
      } catch {
        setMsg("Enter a valid phone number for this country.");
        return;
      }
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setMsg("Enter a valid email for delivery.");
      return;
    }

    const productName = picked.product_name ?? brand.brand_name;

    if (payWith === "other") {
      // Deposit-address flow. Validate first (dry run), then create — Cryptorefills
      // counts created-but-unpaid orders against the partner key.
      try {
        if (!network) throw new Error("Pick a network.");
        setStep("quoting");
        const req = {
          email: email.trim(),
          brand_name: picked.brand_name,
          country_code: country.code,
          denomination: picked.is_range ? "range" : picked.denomination ?? picked.denomination_label ?? "",
          ...(picked.is_range ? { product_value: rangeNum } : {}),
          beneficiary_account: beneficiary,
          coin,
          network,
        };
        await validatePartnerOrder(req, getAccessToken);
        const created = await createPartnerOrder(req, priceUsd, productName, getAccessToken);
        setDeposit(created);
        setDepositState("awaiting_payment");
        setStep("deposit");
        refetchPayments?.();
        const final = await pollPartnerOrder(created.order_id, getAccessToken, {
          onUpdate: (o) => setDepositState(o.status),
          signal: pollAbort.current.signal,
        });
        if (pollAbort.current.signal.aborted || !final) return;
        refetchPayments?.();
        if (final.status === "completed") {
          setOrder({ order_id: final.order_id, status: "completed", deliveries: final.deliveries });
          setStep("done");
        } else {
          setStep("error");
          setMsg(final.status === "expired"
            ? "The payment window closed before your payment arrived. If you already sent it, contact support@cryptorefills.com with your transaction hash."
            : `The order didn't complete. Contact support@cryptorefills.com with order ${final.order_id}.`);
        }
      } catch (e) {
        setStep("error");
        setMsg(friendlyPayError(e));
      }
      return;
    }

    try {
      const receipt = await payCryptorefillsOrder({
        order: {
          email: email.trim(),
          items: [{
            beneficiary_account: beneficiary,
            product_id: picked.product_id,
            ...(picked.is_range ? { product_value: rangeNum } : {}),
          }],
        },
        productName,
        expectedUsd: priceUsd,
        rail: payWith,
        evmWallet: pickEvmWallet(wallets),
        solanaWallet: solanaWallets[0],
        getAccessToken,
        onStep: setStep,
        confirmPriceChange: (amount) => new Promise<boolean>((resolve) => {
          setPriceConfirm({ amount, resolve: (ok) => { setPriceConfirm(null); resolve(ok); } });
          setStep("confirmPrice");
        }),
      });
      if (!receipt) { setStep("form"); return; }
      setOrder(receipt);
      if (receipt.status !== "processing") { handleOutcome(receipt); return; }
      setStep("polling");
      const final = await pollCryptorefillsOrder(receipt.order_id, getAccessToken, { onUpdate: setOrder, signal: pollAbort.current.signal });
      if (!pollAbort.current.signal.aborted) handleOutcome(final ?? receipt);
    } catch (e) {
      setStep("error");
      setMsg(friendlyPayError(e));
    }
  }, [picked, priceUsd, email, phone, isTopup, country.code, wallets, solanaWallets, rangeNum, brand.brand_name, payWith, coin, network, getAccessToken, handleOutcome, refetchPayments]);

  const busy = step === "quoting" || step === "signing" || step === "settling" || step === "polling";
  const canPay = !!picked && priceUsd !== null && !quoting && (!picked.is_range || rangeValid) && (isTopup ? phone.trim().length > 5 : true);

  return (
    <div className="fixed inset-0 z-[80] flex flex-col">
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={() => { if (!busy) onClose(); }} />
      <div className="flex max-h-[88vh] flex-col rounded-t-3xl bg-[#141513]">
        <div className="flex shrink-0 items-center justify-between border-b border-[#2A2B27] px-5 pb-3 pt-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandLogo brand={brand} size="h-9 w-9" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#F2F0E8]">{brand.brand_name}</p>
              <p className="text-xs text-[#A7A79A]">{country.flag} {country.name} · via Cryptorefills</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-[#A7A79A] hover:text-white disabled:opacity-40"
          >✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 pb-[calc(max(env(safe-area-inset-bottom),24px)+24px)]">
          {step === "done" && order ? (
            <Delivered order={order} email={email} onClose={onClose} />
          ) : step === "error" ? (
            <div className="py-6 text-center">
              <p className="text-3xl">⚠️</p>
              <p className="mt-3 text-sm text-[#F2F0E8]">{msg}</p>
              <button onClick={() => { setStep("form"); setMsg(null); }} className="mt-5 rounded-2xl bg-white/[0.06] px-6 py-2.5 text-sm font-semibold text-[#F2F0E8]">
                Back
              </button>
            </div>
          ) : busy ? (
            <div className="py-10 text-center">
              <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
              <p className="mt-4 text-sm font-semibold text-[#F2F0E8]">
                {step === "quoting" ? (payWith === "other" ? "Getting your payment address…" : "Creating your order…")
                  : step === "signing" ? "Approve the payment in your wallet"
                  : step === "settling" ? `Settling USDC on ${RAIL_LABEL[payWith === "solana" ? "solana" : "base"]}…`
                  : "Paid. Waiting for delivery…"}
              </p>
              {step === "polling" && order && <p className="mt-1 text-xs text-[#A7A79A]">Order {order.order_id}</p>}
            </div>
          ) : step === "confirmPrice" && priceConfirm ? (
            <div className="py-6 text-center">
              <p className="text-sm text-[#F2F0E8]">The price changed to</p>
              <p className="mt-1 text-3xl font-bold text-[#F2F0E8]">{usd(priceConfirm.amount)}</p>
              <p className="mt-1 text-xs text-[#A7A79A]">You were shown {usd(priceUsd ?? 0)}.</p>
              <div className="mt-5 flex gap-2">
                <button onClick={() => priceConfirm.resolve(false)} className="flex-1 rounded-2xl bg-white/[0.06] py-3 text-sm font-semibold text-[#F2F0E8]">Cancel</button>
                <button
                  onClick={() => priceConfirm.resolve(true)}
                  className="flex-1 rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513]"
                >Pay new price</button>
              </div>
            </div>
          ) : step === "deposit" && deposit ? (
            <DepositPanel order={deposit} state={depositState} />
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#A7A79A]">Choose amount</p>
                {loadingItems ? (
                  <div className="h-24 animate-pulse rounded-2xl bg-white/[0.04]" />
                ) : items.length === 0 ? (
                  <p className="text-sm text-[#A7A79A]">No products available for this brand right now.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {items.map((it) => (
                      <button
                        key={it.product_id}
                        onClick={() => { setPicked(it); if (it.is_range && it.min_value) setRangeValue(String(it.min_value)); }}
                        className={`rounded-2xl border p-3 text-left transition-colors ${
                          picked?.product_id === it.product_id ? "border-[#8FAE82] bg-[#8FAE82]/10" : "border-[#2A2B27] bg-[#1B1C19]"
                        }`}
                      >
                        <p className="text-sm font-semibold text-[#F2F0E8]">
                          {it.is_range ? "Custom amount" : it.denomination_label ?? it.denomination}
                        </p>
                        <p className="mt-0.5 text-xs text-[#A7A79A]">
                          {it.is_range ? `${it.min_value}–${it.max_value} ${it.currency ?? ""}` : `${usd(Number(it.price_usdc))} USDC`}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
                {picked?.is_range && (
                  <div className="mt-3">
                    <input
                      type="number"
                      inputMode="decimal"
                      value={rangeValue}
                      min={picked.min_value}
                      max={picked.max_value}
                      onChange={(e) => setRangeValue(e.target.value)}
                      className="w-full rounded-2xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-2.5 text-sm text-[#F2F0E8] focus:border-[#8FAE82] focus:outline-none"
                      placeholder={`Amount in ${picked.currency ?? "local currency"}`}
                    />
                    <p className="mt-1 text-xs text-[#A7A79A]">
                      {!rangeValid ? `Enter ${picked.min_value}–${picked.max_value} ${picked.currency ?? ""}`
                        : quoting ? "Getting price…"
                        : rangeQuote !== null ? `${usd(rangeQuote)} USDC` : "Price unavailable"}
                    </p>
                  </div>
                )}
              </div>

              {isTopup && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#A7A79A]">Phone number to top up</p>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder={country.code === "NG" ? "0803 123 4567" : "Phone number"}
                    className="w-full rounded-2xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
                  />
                </div>
              )}

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#A7A79A]">
                  {isTopup ? "Email for the receipt" : "Deliver to email"}
                </p>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-2xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
                />
              </div>

              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[#A7A79A]">Pay with</p>
                <div className={`grid gap-2 ${partnerEnabled ? "grid-cols-3" : "grid-cols-2"}`}>
                  {([
                    { key: "base", title: "USDC", sub: "Base · no gas" },
                    { key: "solana", title: "USDC", sub: "Solana · no gas" },
                    ...(partnerEnabled ? [{ key: "other", title: "Other crypto", sub: `${coins.length} coins` }] : []),
                  ] as { key: PayWith; title: string; sub: string }[]).map((o) => (
                    <button
                      key={o.key}
                      onClick={() => setPayWith(o.key)}
                      className={`rounded-2xl border p-2.5 text-left transition-colors ${
                        payWith === o.key ? "border-[#8FAE82] bg-[#8FAE82]/10" : "border-[#2A2B27] bg-[#1B1C19]"
                      }`}
                    >
                      <p className="text-sm font-semibold text-[#F2F0E8]">{o.title}</p>
                      <p className="text-[11px] text-[#A7A79A]">{o.sub}</p>
                    </button>
                  ))}
                </div>
                {payWith === "other" && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <select
                      value={coin}
                      onChange={(e) => setCoin(e.target.value)}
                      className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2.5 text-sm text-[#F2F0E8] focus:border-[#8FAE82] focus:outline-none"
                    >
                      {coins.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <select
                      value={network}
                      onChange={(e) => setNetwork(e.target.value)}
                      className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2.5 text-sm text-[#F2F0E8] focus:border-[#8FAE82] focus:outline-none"
                    >
                      {networksForCoin.map((m) => <option key={m.network} value={m.network}>{m.network}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {msg && <p className="text-xs text-red-400">{msg}</p>}

              <button
                onClick={pay}
                disabled={!canPay || (payWith === "other" && !network)}
                className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-40"
              >
                {priceUsd === null || !picked ? "Choose an amount"
                  : payWith === "other" ? `Get ${coin} payment address · ${usd(priceUsd)}`
                  : `Pay ${usd(priceUsd)} USDC`}
              </button>
              <p className="-mt-2 text-center text-[11px] text-[#A7A79A]">
                {payWith === "other"
                  ? `You send ${coin} on ${network || "the chosen network"} from any wallet or exchange · network fee applies`
                  : `USDC on ${RAIL_LABEL[payWith]} · you sign once, no gas`} · digital goods are non-refundable once delivered
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where and how much to send for a deposit-address order, with live status. */
/**
 * One-tap payment of a deposit-address order from the Bluvfi wallet, when it
 * holds that coin on that network (see lib/wallet-send.ts). Remembers the
 * send per order so a re-render or reopen can't pay twice.
 */
function PayFromWallet({ order }: { order: CrPartnerOrder }) {
  const { sendTransaction } = usePrivy();
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const rail = order.coin && order.network ? walletRailFor(order.coin, order.network) : null;
  const key = `cr_paid_${order.order_id}`;
  const [sent, setSent] = useState<string | null>(() => {
    try { return sessionStorage.getItem(key); } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!rail || order.memo || !order.wallet_address || !order.coin_amount) return null;

  const pay = async () => {
    setBusy(true);
    setErr(null);
    try {
      const hash = await sendFromWallet({
        rail, coin: order.coin!, to: order.wallet_address!, amount: order.coin_amount!, sendTransaction,
        evmWallet: pickEvmWallet(wallets), solanaWallet: solanaWallets[0],
      });
      setSent(hash);
      try { sessionStorage.setItem(key, hash); } catch { /* ignore */ }
    } catch (e) {
      const m = (e as Error)?.message ?? "Payment failed.";
      setErr(/reject|denied|cancel/i.test(m) ? "Cancelled. Nothing was sent." : /insufficient|exceeds balance/i.test(m)
        ? `Not enough ${order.coin} on ${order.network} in your wallet. Send it from another wallet using the address above.` : m.split("\n")[0]);
    } finally {
      setBusy(false);
    }
  };

  return sent ? (
    <p className="rounded-2xl bg-green-400/10 px-3 py-2.5 text-xs text-green-400">Sent from your wallet ✓ — waiting for Cryptorefills to confirm it.</p>
  ) : (
    <div>
      <button onClick={pay} disabled={busy} className="w-full rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513] disabled:opacity-50">
        {busy ? "Confirm in your wallet…" : `Pay ${order.coin_amount} ${order.coin} from my wallet`}
      </button>
      {err && <p className="mt-1.5 text-xs text-red-400">{err}</p>}
    </div>
  );
}

export function DepositPanel({ order, state }: { order: CrPartnerOrder; state: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (v: string) => {
    navigator.clipboard?.writeText(v).then(() => { setCopied(v); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  };
  const expires = order.expires_at ? new Date(order.expires_at) : null;
  const status =
    state === "paid" ? "Payment received. Preparing your order…"
    : state === "review" ? "Cryptorefills is reviewing this order. This can take up to 24 hours."
    : "Waiting for your payment…";
  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <p className="text-sm text-[#A7A79A]">Send exactly</p>
        <button onClick={() => copy(order.coin_amount ?? "")} className="mt-1 text-2xl font-bold text-[#F2F0E8]">
          {copied === order.coin_amount ? "Copied" : `${order.coin_amount} ${order.coin ?? ""}`}
        </button>
        <p className="mt-1 text-xs font-semibold text-amber-400">on {order.network} only</p>
      </div>
      <div className="mx-auto rounded-2xl bg-white p-3">
        <QRCodeSVG value={order.qr_text || order.wallet_address || ""} size={168} />
      </div>
      <button onClick={() => copy(order.wallet_address ?? "")} className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-3 text-left">
        <p className="text-xs text-[#A7A79A]">To address · tap to copy</p>
        <p className="mt-1 break-all font-mono text-xs text-[#F2F0E8]">{copied === order.wallet_address ? "Copied" : order.wallet_address}</p>
      </button>
      {order.memo && (
        <button onClick={() => copy(order.memo!)} className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-3 text-left">
          <p className="text-xs text-amber-400">Memo / tag (required)</p>
          <p className="mt-1 font-mono text-sm text-[#F2F0E8]">{copied === order.memo ? "Copied" : order.memo}</p>
        </button>
      )}
      {state === "awaiting_payment" && <PayFromWallet order={order} />}
      <div className="flex items-center gap-2 rounded-2xl bg-white/[0.04] px-3 py-2.5 text-xs text-[#A7A79A]">
        {state !== "review" && <div className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />}
        <span>{status}</span>
      </div>
      <p className="text-center text-[11px] text-[#A7A79A]">
        Sending a different amount, coin or network can delay or lose the payment.
        {expires ? ` Pay before ${expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : ""}
        {" "}You can close this — the code is emailed once paid. Order {order.order_id}
      </p>
    </div>
  );
}

export function Delivered({ order, email, onClose }: { order: CrOrderStatus; email: string; onClose?: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (v: string) => {
    navigator.clipboard?.writeText(v).then(() => { setCopied(v); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  };
  const deliveries: CrDelivery[] = order.deliveries ?? [];
  return (
    <div className="flex flex-col gap-4">
      <div className="text-center">
        <p className="text-4xl">✅</p>
        <p className="mt-2 font-semibold text-[#F2F0E8]">Delivered</p>
        <p className="mt-1 text-xs text-[#A7A79A]">A copy was sent to {email}. Order {order.order_id}</p>
      </div>
      {deliveries.map((d, i) => (
        <div key={i} className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <p className="text-sm font-semibold text-[#F2F0E8]">{d.product_name ?? d.brand_name}</p>
          {[["Code", d.voucher_code], ["PIN", d.pin_serial], ["Security code", d.security_code]].map(([label, v]) =>
            v ? (
              <button key={label} onClick={() => copy(v)} className="mt-2 flex w-full items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2 text-left">
                <span className="text-xs text-[#A7A79A]">{label}</span>
                <span className="font-mono text-sm text-[#F2F0E8]">{copied === v ? "Copied" : v}</span>
              </button>
            ) : null,
          )}
          {d.url && (
            <a href={d.url} target="_blank" rel="noopener noreferrer" className="mt-2 block text-xs text-[#8FAE82] underline">Open redemption link</a>
          )}
          {d.redeem_instructions && <p className="mt-2 whitespace-pre-line text-xs text-[#A7A79A]">{d.redeem_instructions}</p>}
          {!d.voucher_code && !d.url && d.delivery_type !== "inline" && (
            <p className="mt-2 text-xs text-[#A7A79A]">Delivered {d.delivery_type === "by_sms" ? "by SMS" : "by email"}.</p>
          )}
        </div>
      ))}
      {onClose && <button onClick={onClose} className="rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513]">Done</button>}
    </div>
  );
}
