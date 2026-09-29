"use client";

import { useState, useEffect, useRef } from "react";

// Countries offered by the Bills providers (Bitrefill, Cryptorefills) and the picker both use.

export type CountryEntry = { code: string; name: string; flag: string; currency: string; lang: string };

export const COUNTRIES: CountryEntry[] = [
  { code: "US", name: "United States",   flag: "🇺🇸", currency: "USD", lang: "en" },
  { code: "GB", name: "United Kingdom",  flag: "🇬🇧", currency: "GBP", lang: "en" },
  { code: "NG", name: "Nigeria",         flag: "🇳🇬", currency: "NGN", lang: "en" },
  { code: "CA", name: "Canada",          flag: "🇨🇦", currency: "CAD", lang: "en" },
  { code: "AU", name: "Australia",       flag: "🇦🇺", currency: "AUD", lang: "en" },
  { code: "IN", name: "India",           flag: "🇮🇳", currency: "INR", lang: "en" },
  { code: "DE", name: "Germany",         flag: "🇩🇪", currency: "EUR", lang: "de" },
  { code: "FR", name: "France",          flag: "🇫🇷", currency: "EUR", lang: "fr" },
  { code: "ES", name: "Spain",           flag: "🇪🇸", currency: "EUR", lang: "es" },
  { code: "IT", name: "Italy",           flag: "🇮🇹", currency: "EUR", lang: "it" },
  { code: "NL", name: "Netherlands",     flag: "🇳🇱", currency: "EUR", lang: "nl" },
  { code: "SE", name: "Sweden",          flag: "🇸🇪", currency: "SEK", lang: "sv" },
  { code: "BR", name: "Brazil",          flag: "🇧🇷", currency: "BRL", lang: "pt" },
  { code: "MX", name: "Mexico",          flag: "🇲🇽", currency: "MXN", lang: "es" },
  { code: "AR", name: "Argentina",       flag: "🇦🇷", currency: "ARS", lang: "es" },
  { code: "CO", name: "Colombia",        flag: "🇨🇴", currency: "COP", lang: "es" },
  { code: "ZA", name: "South Africa",    flag: "🇿🇦", currency: "ZAR", lang: "en" },
  { code: "KE", name: "Kenya",           flag: "🇰🇪", currency: "KES", lang: "en" },
  { code: "GH", name: "Ghana",           flag: "🇬🇭", currency: "GHS", lang: "en" },
  { code: "EG", name: "Egypt",           flag: "🇪🇬", currency: "EGP", lang: "ar" },
  { code: "AE", name: "UAE",             flag: "🇦🇪", currency: "AED", lang: "ar" },
  { code: "SA", name: "Saudi Arabia",    flag: "🇸🇦", currency: "SAR", lang: "ar" },
  { code: "SG", name: "Singapore",       flag: "🇸🇬", currency: "SGD", lang: "en" },
  { code: "PH", name: "Philippines",     flag: "🇵🇭", currency: "PHP", lang: "en" },
  { code: "ID", name: "Indonesia",       flag: "🇮🇩", currency: "IDR", lang: "id" },
  { code: "JP", name: "Japan",           flag: "🇯🇵", currency: "JPY", lang: "ja" },
  { code: "PK", name: "Pakistan",        flag: "🇵🇰", currency: "PKR", lang: "ur" },
  { code: "BD", name: "Bangladesh",      flag: "🇧🇩", currency: "BDT", lang: "bn" },
  { code: "PL", name: "Poland",          flag: "🇵🇱", currency: "PLN", lang: "pl" },
  { code: "TR", name: "Turkey",          flag: "🇹🇷", currency: "TRY", lang: "tr" },
];

export function getCountry(code: string): CountryEntry {
  return COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];
}

export function CountrySelector({
  selected,
  onChange,
}: {
  selected: CountryEntry;
  onChange: (c: CountryEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = search.trim()
    ? COUNTRIES.filter((c) =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.code.toLowerCase().includes(search.toLowerCase()),
      )
    : COUNTRIES;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen((o) => !o); setSearch(""); }}
        className="flex items-center gap-1.5 rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-3 py-2 text-sm text-[#F2F0E8] hover:border-[#8FAE82]/40"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`https://flagcdn.com/20x15/${selected.code.toLowerCase()}.png`}
          alt={selected.name}
          className="w-5 h-[15px] rounded-[2px] object-cover"
        />
        <span className="text-xs text-[#A7A79A]">{selected.currency}</span>
        <span className="ml-0.5 text-[#A7A79A]">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] py-2 shadow-2xl">
          <div className="px-3 pb-2">
            <input
              autoFocus
              type="text"
              placeholder="Search country…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-3 py-1.5 text-xs text-[#F2F0E8] placeholder-[#A7A79A] focus:outline-none"
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.map((c) => (
              <button
                key={c.code}
                onClick={() => { onChange(c); setOpen(false); }}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-white/[0.04] ${
                  c.code === selected.code ? "text-[#8FAE82]" : "text-[#F2F0E8]"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://flagcdn.com/20x15/${c.code.toLowerCase()}.png`}
                  alt={c.name}
                  className="w-5 h-[15px] shrink-0 rounded-[2px] object-cover"
                />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="text-xs text-[#A7A79A]">{c.currency}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
