"use client";

import { useEffect, useState, useCallback } from "react";
import { getCurrentOffering, purchasePackage, restorePurchases } from "@/lib/revenuecat";

interface RCPackage {
  identifier: string;
  product: {
    title: string;
    description: string;
    priceString: string;
    subscriptionPeriod?: string;
  };
}

interface PaywallSheetProps {
  open: boolean;
  onClose: () => void;
  /** Called when a purchase completes successfully. */
  onPurchased?: () => void;
  /** Feature name to display in the header, e.g. "Premium features". */
  featureName?: string;
}

export function PaywallSheet({ open, onClose, onPurchased, featureName = "Premium" }: PaywallSheetProps) {
  const [packages, setPackages] = useState<RCPackage[]>([]);
  const [loading, setLoading] = useState(false);
  const [purchasing, setPurchasing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    getCurrentOffering()
      .then((offering) => {
        const pkgs = (offering as { availablePackages?: RCPackage[] } | null)?.availablePackages ?? [];
        setPackages(pkgs);
      })
      .catch(() => setError("Couldn't load plans. Check your connection and try again."))
      .finally(() => setLoading(false));
  }, [open]);

  const handlePurchase = useCallback(async (pkg: RCPackage) => {
    setPurchasing(true);
    setError(null);
    try {
      const ok = await purchasePackage(pkg);
      if (ok) {
        onPurchased?.();
        onClose();
      } else {
        setError("Purchase cancelled.");
      }
    } catch {
      setError("Purchase failed. Please try again.");
    } finally {
      setPurchasing(false);
    }
  }, [onPurchased, onClose]);

  const handleRestore = useCallback(async () => {
    setRestoring(true);
    setError(null);
    try {
      await restorePurchases();
      onPurchased?.();
      onClose();
    } catch {
      setError("No previous purchases found.");
    } finally {
      setRestoring(false);
    }
  }, [onPurchased, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Sheet */}
      <div className="relative w-full rounded-t-3xl bg-[#1B1C19] px-6 pb-[max(env(safe-area-inset-bottom),28px)] pt-6 shadow-2xl">
        {/* Handle */}
        <div className="mx-auto mb-5 h-1 w-10 rounded-full bg-white/20" />

        <h2 className="mb-1 text-xl font-bold text-[#F2F0E8]">{featureName}</h2>
        <p className="mb-6 text-sm text-[#A7A79A]">Subscribe to unlock all features.</p>

        {loading && (
          <div className="flex items-center justify-center py-10">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
          </div>
        )}

        {!loading && packages.length === 0 && !error && (
          <p className="py-6 text-center text-sm text-[#A7A79A]">No plans available right now.</p>
        )}

        {!loading && packages.map((pkg) => (
          <button
            key={pkg.identifier}
            onClick={() => handlePurchase(pkg)}
            disabled={purchasing || restoring}
            className="mb-3 flex w-full items-center justify-between rounded-2xl border border-[#8FAE82]/30 bg-[#8FAE82]/10 px-5 py-4 text-left transition-colors active:bg-[#8FAE82]/20 disabled:opacity-50"
          >
            <div>
              <p className="font-semibold text-[#F2F0E8]">{pkg.product.title}</p>
              <p className="mt-0.5 text-xs text-[#A7A79A]">{pkg.product.description}</p>
            </div>
            <span className="ml-4 shrink-0 font-bold text-[#8FAE82]">{pkg.product.priceString}</span>
          </button>
        ))}

        {error && (
          <p className="mb-4 text-center text-sm text-red-400">{error}</p>
        )}

        <button
          onClick={handleRestore}
          disabled={purchasing || restoring}
          className="mt-1 w-full py-3 text-center text-sm text-[#A7A79A] disabled:opacity-40"
        >
          {restoring ? "Restoring…" : "Restore purchases"}
        </button>
      </div>
    </div>
  );
}
