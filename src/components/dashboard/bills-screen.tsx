"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useWallets as useSolanaWallets } from "@privy-io/react-auth/solana";
import { arcKit, AGENT_CHAIN } from "@/lib/arc-kit";
import { Blockchain } from "@circle-fin/app-kit";
import { createViemAdapterFromProvider } from "@circle-fin/adapter-viem-v2";
import { useDemoState } from "@/contexts/demo-state-context";
import { usePaymentsContext } from "@/contexts/payments-context";
import { useChatSheet } from "@/contexts/chat-context";
import type { Chain } from "viem";
import type { MCPProduct, MCPPackage, MCPInvoice } from "@/lib/bitrefill-mcp";
import { authFetch } from "@/lib/api-auth-fetch";
import { parsePhoneNumberWithError, isValidPhoneNumber, AsYouType, getCountryCallingCode } from "libphonenumber-js";
import { QRCodeSVG } from "qrcode.react";

// Alias types to keep internal names readable
type BitrefillProduct = MCPProduct & {
  // compat shims for legacy field names returned by older API shapes
  logoImage?: string;
  fixedPackages?: boolean;
  range?: { min: number; max: number; step: number };
};
type BitrefillPackage = MCPPackage & { value?: number; priceInUsd?: number };
type BitrefillInvoice = MCPInvoice & {
  // compat shims
  id?: string;
  payment?: { address?: string; price?: number };
  code?: string; // convenience field added by the poll route
  /** From get-invoice-by-id: "not_delivered" | "delivered" */
  orders_delivery_status?: string;
};

// ── Country catalog ────────────────────────────────────────────────────────────

type CountryEntry = { code: string; name: string; flag: string; currency: string; lang: string };

const COUNTRIES: CountryEntry[] = [
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

function getCountry(code: string): CountryEntry {
  return COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];
}

// ── Screen-level tabs ─────────────────────────────────────────────────────────

const SCREEN_TABS = [
  { key: "cards",  label: "Gift Cards",    icon: "🎁" },
  { key: "topup",  label: "Phone Refills", icon: "📱" },
  { key: "esim",   label: "eSIM Data",     icon: "🌐" },
] as const;
type ScreenTab = (typeof SCREEN_TABS)[number]["key"];

// ── Gift-card category sub-tabs ───────────────────────────────────────────────

const CARD_TABS = [
  { key: "all",           label: "All",           icon: "⚡" },
  { key: "entertainment", label: "Entertainment",  icon: "🎬" },
  { key: "gaming",        label: "Gaming",         icon: "🎮" },
  { key: "shopping",      label: "Shopping",       icon: "🛍️" },
  { key: "food",          label: "Food",           icon: "🍔" },
  { key: "vpn",           label: "Privacy",        icon: "🔒" },
  { key: "travel",        label: "Travel",         icon: "✈️" },
] as const;
type CardTab = (typeof CARD_TABS)[number]["key"];

const CARD_TAB_TO_CATEGORY: Record<CardTab, string | undefined> = {
  all: undefined, entertainment: "entertainment", gaming: "gaming",
  shopping: "shopping", food: "food", vpn: "vpn", travel: "travel",
};

// ── Emoji fallback logos ──────────────────────────────────────────────────────

function productEmoji(name: string, screenTab: ScreenTab, cardTab?: CardTab): string {
  if (screenTab === "esim")  return "📡";
  const n = name.toLowerCase();
  if (screenTab === "topup") {
    // ── African operators ──
    if (n.includes("mtn"))              return "🟡";
    if (n.includes("airtel"))           return "🔴";
    if (n.includes("glo"))              return "🟢";
    if (n.includes("9mobile") || n.includes("etisalat")) return "🟢";
    if (n.includes("safaricom") || n.includes("m-pesa")) return "🟢";
    if (n.includes("vodacom"))          return "🔴";
    if (n.includes("orange"))           return "🟠";
    if (n.includes("telecel") || n.includes("tigo"))     return "🔵";
    if (n.includes("moov"))             return "🔵";
    if (n.includes("wave"))             return "🌊";
    if (n.includes("expresso"))         return "☕";
    if (n.includes("africell"))         return "🟠";
    if (n.includes("celtel"))           return "🔵";
    // ── Global carriers ──
    if (n.includes("at&t"))             return "📶";
    if (n.includes("verizon"))          return "🔵";
    if (n.includes("t-mobile"))         return "🩷";
    if (n.includes("sprint"))           return "🟡";
    if (n.includes("boost"))            return "🚀";
    if (n.includes("cricket"))          return "🦗";
    if (n.includes("metro"))            return "🚇";
    if (n.includes("straight talk"))    return "📞";
    if (n.includes("vodafone"))         return "🔴";
    if (n.includes("o2"))               return "🔵";
    if (n.includes("three") || n.includes("3 uk")) return "3️⃣";
    if (n.includes("ee uk") || (n.includes("ee") && n.includes("uk"))) return "📱";
    if (n.includes("telcel"))           return "🟢";
    if (n.includes("claro"))            return "🔴";
    if (n.includes("entel"))            return "🔵";
    if (n.includes("digitel"))          return "🔵";
    if (n.includes("digicel"))          return "🔴";
    if (n.includes("flow"))             return "🌊";
    if (n.includes("bmobile"))          return "🔵";
    if (n.includes("globe"))            return "🌐";
    if (n.includes("smart") && !n.includes("smarty")) return "💡";
    if (n.includes("dito"))             return "📱";
    if (n.includes("jio"))              return "🔵";
    if (n.includes("aircel"))           return "🔵";
    if (n.includes("bsnl"))             return "🟡";
    if (n.includes("vi ") || n.includes("vodafone idea")) return "🔴";
    if (n.includes("grameenphone"))     return "🟢";
    if (n.includes("robi"))             return "🔴";
    if (n.includes("banglalink"))       return "🟠";
    if (n.includes("dialog"))           return "🔵";
    if (n.includes("mobitel"))          return "🟢";
    if (n.includes("zain"))             return "🔵";
    if (n.includes("ooredoo"))          return "🔴";
    if (n.includes("stc"))              return "🟢";
    if (n.includes("du ") || n.includes("du mobile")) return "🔵";
    if (n.includes("etecsa"))           return "🇨🇺";
    if (n.includes("digimobil"))        return "🔵";
    if (n.includes("lycamobile") || n.includes("lyca")) return "🟣";
    if (n.includes("lebara"))           return "🔵";
    if (n.includes("fido"))             return "🐕";
    if (n.includes("rogers"))           return "🔴";
    if (n.includes("bell "))            return "🔔";
    if (n.includes("telus"))            return "🟢";
    if (n.includes("koodo"))            return "🐨";
    if (n.includes("virgin"))           return "🔴";
    return "📱";
  }
  // ── Streaming & entertainment ──
  if (n.includes("netflix"))            return "🎬";
  if (n.includes("spotify"))            return "🎵";
  if (n.includes("apple"))             return "🍎";
  if (n.includes("disney"))            return "✨";
  if (n.includes("hulu"))              return "🟩";
  if (n.includes("youtube") || n.includes("yt premium")) return "▶️";
  if (n.includes("hbo") || n.includes("max"))            return "👑";
  if (n.includes("paramount"))         return "⛰️";
  if (n.includes("peacock"))           return "🦚";
  if (n.includes("dazn"))              return "⚽";
  if (n.includes("showtime"))          return "🎭";
  if (n.includes("starz"))             return "⭐";
  if (n.includes("crunchyroll"))       return "🍥";
  if (n.includes("funimation"))        return "🎌";
  if (n.includes("tidal"))             return "🌊";
  if (n.includes("deezer"))            return "🎶";
  if (n.includes("soundcloud"))        return "☁️";
  if (n.includes("audible"))           return "🎧";
  if (n.includes("kindle") || n.includes("e-book")) return "📖";
  if (n.includes("canva"))             return "🎨";
  if (n.includes("adobe"))             return "🔴";
  // ── Shopping & delivery ──
  if (n.includes("amazon"))            return "📦";
  if (n.includes("ebay"))              return "🏪";
  if (n.includes("walmart"))           return "🛒";
  if (n.includes("target"))            return "🎯";
  if (n.includes("best buy"))          return "💻";
  if (n.includes("ikea"))              return "🛋️";
  if (n.includes("aliexpress") || n.includes("alibaba")) return "🏮";
  if (n.includes("shein"))             return "👗";
  if (n.includes("zalando"))           return "👟";
  if (n.includes("asos"))              return "🧥";
  if (n.includes("instacart"))         return "🛒";
  if (n.includes("doordash"))          return "🚪";
  if (n.includes("grubhub"))           return "🥡";
  if (n.includes("postmates"))         return "🛵";
  if (n.includes("deliveroo"))         return "🦘";
  if (n.includes("just eat") || n.includes("justeat")) return "🍕";
  if (n.includes("glovo"))             return "🔵";
  // ── Ride & travel ──
  if (n.includes("uber"))              return "🚗";
  if (n.includes("lyft"))              return "🩷";
  if (n.includes("bolt"))              return "⚡";
  if (n.includes("grab"))              return "🚖";
  if (n.includes("gojek"))             return "🛵";
  if (n.includes("airbnb"))            return "🏠";
  if (n.includes("booking"))           return "🏨";
  if (n.includes("expedia"))           return "✈️";
  if (n.includes("hotels.com"))        return "🏩";
  if (n.includes("skyscanner"))        return "🛫";
  // ── Gaming ──
  if (n.includes("steam"))             return "🎮";
  if (n.includes("xbox") || n.includes("game pass")) return "🟩";
  if (n.includes("playstation") || n.includes("psn")) return "🕹️";
  if (n.includes("nintendo") || n.includes("eshop")) return "🎮";
  if (n.includes("roblox"))            return "🧱";
  if (n.includes("fortnite"))          return "🎯";
  if (n.includes("minecraft"))         return "⛏️";
  if (n.includes("valorant"))          return "🔫";
  if (n.includes("league of legends") || n.includes("riot")) return "⚔️";
  if (n.includes("pubg"))              return "🎯";
  if (n.includes("free fire") || n.includes("garena")) return "🔥";
  if (n.includes("genshin"))           return "⚔️";
  if (n.includes("mobile legends"))    return "🏆";
  if (n.includes("clash") || n.includes("supercell")) return "⚔️";
  if (n.includes("brawl stars"))       return "⭐";
  if (n.includes("cod") || n.includes("call of duty")) return "🎖️";
  if (n.includes("ea ") || n.includes("fifa") || n.includes("origin")) return "⚽";
  if (n.includes("ubisoft"))           return "🐶";
  if (n.includes("razer"))             return "🐍";
  if (n.includes("battle.net") || n.includes("blizzard")) return "🌀";
  if (n.includes("google play"))       return "🔍";
  // ── Utilities & tech ──
  if (n.includes("google"))            return "🔍";
  if (n.includes("microsoft") || n.includes("office 365")) return "🪟";
  if (n.includes("nordvpn") || n.includes("surfshark") || n.includes("expressvpn") || n.includes("vpn")) return "🔒";
  if (n.includes("discord"))           return "💬";
  if (n.includes("tinder"))            return "❤️";
  if (n.includes("bumble"))            return "🐝";
  if (n.includes("telegram"))          return "✈️";
  if (n.includes("claude") || n.includes("openai") || n.includes("chatgpt")) return "🤖";
  if (n.includes("dropbox"))           return "📦";
  if (n.includes("zoom"))              return "📹";
  if (n.includes("skype"))             return "🔵";
  if (n.includes("duolingo"))          return "🦉";
  if (n.includes("masterclass"))       return "🎓";
  if (n.includes("udemy") || n.includes("coursera")) return "📚";
  // ── Category fallbacks ──
  if (cardTab === "entertainment")   return "🎬";
  if (cardTab === "gaming")          return "🎮";
  if (cardTab === "shopping")        return "🛍️";
  if (cardTab === "food")            return "🍔";
  if (cardTab === "vpn")             return "🔒";
  if (cardTab === "travel")          return "✈️";
  return "🎁";
}

function priceRange(product: BitrefillProduct): string | null {
  const pkgs = product.packages ?? [];
  if (pkgs.length > 0) {
    // Prefer price_usd (already USD or converted via price_rate in normalizer)
    const usdVals = pkgs
      .map((p) => p.price_usd ?? (p as BitrefillPackage).priceInUsd)
      .filter((v): v is number => v != null && v > 0);
    if (usdVals.length > 0) {
      const min = Math.min(...usdVals);
      const max = Math.max(...usdVals);
      return min === max ? `$${min}` : `$${min}–$${max}`;
    }
    // Fallback: native currency denomination
    const nativeVals = pkgs
      .map((p) => Number(p.package_value ?? 0))
      .filter((v) => v > 0);
    if (nativeVals.length === 0) return null;
    const min = Math.min(...nativeVals);
    const max = Math.max(...nativeVals);
    const sym = product.currency && product.currency !== "USD" ? `${product.currency} ` : "$";
    return min === max ? `${sym}${min}` : `${sym}${min}–${sym}${max}`;
  }
  if (product.range) {
    const { min, max, price_rate } = product.range as BitrefillProduct["range"] & { price_rate?: number };
    if (price_rate) {
      // Show USD-converted range
      const usdMin = (min * price_rate).toFixed(2);
      const usdMax = (max * price_rate).toFixed(2);
      return usdMin === usdMax ? `$${usdMin}` : `$${usdMin}–$${usdMax}`;
    }
    // Native currency range
    const sym = product.currency && product.currency !== "USD" ? `${product.currency} ` : "$";
    return `${sym}${min}–${sym}${max}`;
  }
  return null; // no pricing data from search — checkout sheet will load it
}

/** Format a raw Bitrefill category slug into a human-readable label. */
function formatCategory(category: string): string {
  if (!category) return "";
  return category
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const BITREFILL_OFFICIAL_LOGO =
  "https://files.readme.io/4d0d667c7bc96cf97cd030670700d5a4163c361f3ed8a83dec0b6b1ce5cc5076-iOS_app_icon_1024.png";

/**
 * Maps well-known brand name fragments to their root domain.
 * Used to fetch logos via the Google Favicon API (sz=128).
 * Google Favicon returns a real icon for known brands and a generic globe
 * (726 bytes) for unknowns — the img onError handler falls back to emoji either way.
 */
const BRAND_DOMAIN: Record<string, string> = {
  // ── Streaming / entertainment ──
  "netflix":          "netflix.com",
  "spotify":          "spotify.com",
  "apple":            "apple.com",
  "disney":           "disneyplus.com",
  "hulu":             "hulu.com",
  "youtube":          "youtube.com",
  "yt premium":       "youtube.com",
  "hbo":              "hbomax.com",
  " max ":            "max.com",
  "paramount":        "paramountplus.com",
  "peacock":          "peacocktv.com",
  "dazn":             "dazn.com",
  "showtime":         "showtime.com",
  "starz":            "starz.com",
  "crunchyroll":      "crunchyroll.com",
  "funimation":       "funimation.com",
  "tidal":            "tidal.com",
  "deezer":           "deezer.com",
  "soundcloud":       "soundcloud.com",
  "audible":          "audible.com",
  "kindle":           "amazon.com",
  "canva":            "canva.com",
  "adobe":            "adobe.com",
  // ── Shopping ──
  "amazon":           "amazon.com",
  "ebay":             "ebay.com",
  "walmart":          "walmart.com",
  "target":           "target.com",
  "best buy":         "bestbuy.com",
  "ikea":             "ikea.com",
  "aliexpress":       "aliexpress.com",
  "shein":            "shein.com",
  "zalando":          "zalando.com",
  "asos":             "asos.com",
  // ── Food delivery ──
  "instacart":        "instacart.com",
  "doordash":         "doordash.com",
  "uber eats":        "ubereats.com",
  "grubhub":          "grubhub.com",
  "deliveroo":        "deliveroo.com",
  "just eat":         "just-eat.com",
  "glovo":            "glovoapp.com",
  // ── Ride / travel ──
  "uber":             "uber.com",
  "lyft":             "lyft.com",
  "bolt":             "bolt.eu",
  "grab":             "grab.com",
  "airbnb":           "airbnb.com",
  "booking":          "booking.com",
  "expedia":          "expedia.com",
  "skyscanner":       "skyscanner.com",
  // ── Gaming ──
  "steam":            "steampowered.com",
  "xbox":             "xbox.com",
  "game pass":        "xbox.com",
  "playstation":      "playstation.com",
  "psn":              "playstation.com",
  "nintendo":         "nintendo.com",
  "roblox":           "roblox.com",
  "fortnite":         "epicgames.com",
  "minecraft":        "minecraft.net",
  "valorant":         "playvalorant.com",
  "league of legends":"leagueoflegends.com",
  "riot":             "riotgames.com",
  "free fire":        "ff.garena.com",
  "garena":           "garena.com",
  "genshin":          "genshin.hoyoverse.com",
  "mobile legends":   "mobilelegends.net",
  "clash":            "supercell.com",
  "supercell":        "supercell.com",
  "brawl stars":      "supercell.com",
  "call of duty":     "callofduty.com",
  "ea ":              "ea.com",
  "fifa":             "ea.com",
  "origin":           "ea.com",
  "ubisoft":          "ubisoft.com",
  "razer":            "razer.com",
  "battle.net":       "battle.net",
  "blizzard":         "blizzard.com",
  "google play":      "play.google.com",
  "pubg":             "pubg.com",
  // ── Utilities / tech ──
  "google":           "google.com",
  "microsoft":        "microsoft.com",
  "office 365":       "microsoft.com",
  "nordvpn":          "nordvpn.com",
  "surfshark":        "surfshark.com",
  "expressvpn":       "expressvpn.com",
  "discord":          "discord.com",
  "tinder":           "tinder.com",
  "bumble":           "bumble.com",
  "telegram":         "telegram.org",
  "dropbox":          "dropbox.com",
  "zoom":             "zoom.us",
  "skype":            "skype.com",
  "duolingo":         "duolingo.com",
  "masterclass":      "masterclass.com",
  "udemy":            "udemy.com",
  "coursera":         "coursera.org",
  // ── Nigerian retail ──
  "justrite":         "justritesuperstore.com",
  "spar nigeria":     "sparng.com",
  "suregifts":        "suregifts.com",
  // ── African telecoms ──
  "airtel":           "airtel.com",
  "glo":              "gloworld.com",
  "9mobile":          "9mobile.com.ng",
  "mtn":              "mtn.com",
  "safaricom":        "safaricom.co.ke",
  "vodacom":          "vodacom.co.za",
  "orange":           "orange.com",
  "vodafone":         "vodafone.com",
  "moov":             "moov.africa",
  // ── VPN / privacy ──
  "hotelgift":        "hotelgift.com",
};

/** Return the Google Favicon URL for a brand, or undefined if no domain mapping. */
function brandFaviconUrl(name: string): string | undefined {
  const n = name.toLowerCase();
  for (const [fragment, domain] of Object.entries(BRAND_DOMAIN)) {
    if (n.includes(fragment)) {
      return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    }
  }
  return undefined;
}

/** Resolve the product logo URL.
 *  1. Bitrefill-branded products → official Bitrefill logo.
 *  2. API-provided logo_url (set when Bitrefill actually returns one).
 *  3. Google Favicon for brands in the BRAND_DOMAIN map.
 *  4. Returns undefined → caller shows emoji fallback instead. */
function logoUrl(product: BitrefillProduct): string | undefined {
  if (product.name?.toLowerCase().startsWith("bitrefill")) {
    return BITREFILL_OFFICIAL_LOGO;
  }
  return (
    product.logo_url ??
    (product as any).logoImage ??
    brandFaviconUrl(product.name)
  );
}

/** Resolve the display value of a package. */
function pkgDisplayValue(pkg: BitrefillPackage): string {
  return pkg.package_value !== undefined ? String(pkg.package_value) : String(pkg.value ?? "");
}

/** Resolve the USD price of a package, or null when no USD price is available. */
function pkgPriceUsd(pkg: BitrefillPackage): number {
  return pkg.price_usd ?? pkg.priceInUsd ?? Number(pkg.package_value ?? 0);
}

/** Format a package's denomination for display.
 *  Uses price_usd ($) when available; falls back to native currency. */
function pkgLabel(pkg: BitrefillPackage, productCurrency: string): string {
  if (pkg.price_usd != null)  return `$${pkg.price_usd.toFixed(2)}`;
  if ((pkg as any).priceInUsd != null) return `$${((pkg as any).priceInUsd as number).toFixed(2)}`;
  const val = String(pkg.package_value ?? (pkg as any).value ?? "");
  const cur = (pkg as any).package_currency ?? productCurrency;
  if (cur === "USD") return `$${val}`;
  return `${cur} ${val}`;
}

/** True when the product has a fixed package list (vs range pricing). */
function hasFixedPackages(product: BitrefillProduct): boolean {
  if (product.fixedPackages !== undefined) return product.fixedPackages;
  return (product.packages?.length ?? 0) > 0 && !product.range;
}

// ── Country Selector ──────────────────────────────────────────────────────────

function CountrySelector({
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

// ── Product card ──────────────────────────────────────────────────────────────

function ProductCard({
  product,
  screenTab,
  onSelect,
  purchased,
}: {
  product: BitrefillProduct;
  screenTab: ScreenTab;
  onSelect: (p: BitrefillProduct) => void;
  purchased?: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      {/* Logo */}
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] overflow-hidden">
        {logoUrl(product) && !imgFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl(product)!}
            alt={product.name}
            className="h-full w-full object-contain p-1"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="text-xl">{productEmoji(product.name, screenTab)}</span>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-[#F2F0E8]">{product.name}</p>
        <p className="text-xs text-[#A7A79A]">
          {(product.recipient_type === "esim"         || screenTab === "esim")  ? "Data plan" :
           (product.recipient_type === "phone_number" || screenTab === "topup") ? "Mobile top-up" :
           formatCategory(product.category)}
          {product.currency ? ` · ${product.currency}` : ""}
        </p>
      </div>

      {/* Price + action */}
      <div className="shrink-0 text-right">
        {purchased ? (
          <span className="rounded-full bg-green-900/40 px-2.5 py-1 text-xs font-medium text-green-400">
            Done ✓
          </span>
        ) : product.in_stock === false ? (
          <span className="rounded-full bg-[#2A2B27] px-2.5 py-1 text-xs font-medium text-[#5C5D58]">
            Out of stock
          </span>
        ) : (
          <>
            {priceRange(product) !== null && (
              <p className="text-sm font-semibold text-[#F2F0E8]">{priceRange(product)}</p>
            )}
            <button
              onClick={() => onSelect(product)}
              className="mt-1 rounded-xl bg-[#8FAE82] px-3 py-1 text-xs font-semibold text-[#141513]"
            >
              {(product.recipient_type === "phone_number" || screenTab === "topup") ? "Refill"
               : (product.recipient_type === "esim"         || screenTab === "esim")  ? "Get Plan"
               : "Buy"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Fetch with retry (handles Turbopack cold-start 502s) ─────────────────────
/**
 * Fetch a URL and retry once after a short delay if the first attempt returns
 * a 5xx error. Turbopack lazily compiles API routes on their first request,
 * which can cause a 502 on cold start; the retry always succeeds once the
 * module has been compiled.
 */
async function fetchWithRetry(url: string, retries = 2, delayMs = 1200): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url);
    if (res.ok || res.status < 500 || i === retries - 1) return res;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return fetch(url); // unreachable but keeps TS happy
}

// ── Payment method definitions ────────────────────────────────────────────────

/**
 * "evm"     → direct Arc wallet payment (USDC/USDT on EVM chains)
 * "solana"  → direct Arc wallet payment (USDC/USDT on Solana)
 * "address" → Bitrefill returns a deposit address; user sends manually (BTC, LTC, TON, etc.)
 * "link"    → truly link-only (fiat, etc.) — redirect to Bitrefill web checkout
 */
type PMChain = "evm" | "solana" | "address" | "link";

type PaymentMethodDef = {
  id: string;
  label: string;
  token: string;
  icon: string;
  badge: string;
  badgeColor: string;
  chain: PMChain;
};

const PAYMENT_METHOD_GROUPS: { label: string; methods: PaymentMethodDef[] }[] = [
  {
    label: "USDT",
    methods: [
      { id: "usdt_erc20",       label: "Ethereum", token: "USDT", icon: "⟠",  badge: "USDT", badgeColor: "text-blue-300",   chain: "evm"     },
      { id: "usdt_base",        label: "Base",     token: "USDT", icon: "🔷", badge: "USDT", badgeColor: "text-blue-400",   chain: "evm"     },
      { id: "usdt_solana",      label: "Solana",   token: "USDT", icon: "◎",  badge: "USDT", badgeColor: "text-purple-400", chain: "solana"  },
      { id: "usdt_polygon",     label: "Polygon",  token: "USDT", icon: "🟣", badge: "USDT", badgeColor: "text-purple-300", chain: "evm"     },
      { id: "usdt_arbitrum",    label: "Arbitrum", token: "USDT", icon: "🔵", badge: "USDT", badgeColor: "text-blue-400",   chain: "evm"     },
      { id: "usdt_optimism",    label: "Optimism", token: "USDT", icon: "🟠", badge: "USDT", badgeColor: "text-orange-400",  chain: "evm"     },
      { id: "usdt_bsc",         label: "BSC",      token: "USDT", icon: "🟡", badge: "USDT", badgeColor: "text-yellow-400", chain: "evm"     },
      // usdt_base and usdt_optimism are shown above and pre-wired to the smart wallet flow.
      // Bitrefill's API does not currently return those IDs, so they are filtered out at
      // render time — they will appear automatically once Bitrefill adds support.
      { id: "usdt_trc20",       label: "Tron",     token: "USDT", icon: "🔴", badge: "USDT", badgeColor: "text-red-400",    chain: "address" },
      { id: "usdt_ton",         label: "TON",      token: "USDT", icon: "💎", badge: "USDT", badgeColor: "text-blue-300",   chain: "address" },
      { id: "usdt_sui",         label: "SUI",      token: "USDT", icon: "🌊", badge: "USDT", badgeColor: "text-cyan-400",   chain: "address" },
      { id: "usdt_lightning",   label: "Lightning",token: "USDT", icon: "⚡", badge: "USDT", badgeColor: "text-yellow-400", chain: "address" },
    ],
  },
  {
    label: "USDC",
    methods: [
      { id: "usdc_base",     label: "Base",     token: "USDC", icon: "🔷", badge: "USDC", badgeColor: "text-blue-400",   chain: "evm"    },
      { id: "usdc_solana",   label: "Solana",   token: "USDC", icon: "◎",  badge: "USDC", badgeColor: "text-purple-400", chain: "solana" },
      { id: "usdc_erc20",    label: "Ethereum", token: "USDC", icon: "⟠",  badge: "USDC", badgeColor: "text-blue-300",   chain: "evm"    },
      { id: "usdc_polygon",  label: "Polygon",  token: "USDC", icon: "🟣", badge: "USDC", badgeColor: "text-purple-300", chain: "evm"    },
      { id: "usdc_arbitrum", label: "Arbitrum", token: "USDC", icon: "🔵", badge: "USDC", badgeColor: "text-blue-400",   chain: "evm"    },
      { id: "usdc_optimism", label: "Optimism", token: "USDC", icon: "🟠", badge: "USDC", badgeColor: "text-orange-400", chain: "evm"    },
      { id: "usdc_bsc",      label: "BSC",      token: "USDC", icon: "🟡", badge: "USDC", badgeColor: "text-yellow-400", chain: "address" },
      { id: "usdc_sui",      label: "SUI",      token: "USDC", icon: "🌊", badge: "USDC", badgeColor: "text-cyan-400",   chain: "address" },
    ],
  },
  {
    label: "BRUSD",
    methods: [
      { id: "brusd_base",     label: "Base",     token: "BRUSD", icon: "🔷", badge: "BRUSD", badgeColor: "text-blue-400",   chain: "address" },
      { id: "brusd_erc20",    label: "Ethereum", token: "BRUSD", icon: "⟠",  badge: "BRUSD", badgeColor: "text-blue-300",   chain: "address" },
      { id: "brusd_polygon",  label: "Polygon",  token: "BRUSD", icon: "🟣", badge: "BRUSD", badgeColor: "text-purple-300", chain: "address" },
      { id: "brusd_arbitrum", label: "Arbitrum", token: "BRUSD", icon: "🔵", badge: "BRUSD", badgeColor: "text-blue-400",   chain: "address" },
      { id: "brusd_bsc",      label: "BSC",      token: "BRUSD", icon: "🟡", badge: "BRUSD", badgeColor: "text-yellow-400", chain: "address" },
    ],
  },
  {
    label: "Crypto",
    methods: [
      // All methods below are "address_based" — Bitrefill returns a deposit address.
      // User sends the exact amount manually; we poll for confirmation.
      { id: "ethereum",     label: "ETH",        token: "ETH",  icon: "⟠",  badge: "Ethereum",  badgeColor: "text-blue-300",   chain: "address" },
      { id: "eth_base",     label: "ETH",        token: "ETH",  icon: "⟠",  badge: "Base",      badgeColor: "text-blue-400",   chain: "address" },
      { id: "eth_arbitrum", label: "ETH",        token: "ETH",  icon: "⟠",  badge: "Arbitrum",  badgeColor: "text-blue-400",   chain: "address" },
      { id: "solana",       label: "SOL",        token: "SOL",  icon: "◎",  badge: "Solana",    badgeColor: "text-purple-400", chain: "address" },
      { id: "sui",          label: "SUI",        token: "SUI",  icon: "🌊", badge: "SUI",       badgeColor: "text-cyan-400",   chain: "address" },
      { id: "bnb_bsc",      label: "BNB",        token: "BNB",  icon: "🟡", badge: "BSC",       badgeColor: "text-yellow-300", chain: "address" },
      { id: "bitcoin",      label: "Bitcoin",    token: "BTC",  icon: "₿",  badge: "BTC",       badgeColor: "text-orange-400", chain: "address" },
      { id: "lightning",    label: "Lightning",  token: "BTC",  icon: "⚡", badge: "Lightning", badgeColor: "text-yellow-400", chain: "address" },
      { id: "ton",          label: "TON",        token: "TON",  icon: "💎", badge: "TON",       badgeColor: "text-blue-300",   chain: "address" },
      { id: "litecoin",     label: "Litecoin",   token: "LTC",  icon: "Ł",  badge: "LTC",       badgeColor: "text-gray-300",   chain: "address" },
      { id: "dogecoin",     label: "Dogecoin",   token: "DOGE", icon: "🐕", badge: "DOGE",      badgeColor: "text-yellow-300", chain: "address" },
      { id: "dash",         label: "Dash",       token: "DASH", icon: "🔹", badge: "DASH",      badgeColor: "text-blue-300",   chain: "address" },
      { id: "ark",          label: "ARK",        token: "ARK",  icon: "🚀", badge: "ARK",       badgeColor: "text-red-400",    chain: "address" },
      { id: "brc_solana",   label: "BRC",        token: "BRC",  icon: "◎",  badge: "Solana",    badgeColor: "text-purple-400", chain: "address" },
      { id: "usdc_tempo",   label: "USDC",       token: "USDC", icon: "⚡", badge: "Tempo",     badgeColor: "text-green-400",  chain: "address" },
      { id: "usdt_tempo",   label: "USDT",       token: "USDT", icon: "⚡", badge: "Tempo",     badgeColor: "text-green-400",  chain: "address" },
    ],
  },
  {
    // Link-only: redirect to Bitrefill/exchange web checkout
    label: "Exchange Pay",
    methods: [
      { id: "binance_pay", label: "Binance Pay", token: "BNB", icon: "🔶", badge: "Binance", badgeColor: "text-yellow-400", chain: "link" },
      { id: "kraken_pay",  label: "Kraken Pay",  token: "KRK", icon: "🐙", badge: "Kraken",  badgeColor: "text-purple-400", chain: "link" },
    ],
  },
  // Fiat methods (fiat_card, google_pay, apple_pay, ideal, eps, p24, bancontact) are intentionally excluded.
  // Bitrefill restricts fiat to select regions and our app is crypto-first.
];

const ALL_PAYMENT_METHODS = PAYMENT_METHOD_GROUPS.flatMap((g) => g.methods);

/**
 * Maps Bitrefill payment method IDs to the Arc AppKit Blockchain enum.
 * Used as the `from.chain` in arcKit.send() (the ArcKit EOA fallback).
 * BSC is absent — Circle's AppKit has no BSC support.
 * Defaults to AGENT_CHAIN (Base) for any unmapped method.
 */
const BITREFILL_EVM_CHAINS: Record<string, Blockchain> = {
  usdc_base:      Blockchain.Base,
  usdt_base:      Blockchain.Base,
  usdc_erc20:     Blockchain.Ethereum,
  usdt_erc20:     Blockchain.Ethereum,
  ethereum:       Blockchain.Ethereum,
  usdc_polygon:   Blockchain.Polygon,
  usdt_polygon:   Blockchain.Polygon,
  usdc_arbitrum:  Blockchain.Arbitrum,
  usdt_arbitrum:  Blockchain.Arbitrum,
  eth_arbitrum:   Blockchain.Arbitrum,
  usdc_optimism:  Blockchain.Optimism,
  usdt_optimism:  Blockchain.Optimism,
};

function getEvmChain(pmId: string): Blockchain {
  return BITREFILL_EVM_CHAINS[pmId] ?? AGENT_CHAIN;
}

function getPaymentMethod(id: string): PaymentMethodDef {
  return ALL_PAYMENT_METHODS.find((m) => m.id === id) ?? ALL_PAYMENT_METHODS[0];
}

// ── Checkout sheet ────────────────────────────────────────────────────────────

type CheckoutStep = "prepay" | "email" | "pick" | "paying" | "address" | "polling" | "done" | "error";

/** Maps intermediate Bitrefill invoice statuses to a human-readable label. */
function invoiceStatusLabel(status: string): string {
  switch (status) {
    case "unpaid":             return "Waiting for payment…";
    case "payment_detected":   return "Payment detected · waiting for confirmation…";
    case "payment_confirmed":  return "Payment confirmed · processing order…";
    case "pending":            return "Processing your order…";
    default:                   return "Payment received · processing…";
  }
}

// ── About / Info accordion for checkout sheet ─────────────────────────────────

function AccordionPanel({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[#2A2B27]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between py-3 text-left"
      >
        <span className="text-xs font-semibold text-[#A7A79A]">{title}</span>
        <span className="text-[10px] text-[#5C5D58]">{open ? "▲" : "▼"}</span>
      </button>
      {open && <div className="pb-4">{children}</div>}
    </div>
  );
}

function AboutSection({ product }: { product: BitrefillProduct }) {
  return (
    <div className="mt-5">
      {product.descriptions && (
        <AccordionPanel title="About">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <div
            className="prose prose-sm max-w-none text-[#A7A79A] [&_a]:text-[#8FAE82] [&_strong]:text-[#F2F0E8] [&_li]:marker:text-[#5C5D58]"
            style={{ fontSize: 12, lineHeight: 1.6 }}
            dangerouslySetInnerHTML={{ __html: product.descriptions }}
          />
        </AccordionPanel>
      )}

      {product.instructions && (
        <AccordionPanel title="How to Redeem">
          <div
            className="prose prose-sm max-w-none text-[#A7A79A] [&_a]:text-[#8FAE82] [&_strong]:text-[#F2F0E8] [&_li]:marker:text-[#5C5D58]"
            style={{ fontSize: 12, lineHeight: 1.6 }}
            dangerouslySetInnerHTML={{ __html: product.instructions }}
          />
        </AccordionPanel>
      )}

      {(product.reviews?.length ?? 0) > 0 && (
        <AccordionPanel title={`Reviews${product.ratings ? ` · ★ ${product.ratings.rating_value.toFixed(1)}` : ""}`}>
          <div className="space-y-3">
            {product.reviews!.map((r, i) => (
              <div key={i} className="rounded-xl bg-white/[0.03] px-3 py-2.5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-[#F2F0E8]">{r.author_name}</span>
                  <span className="flex items-center gap-0.5 text-[10px] text-yellow-400">
                    {"★".repeat(Math.round(r.score))}
                    <span className="ml-1 text-[#5C5D58]">{r.date}</span>
                  </span>
                </div>
                <p className="text-xs text-[#A7A79A] leading-relaxed">{r.content}</p>
              </div>
            ))}
          </div>
        </AccordionPanel>
      )}

      {product.termsConditions && (
        <AccordionPanel title="Terms & Conditions">
          <p className="text-[11px] text-[#5C5D58] leading-relaxed">{product.termsConditions}</p>
        </AccordionPanel>
      )}
    </div>
  );
}

function CheckoutSheet({
  product: initialProduct,
  screenTab,
  countryCode,
  onClose,
  onPurchased,
}: {
  product: BitrefillProduct;
  screenTab: ScreenTab;
  countryCode: string;
  onClose: () => void;
  onPurchased: (invoiceId: string, code: string | null, paymentMethod: string) => void;
}) {
  const { wallets } = useWallets();
  const { wallets: solanaWallets } = useSolanaWallets();
  const { user, getAccessToken, sendTransaction } = usePrivy();
  // `sendTransaction(..., { sponsor: true })` triggers Privy's native gas
  // sponsorship (EIP-7702) on the user's existing embedded wallet — the
  // "Gas management" dashboard feature. Falls back to Layer 2 (user pays
  // native gas) and Layer 3 (ArcKit) if unavailable.

  // Prefill email from Privy — prefers dedicated email account, falls back to Google email
  const privyEmail = user?.email?.address ?? user?.google?.email ?? "";

  // Full product details (may be enriched by get-product-details call)
  const [product, setProduct] = useState<BitrefillProduct>(initialProduct);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const [selectedPkg, setSelectedPkg] = useState<BitrefillPackage | null>(
    initialProduct.packages?.[0] ?? null,
  );
  const [customValue, setCustomValue] = useState<number>(initialProduct.range?.min ?? 0);
  const [phoneNumber, setPhoneNumber] = useState(() => {
    try {
      return `+${getCountryCallingCode(countryCode as any)}`;
    } catch {
      return "+";
    }
  });
  const [recipientEmail, setRecipientEmail] = useState(privyEmail);

  // Derive product recipient requirement from recipient_type — authoritative source.
  // screenTab is only a fallback for products found via search on the wrong tab.
  const rt = product.recipient_type ?? "";
  const isTopup          = rt === "phone_number" || screenTab === "topup";
  const isEsim           = rt === "esim"         || screenTab === "esim";
  const isAccountType    = rt === "account";      // e.g. smartcard number, meter number, player ID
  const isUsernameType   = rt === "username";     // e.g. gaming username
  const isEmailRecipient = rt === "email";        // email as delivery target (≠ receipt email)
  const needsRefillInput = isTopup || isAccountType || isUsernameType || isEmailRecipient;

  // Label and placeholder for account/username/email-recipient fields
  const accountLabel = product.account_id_name?.trim() || (isUsernameType ? "Username" : isEmailRecipient ? "Delivery Email" : "Account ID");
  const accountPlaceholder = isEmailRecipient ? "delivery@example.com" : isUsernameType ? "your_username" : "e.g. 1234567890";

  // Refill input for account / username / email-recipient products
  const [refillInput, setRefillInput] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [paymentMethodId, setPaymentMethodId] = useState<string>("usdc_base");
  const [step, setStep]         = useState<CheckoutStep>(initialProduct.prepayment ? "prepay" : "email");
  const [pollStatus, setPollStatus] = useState<string>("unpaid");
  const [errMsg, setErrMsg]     = useState<string | null>(null);

  // Prepayment form state
  const [prepayFields, setPrepayFields]       = useState(initialProduct.prepayment?.first_form ?? []);
  const [prepayData, setPrepayData]           = useState<Record<string, string>>({});
  const [prepayStepNum, setPrepayStepNum]     = useState(1);
  const [prepayLoading, setPrepayLoading]     = useState(false);
  const [prepayError, setPrepayError]         = useState<string | null>(null);
  const [billPaymentId, setBillPaymentId]     = useState<string | null>(null);

  // About section expand/collapse
  const [aboutOpen, setAboutOpen]       = useState<"description" | "instructions" | "terms" | "reviews" | null>(null);
  const [invoice, setInvoice]   = useState<BitrefillInvoice | null>(null);
  const [invoiceAccessToken, setInvoiceAccessToken] = useState<string | null>(null);
  // Tracks seconds remaining until invoice expires for the live countdown.
  // Null means we haven't received a created_time yet.
  const [expirySecsLeft, setExpirySecsLeft] = useState<number | null>(null);
  const [paymentLink, setPaymentLink] = useState<string | null>(null);
  const [code, setCode]         = useState<string | null>(null);
  // For address-based methods (BTC, LTC, TON, etc.) — deposit address + amount returned by Bitrefill
  const [depositAddress, setDepositAddress]       = useState<string | null>(null);
  const [depositAmount, setDepositAmount]         = useState<string | null>(null);
  const [depositPaymentUri, setDepositPaymentUri] = useState<string | null>(null);
  const [depositCopied, setDepositCopied]         = useState(false);

  // Gift flow
  const [isGift, setIsGift]               = useState(false);
  const [giftRecipientName, setGiftRecipientName] = useState("");
  const [giftRecipientEmail, setGiftRecipientEmail] = useState("");
  const [giftMessage, setGiftMessage]     = useState("");
  const [giftTheme, setGiftTheme]         = useState<string>("red");

  const GIFT_THEMES = [
    { id: "red", label: "❤️ Classic" },
    { id: "green", label: "💚 Green" },
    { id: "yellow", label: "💛 Yellow" },
    { id: "birthday", label: "🎂 Birthday" },
    { id: "christmas", label: "🎄 Christmas" },
    { id: "bitcoin", label: "₿ Bitcoin" },
    { id: "chinese", label: "🧧 Lunar" },
    { id: "valentines", label: "💝 Valentine" },
  ];
  const [imgFailed, setImgFailed] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch full product details (get-product-details) on mount so package_value is accurate
  useEffect(() => {
    if (!initialProduct.id) return;
    setDetailsLoading(true);
    fetchWithRetry(`/api/bitrefill/products/${encodeURIComponent(initialProduct.id)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((detailed: BitrefillProduct | null) => {
        if (!detailed) return;
        setProduct(detailed);
        setSelectedPkg(detailed.packages?.[0] ?? null);
        setCustomValue(detailed.range?.min ?? 0);
        // If the product lists supported payment methods, auto-select the first
        // supported one that we have in our menu (prefer usdc_base if still valid)
        if (detailed.payment_methods) {
          const pm = detailed.payment_methods;
          const supported = new Set([
            ...(pm.address_based ?? []),
            ...(pm.link_only ?? []),
            ...(pm.balance ?? []),
          ]);
          setPaymentMethodId((cur) =>
            supported.has(cur) ? cur : (supported.values().next().value ?? cur)
          );
        }
        // Update prepayment form fields if the detailed response has them
        if (detailed.prepayment?.first_form) {
          setPrepayFields(detailed.prepayment.first_form);
        }
      })
      .catch(() => { /* keep using search result data */ })
      .finally(() => setDetailsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProduct.id]);

  // Use helper functions for package values
  const isFixed = hasFixedPackages(product);
  const displayAmount = isFixed ? pkgPriceUsd(selectedPkg ?? {} as BitrefillPackage) : customValue;

  // Format amount for display — use USD when price_usd is known, native currency otherwise
  const productCurrency = product.currency ?? "USD";
  const isUsdProduct = productCurrency === "USD";
  const formatAmount = (amount: number): string => {
    if (isFixed) {
      const usd = isFixed ? (selectedPkg?.price_usd ?? (selectedPkg as BitrefillPackage)?.priceInUsd) : undefined;
      if (usd != null) return `$${usd.toFixed(2)}`;
    }
    if (isUsdProduct) return `$${amount.toFixed(2)}`;
    return `${productCurrency} ${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)}`;
  };

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // Live countdown — fires whenever we receive a created_time from the invoice.
  // Bitrefill's MCP does not return expiration_minutes, so we derive the 15-min
  // window from created_time (the only timestamp the MCP exposes).
  useEffect(() => {
    const ct = invoice?.created_time;
    if (!ct) return;
    const origin = new Date(ct).getTime();
    const WINDOW = 15 * 60 * 1000; // 15-min Bitrefill payment window
    const tick = () => {
      const left = Math.max(0, Math.round((origin + WINDOW - Date.now()) / 1000));
      setExpirySecsLeft(left);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [invoice?.created_time]);

  const pollInvoice = useCallback(async (
    id: string,
    accessToken?: string | null,
    createdTime?: string | null,
    expirationMinutes?: number | null,
  ) => {
    const TERMINAL_ERROR = new Set(["failed", "expired", "cancelled", "refunded"]);
    const qs = accessToken ? `?token=${encodeURIComponent(accessToken)}` : "";

    // Derive the poll deadline from MCP data (Bitrefill exposes no explicit expiry field).
    // Priority:
    //   1. expiration_minutes from buy-products response (if ever present)
    //   2. created_time from get-invoice-by-id TOON + Bitrefill's standard 15-min window
    //   3. Conservative 15-min fallback from now
    const BITREFILL_WINDOW_MS = 15 * 60 * 1000;
    let deadlineMs: number;
    if (expirationMinutes) {
      deadlineMs = expirationMinutes * 60 * 1000;
    } else if (createdTime) {
      const origin = new Date(createdTime).getTime();
      const remaining = origin + BITREFILL_WINDOW_MS - Date.now();
      // Floor at 2 min so a half-expired invoice still gets a chance
      deadlineMs = Math.max(remaining, 2 * 60 * 1000);
    } else {
      deadlineMs = BITREFILL_WINDOW_MS;
    }

    const timeoutId = setTimeout(() => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setErrMsg("Invoice timed out. Please start a new purchase.");
      setStep("error");
    }, deadlineMs);

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/bitrefill/invoice/${id}${qs}`);
        const inv: BitrefillInvoice & { error?: string } = await res.json();

        if (!res.ok || inv.error) {
          console.warn("[pollInvoice] poll error:", inv.error ?? res.status, "| id:", id, "| hasToken:", !!accessToken);
          return; // keep polling — transient error or missing access token
        }

        // Track intermediate status for UI label
        if (inv.status) setPollStatus(inv.status);
        // Update invoice state with polled data so created_time drives the countdown
        if (inv.created_time) setInvoice((prev) => prev ? { ...prev, created_time: inv.created_time } : inv);

        // Some address-based methods (litecoin, dogecoin) return altcoinPrice a
        // beat after invoice creation — pick it up on the next poll if so. Others
        // (bitcoin, ton, usdt_ton, ark, solana) never return it at all under guest
        // checkout — confirmed against the live API — so depositPaymentLink (set
        // at invoice creation, see handleConfirm/handleQuickBuy) is the permanent
        // fallback for those, not something this poll loop can produce.
        const polledAmount = inv.payment_info?.altcoinPrice ?? inv.payment_info?.amount;
        if (polledAmount != null) {
          setDepositAmount((prev) => prev ?? String(polledAmount));
        }
        if (inv.payment_info?.paymentUri) {
          setDepositPaymentUri((prev) => prev ?? inv.payment_info!.paymentUri!);
        }

        // "complete" is the authoritative invoice_status; also accept delivery confirmation.
        // orders_delivery_status === "delivered" means all items were dispatched even if
        // invoice_status hasn't updated yet (race on Bitrefill's side).
        const isComplete =
          inv.status === "complete" ||
          inv.orders_delivery_status === "delivered" ||
          inv.orders?.every((o) => o.redemption_info?.redemption_available);

        if (isComplete) {
          clearTimeout(timeoutId);
          clearInterval(pollRef.current!);
          // Route attaches code as a top-level convenience field
          const redemptionCode = inv.code ?? null;
          setCode(redemptionCode);
          setStep("done");
          onPurchased(id, redemptionCode, paymentMethodId);
        } else if (TERMINAL_ERROR.has(inv.status)) {
          clearTimeout(timeoutId);
          clearInterval(pollRef.current!);
          setErrMsg(`Payment ${inv.status}. Please try again.`);
          setStep("error");
        }
        // payment_detected | payment_confirmed | pending → keep polling, update label
      } catch { /* keep polling on transient errors */ }
    }, 10000);
  }, [onPurchased]);

  const handlePrepaySubmit = useCallback(async () => {
    setPrepayLoading(true);
    setPrepayError(null);
    try {
      const res = await authFetch("/api/bitrefill/prepayment-step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id:  product.id,
          step_number: prepayStepNum,
          form_data:   prepayData,
        }),
      }, getAccessToken);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Prepayment step failed");

      if (data.step === "final" && data.bill_payment_id) {
        setBillPaymentId(data.bill_payment_id);
        setStep("email");
      } else if (data.next_form) {
        // More form steps to complete
        setPrepayFields(data.next_form);
        setPrepayData({});
        setPrepayStepNum((n) => n + 1);
      } else {
        // No MCP configured — fall through to email (CLI path will use payment link)
        setStep("email");
      }
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? "Prepayment failed";
      if (msg.includes("MCP")) {
        // CLI path: skip prepayment form — Bitrefill will handle it on their site via payment link
        setStep("email");
      } else {
        setPrepayError(msg);
      }
    } finally {
      setPrepayLoading(false);
    }
  }, [product.id, prepayData, prepayStepNum, getAccessToken]);

  const handleEmailNext = useCallback(() => {
    // Validate phone number for top-ups
    if (isTopup) {
      const raw = phoneNumber.trim();
      if (!raw) { setEmailError("Please enter a phone number."); return; }
      try {
        if (!isValidPhoneNumber(raw, countryCode as any)) {
          setEmailError("Not a valid phone number for the selected country.");
          return;
        }
      } catch {
        setEmailError("Please enter a valid phone number.");
        return;
      }
    }
    // Validate account ID / username / delivery email
    if (isAccountType || isUsernameType) {
      if (!refillInput.trim()) {
        setEmailError(`Please enter your ${accountLabel}.`);
        return;
      }
      // Validate against regex if Bitrefill provides one
      if (product.account_id_regex) {
        try {
          if (!new RegExp(product.account_id_regex).test(refillInput.trim())) {
            setEmailError(`Invalid ${accountLabel} format.`);
            return;
          }
        } catch { /* ignore bad regex */ }
      }
    }
    if (isEmailRecipient) {
      if (!refillInput.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(refillInput.trim())) {
        setEmailError("Please enter a valid delivery email address.");
        return;
      }
    }
    const email = recipientEmail.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError("Please enter a valid email address.");
      return;
    }
    // Validate gift fields if gift mode is on
    if (isGift) {
      if (!giftRecipientName.trim()) { setEmailError("Please enter the recipient's name."); return; }
      if (!giftRecipientEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(giftRecipientEmail.trim())) {
        setEmailError("Please enter a valid recipient email for the gift.");
        return;
      }
    }
    setEmailError(null);
    setStep("pick");
  }, [recipientEmail, isTopup, phoneNumber, countryCode, isAccountType, isUsernameType, isEmailRecipient, refillInput, accountLabel, product.account_id_regex, isGift, giftRecipientName, giftRecipientEmail]);

  const handleConfirm = useCallback(async () => {
    // Normalise phone to E.164 before sending to Bitrefill
    let e164Phone = phoneNumber.trim();
    if (isTopup) {
      try {
        const parsed = parsePhoneNumberWithError(phoneNumber.trim(), countryCode as any);
        e164Phone = parsed.format("E.164"); // e.g. "+2348012345678"
      } catch {
        setErrMsg("Invalid phone number. Please go back and correct it.");
        return;
      }
    }
    setStep("paying");
    setErrMsg(null);
    try {
      const paymentMethod = paymentMethodId;
      const invRes = await authFetch("/api/bitrefill/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId:      product.id,
          // MCP uses package_value (e.g. "50"), not full package_id
          packageId:      selectedPkg ? pkgDisplayValue(selectedPkg) : undefined,
          customValue:    !isFixed ? customValue : undefined,
          paymentMethod,
          recipientEmail: recipientEmail.trim(),
          sendTo:         isTopup ? e164Phone
                        : (isAccountType || isUsernameType || isEmailRecipient) ? refillInput.trim()
                        : undefined,
          ...(billPaymentId ? { billPaymentId } : {}),
          ...(isGift ? {
            gift: {
              recipient_name:  giftRecipientName.trim(),
              recipient_email: giftRecipientEmail.trim(),
              sender_name:     "Bluvfi",
              message:         giftMessage.trim() || undefined,
              theme:           giftTheme,
            },
          } : {}),
        }),
      }, getAccessToken);
      if (!invRes.ok) {
        const err = await invRes.json().catch(() => ({ error: "Order creation failed" }));
        throw new Error(err.error ?? "Order creation failed");
      }
      const inv: BitrefillInvoice = await invRes.json();
      setInvoice(inv);
      const token = inv.invoice_access_token ?? null;
      setInvoiceAccessToken(token);
      if (inv.payment_link) setPaymentLink(inv.payment_link);

      const pm = getPaymentMethod(paymentMethod);
      const invoiceId = inv.invoice_id ?? inv.id ?? "";
      const invCreatedTime = inv.created_time ?? null;
      const invExpirationMinutes = inv.expiration_minutes ?? null;

      // MCP returns payment_info; compat shim also checks legacy payment field
      const paymentAddress = inv.payment_info?.address ?? inv.payment?.address;
      // altcoinPrice is the human-readable coin amount (e.g. "0.08" USDC, "0.00000128" BTC)
      // amount is a numeric fallback; also check the legacy payment.price field
      const paymentAmount  =
        inv.payment_info?.altcoinPrice ??
        inv.payment_info?.amount       ??
        inv.payment?.price;

      // Address-based methods (BTC, LTC, TON, DOGE, DASH, ARK, ETH native, USDT-Tron, etc.)
      // → show the deposit address to the user; poll for payment arrival
      if (pm.chain === "address") {
        if (!paymentAddress) throw new Error("No deposit address returned for this payment method");
        setDepositAddress(paymentAddress);
        setDepositAmount(paymentAmount != null ? String(paymentAmount) : null);
        setDepositPaymentUri(inv.payment_info?.paymentUri ?? null);
        setStep("address");
        pollInvoice(invoiceId, token, invCreatedTime, invExpirationMinutes);
        return;
      }

      // Truly link-only (fiat) OR fallback when no address returned
      if (pm.chain === "link" || !paymentAddress || !paymentAmount) {
        if (inv.payment_link) {
          window.open(inv.payment_link, "_blank", "noopener,noreferrer");
          setStep("polling");
          pollInvoice(invoiceId, token, invCreatedTime, invExpirationMinutes);
          return;
        }
        throw new Error("No payment link or address returned for this payment method");
      }

      if (pm.chain === "solana") {
        // Direct SPL token transfer — mirrors the EVM USDT direct-viem path.
        // Uses @solana/spl-token to find ATAs, run a pre-flight balance check,
        // and build the instruction. The Privy Solana wallet signs the tx bytes.
        const solWallet = solanaWallets[0];
        if (!solWallet) throw new Error("No Solana wallet connected");

        const { PublicKey, Transaction, Connection } = await import("@solana/web3.js");
        const { getAssociatedTokenAddress, createTransferInstruction, getAccount, TOKEN_PROGRAM_ID } =
          await import("@solana/spl-token");

        const solRpc = `https://solana-mainnet.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_API_KEY}`;
        const connection = new Connection(solRpc, "confirmed");

        // Resolve SPL mint — USDC or USDT on Solana mainnet
        const SOLANA_MINTS: Record<string, string> = {
          USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        };
        const mint           = new PublicKey(SOLANA_MINTS[pm.token] ?? SOLANA_MINTS.USDC);
        const senderPubkey   = new PublicKey(solWallet.address);
        const receiverPubkey = new PublicKey(paymentAddress);

        // Pre-flight: verify the sender has an ATA with sufficient balance
        const senderAta     = await getAssociatedTokenAddress(mint, senderPubkey);
        const senderAccount = await getAccount(connection, senderAta).catch(() => null);
        if (!senderAccount) {
          throw new Error(`Insufficient ${pm.token} balance on Solana. Please add funds and try again.`);
        }
        const requiredMicro = BigInt(Math.round(Number(paymentAmount) * 1_000_000));
        if (senderAccount.amount < requiredMicro) {
          const bal = (Number(senderAccount.amount) / 1_000_000).toFixed(2);
          throw new Error(
            `Insufficient ${pm.token} on Solana. You have $${bal} but need $${Number(paymentAmount).toFixed(2)}.`
          );
        }

        // Receiver ATA (Bitrefill maintains their token accounts — no creation needed)
        const receiverAta = await getAssociatedTokenAddress(mint, receiverPubkey);

        // Build, sign, and send
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: senderPubkey }).add(
          createTransferInstruction(senderAta, receiverAta, senderPubkey, requiredMicro, [], TOKEN_PROGRAM_ID),
        );
        const txBytes = Buffer.from(tx.serialize({ requireAllSignatures: false }));
        const { signedTransaction } = await solWallet.signTransaction({ transaction: txBytes });
        const txSig = await connection.sendRawTransaction(Transaction.from(signedTransaction).serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });
        await connection.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");
      } else {
        // ── EVM payment ───────────────────────────────────────────────────────
        //
        // Layer 1 — Privy native gas sponsorship (EIP-7702, `sponsor: true`).
        //   Configured in the dashboard under Wallet infrastructure → Gas
        //   management; sponsors gas on the existing embedded wallet directly
        //   (no separate ERC-4337 contract account, no user.smartWallet needed).
        //
        // Layer 2 — Privy EOA, user pays native gas (ETH/MATIC/etc.) directly.
        //
        // Layer 3 — ArcKit EOA fallback (all EVM except BSC). Circle sponsors
        //   gas here too, so the user still pays nothing extra.
        //   BSC is absent from ArcKit — its fallback is a manual deposit address.
        //
        // Note: USDT contracts (Ethereum/Polygon/Arbitrum) use a non-standard
        //   transfer() with no bool return — we use a stripped ABI for calldata.

        // Turn a raw error into a short, human-readable one-liner for console
        // logs. Some errors are already clean (e.g. ArcKit's own pre-flight
        // check: "Insufficient token balance on Arbitrum"); others are a
        // multi-hundred-character RPC/simulation dump (USDT on Ethereum reverts
        // with a bare "invalid opcode" instead of a message when the balance is
        // too low). Detect the known-noisy cases and say the real reason instead
        // — the raw error is still passed as a separate console.error argument
        // for anyone who needs the full trace.
        const summarizeError = (err: unknown, pmId: string): string => {
          const raw = (err as Error)?.message ?? String(err);
          const m = raw.toLowerCase();
          const network = pmId.includes("erc20") ? "Ethereum"
            : pmId.includes("polygon") ? "Polygon"
            : pmId.includes("arbitrum") ? "Arbitrum"
            : pmId.includes("optimism") ? "Optimism"
            : pmId.includes("base") ? "Base"
            : "this network";
          if (m.includes("balance_insufficient") || m.includes("insufficient token balance")) {
            return raw.split("\n")[0]; // already clean, e.g. "Insufficient token balance on Arbitrum"
          }
          if (m.includes("invalid opcode") || m.includes("invalidfeopcode") || m.includes("fe opcode")) {
            const token = pmId.includes("usdt") ? "USDT" : pmId.includes("usdc") ? "USDC" : "the token";
            return `Insufficient ${token} balance on ${network} (contract reverted without a reason string)`;
          }
          if (m.includes("insufficient funds for gas") || m.includes("gas required exceeds allowance")) {
            return `Insufficient native gas balance on ${network}`;
          }
          // Otherwise: RPC/simulation dumps are one giant multi-line string —
          // the first line is almost always the actual message.
          return raw.split("\n")[0];
        };

        // Contract addresses for every payment method supported by Privy Gas Management.
        // Source: https://dashboard.privy.io → Wallet infrastructure → Gas management
        const SMART_WALLET_TOKENS: Record<string, { contract: `0x${string}`; chainId: number }> = {
          // Base — USDC, USDT
          usdc_base:     { contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chainId: 8453  },
          usdt_base:     { contract: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", chainId: 8453  },
          // Ethereum — USDC, USDT
          usdc_erc20:    { contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1     },
          usdt_erc20:    { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", chainId: 1     },
          // Polygon — USDC, USDT
          usdc_polygon:  { contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", chainId: 137   },
          usdt_polygon:  { contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", chainId: 137   },
          // Arbitrum — USDC, USDT
          usdc_arbitrum: { contract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", chainId: 42161 },
          usdt_arbitrum: { contract: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", chainId: 42161 },
          // Optimism — USDC, USDT
          usdc_optimism: { contract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", chainId: 10    },
          usdt_optimism: { contract: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", chainId: 10    },
          // BSC is intentionally absent — Privy's paymaster has no BSC support;
          // usdt_bsc goes straight to manual deposit address (no smart wallet attempt).
        };

        const swConfig = SMART_WALLET_TOKENS[paymentMethodId];
        let smartWalletSucceeded = false;

        // Layer 1 uses Privy's *native* gas sponsorship (EIP-7702, `sponsor: true`
        // on the embedded wallet's own sendTransaction) — configured in the
        // dashboard under Wallet infrastructure → Gas management. This is a
        // different feature from ERC-4337 smart *contract* wallets
        // (@privy-io/react-auth/smart-wallets, user.smartWallet): native
        // sponsorship upgrades the existing embedded EOA in place instead of
        // creating a separate 4337 contract account, so no `user.smartWallet` is
        // ever created or needed for this path.
        if (swConfig) {
          try {
            const { encodeFunctionData, erc20Abi, parseAbi, parseUnits } = await import("viem");
            // USDT contracts (Ethereum, Polygon, Arbitrum) use a non-standard transfer()
            // with no bool return value — use a stripped ABI for all USDT tokens.
            const isUsdt = paymentMethodId.includes("usdt");
            const transferAbi = isUsdt
              ? parseAbi(["function transfer(address to, uint256 amount)"])
              : erc20Abi;
            const calldata = encodeFunctionData({
              abi: transferAbi,
              functionName: "transfer",
              args: [paymentAddress as `0x${string}`, parseUnits(String(paymentAmount), 6)],
            });
            await sendTransaction(
              {
                to: swConfig.contract,
                data: calldata,
                chainId: swConfig.chainId,
              },
              { sponsor: true },
            );
            smartWalletSucceeded = true;
          } catch (swErr: unknown) {
            // Paymaster/asset unavailable, insufficient stablecoin for fee, or user
            // rejected — fall through to Privy EOA (Layer 2, user pays native gas).
            console.error(`[bills] Layer 1 ❌ Native gas sponsorship failed (${paymentMethodId}):`, summarizeError(swErr, paymentMethodId), swErr);
          }
        }

        if (!smartWalletSucceeded) {
          // BSC: no smart wallet, no EOA, no ArcKit — show manual deposit address.
          if (paymentMethodId === "usdt_bsc") {
            if (!paymentAddress) throw new Error("No deposit address returned for BSC USDT");
            setDepositAddress(paymentAddress);
            setDepositAmount(paymentAmount != null ? String(paymentAmount) : null);
            setDepositPaymentUri(inv.payment_info?.paymentUri ?? null);
            setStep("address");
            pollInvoice(invoiceId, token, invCreatedTime, invExpirationMinutes);
            return;
          }

          // ── Layer 2: Privy EOA — direct ERC-20 transfer, user pays native gas ──
          // The embedded Privy wallet signs the tx; the user needs ETH/MATIC/etc.
          // for gas. No paymaster involved — plain EOA → contract call.
          let eoaSucceeded = false;
          if (swConfig) {
            try {
              const {
                createWalletClient, createPublicClient, custom, http,
                encodeFunctionData, erc20Abi, parseAbi, parseUnits,
              } = await import("viem");
              const { base, mainnet, polygon, arbitrum, optimism } = await import("viem/chains");
              const VIEM_CHAINS_EOA: Record<number, Chain> = {
                1:     mainnet,
                8453:  base,
                137:   polygon,
                42161: arbitrum,
                10:    optimism,
              };
              const viemChain = VIEM_CHAINS_EOA[swConfig.chainId];
              const privyEoa = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
              if (!privyEoa) throw new Error("No EVM wallet connected");
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const eoaProvider = await privyEoa.getEthereumProvider();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const walletClient = createWalletClient({ chain: viemChain, transport: custom(eoaProvider as any) });
              const [eoaAccount] = await walletClient.getAddresses();

              // Privy's embedded wallet fires its own gas-estimate preview for the
              // confirm-tx UI as an *unhandled* promise (outside our await chain) —
              // if the account has no native gas token that preview throws an
              // uncaught rejection our try/catch never sees. Check the balance
              // ourselves first so we throw (and catch) a clean error instead.
              // viem's default RPC per chain isn't on the app's CSP allowlist, so
              // point explicitly at an Alchemy endpoint (already whitelisted, same
              // one wagmi.ts uses) — this avoids "Refused to connect" CSP errors.
              const ALCHEMY_SUBDOMAIN: Record<number, string> = {
                1: "eth-mainnet", 8453: "base-mainnet", 137: "polygon-mainnet",
                42161: "arb-mainnet", 10: "opt-mainnet",
              };
              const alchemyKey = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
              const rpcUrl = alchemyKey
                ? `https://${ALCHEMY_SUBDOMAIN[swConfig.chainId]}.g.alchemy.com/v2/${alchemyKey}`
                : undefined;
              const publicClient = createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
              const nativeBalance = await publicClient.getBalance({ address: eoaAccount });
              if (nativeBalance === 0n) {
                throw new Error(`No ${viemChain.nativeCurrency.symbol} balance on ${viemChain.name} to pay gas`);
              }

              const isUsdtEoa = paymentMethodId.includes("usdt");
              const eoaAbi = isUsdtEoa
                ? parseAbi(["function transfer(address to, uint256 amount)"])
                : erc20Abi;
              const eoaCalldata = encodeFunctionData({
                abi: eoaAbi,
                functionName: "transfer",
                args: [paymentAddress as `0x${string}`, parseUnits(String(paymentAmount), 6)],
              });
              // The Privy EOA may be on a different chain (e.g. Base when we need
              // Ethereum). Switch it to the target chain before sending.
              await walletClient.switchChain({ id: viemChain.id });
              await walletClient.sendTransaction({
                account: eoaAccount,
                to: swConfig.contract,
                data: eoaCalldata,
                chain: viemChain,
              });
              eoaSucceeded = true;
            } catch (eoaErr: unknown) {
              // Native gas unavailable or user rejected — fall through to ArcKit (Layer 3).
              console.error(`[bills] Layer 2 ❌ Privy EOA failed (${paymentMethodId}):`, summarizeError(eoaErr, paymentMethodId), eoaErr);
            }
          }

          // ── Layer 3: ArcKit EOA fallback — Circle handles gas; Privy EOA signs ──
          if (!eoaSucceeded) {
            const privyWallet = wallets.find((w) => w.walletClientType === "privy") ?? wallets[0];
            if (!privyWallet) throw new Error("No EVM wallet connected");
            const provider = await privyWallet.getEthereumProvider();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const adapter = await createViemAdapterFromProvider({ provider: provider as any });
            // ArcKit v1.10.0 has usdtAddress: null for Polygon, Arbitrum, Optimism, and
            // Base — it only recognises the "USDT" alias on Ethereum. Passing the raw
            // contract address (TokenAddress) bypasses alias validation and lets ArcKit
            // treat it as a generic ERC-20 token (it fetches decimals from the chain).
            const arcKitToken: string =
              pm.token === "USDT" && paymentMethodId !== "usdt_erc20" && swConfig?.contract
                ? swConfig.contract  // raw contract address for non-Ethereum USDT
                : pm.token;          // "USDC" alias (always works) or "USDT" on Ethereum
            let arcKitResult: unknown;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              arcKitResult = await arcKit.send({
                from: { adapter, chain: getEvmChain(paymentMethodId) },
                to: paymentAddress,
                amount: String(paymentAmount),
                token: arcKitToken as any,
              });
            } catch (arcErr: unknown) {
              console.error(`[bills] Layer 3 ❌ ArcKit failed (${paymentMethodId}):`, summarizeError(arcErr, paymentMethodId), arcErr);
              throw arcErr;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((arcKitResult as any)?.state && (arcKitResult as any).state !== "success") {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              console.error(`[bills] Layer 3 ❌ ArcKit returned non-success state (${paymentMethodId}):`, (arcKitResult as any).state);
              throw new Error("Transfer did not complete");
            }
          }
        }
      }

      setStep("polling");
      pollInvoice(invoiceId, token, invCreatedTime, invExpirationMinutes);
    } catch (err: unknown) {
      const rawMsg = (err as Error)?.message ?? "Purchase failed. Please try again.";
      const m = rawMsg.toLowerCase();

      const friendly = (() => {
        if (m.includes("reject") || m.includes("cancel") || m.includes("denied"))
          return "Payment cancelled.";
        // Privy paymaster rejecting a token/chain combination — can happen transiently.
        if (m.includes("not supported on") || m.includes("is not supported"))
          return "This payment method is temporarily unavailable. Please try again or use a different network.";
        // ArcKit validates the token contract (fetches decimals) before sending.
        // If the public chain RPC it contacts is down or rate-limited, this throws.
        if (
          m.includes("validation failed for 'tokenaddress'") ||
          m.includes("failed to fetch decimals") ||
          (m.includes("http request failed") && (m.includes("arbitrum") || m.includes("polygon") || m.includes("optimism") || m.includes("ethereum")))
        ) {
          const network = paymentMethodId.includes("arbitrum") ? "Arbitrum"
            : paymentMethodId.includes("polygon") ? "Polygon"
            : paymentMethodId.includes("optimism") ? "Optimism"
            : paymentMethodId.includes("erc20") ? "Ethereum"
            : "this network";
          return `Network RPC error on ${network}. Please wait a moment and try again.`;
        }

        // Bitrefill server error — MCP transport wraps HTTP 5xx responses as
        // "Streamable HTTP error: Error POSTing to endpoint: <!doctype html>..."
        // (Cloudflare 502/503/504 pages, or Bitrefill's own 500 page).
        if (
          m.includes("streamable http error") ||
          m.includes("bad gateway") ||
          m.includes("<!doctype html") ||
          (m.includes("error posting to endpoint") && (m.includes("502") || m.includes("503") || m.includes("504") || m.includes("500")))
        ) return "Bitrefill is temporarily unavailable. Please try again in a few minutes.";
        // Bitrefill API rate limit — MCP transport wraps it as
        // "Streamable HTTP error: Error POSTing to endpoint: {status: rate_limit_reached}"
        if (m.includes("rate_limit") || m.includes("rate limit") || m.includes("request quota") || m.includes("quota"))
          return "Bitrefill rate limit reached. Please wait a moment and try again.";
        // USDT on Ethereum uses assert() for balance checks, producing the opaque
        // InvalidFEOpcode / "invalid opcode: INVALID" revert instead of a clear message.
        if (
          m.includes("invalidfeopcode") ||
          m.includes("invalid opcode") ||
          m.includes("fe opcode") ||
          (m.includes("simulation failed") && m.includes("ethereum"))
        ) {
          const token = paymentMethodId.includes("usdt") ? "USDT" : paymentMethodId.includes("usdc") ? "USDC" : "token";
          const network = paymentMethodId.includes("erc20") ? "Ethereum"
            : paymentMethodId.includes("polygon") ? "Polygon"
            : paymentMethodId.includes("arbitrum") ? "Arbitrum"
            : paymentMethodId.includes("optimism") ? "Optimism"
            : paymentMethodId.includes("base") ? "Base"
            : "this network";
          return `Insufficient ${token} balance on ${network}. Please add funds and try again.`;
        }
        // eth_estimateGas rejection when wallet has no native gas token (POL, ETH, etc.)
        if (
          m.includes("estimategas") ||
          m.includes("insufficient funds for gas") ||
          m.includes("insufficient funds for transfer") ||
          (m.includes("total cost") && m.includes("gas"))
        ) {
          const gasToken = paymentMethodId.includes("polygon") ? "POL"
            : paymentMethodId.includes("solana") ? "SOL"
            : "ETH";
          const network = paymentMethodId.includes("polygon") ? "Polygon"
            : paymentMethodId.includes("arbitrum") ? "Arbitrum"
            : paymentMethodId.includes("optimism") ? "Optimism"
            : paymentMethodId.includes("erc20") ? "Ethereum"
            : "this network";
          const stableToken = paymentMethodId.includes("usdt") ? "USDT" : "USDC";
          return `You need ${gasToken} for gas fees and ${stableToken} to send on ${network}. Please add both to your wallet and try again.`;
        }
        // Pass through pre-flight Solana SPL errors — they're already user-friendly
        // (e.g. "Insufficient USDC on Solana. You have $0.50 but need $1.00.")
        if ((m.includes("insufficient") || m.includes("not enough")) && m.includes("solana"))
          return rawMsg;
        if (m.includes("insufficient") || m.includes("not enough"))
          return "Insufficient balance. Please add funds and try again.";
        // Chain mismatch — wallet is on a different network than the payment requires.
        if (m.includes("does not match") && m.includes("chain")) {
          const network = paymentMethodId.includes("polygon") ? "Polygon"
            : paymentMethodId.includes("arbitrum") ? "Arbitrum"
            : paymentMethodId.includes("optimism") ? "Optimism"
            : paymentMethodId.includes("erc20") ? "Ethereum"
            : "the correct network";
          return `Please switch your wallet to ${network} and try again.`;
        }
        // ArcKit / Circle returns INTERNAL_ERROR for Solana payments when the wallet
        // has insufficient token balance (no on-chain funds to cover the transfer).
        // "Sender token account not found" means the wallet has never received USDC/USDT
        // on Solana — the associated token account (ATA) doesn't exist yet, which only
        // happens when the balance is zero.
        if (
          m.includes("internal_error") ||
          m.includes("failed to process purchase") ||
          m.includes("token account not found") ||
          m.includes("sender token account")
        ) {
          const token = paymentMethodId.includes("usdt") ? "USDT" : "USDC";
          const network = paymentMethodId.includes("solana") ? "Solana" : "this network";
          return `Insufficient ${token} balance on ${network}. Please add funds and try again.`;
        }
        return rawMsg;
      })();

      setErrMsg(friendly);
      setStep("error");
    }
  }, [isTopup, phoneNumber, countryCode, isAccountType, isUsernameType, isEmailRecipient, refillInput, paymentMethodId, product, selectedPkg, customValue, isFixed, recipientEmail, billPaymentId, wallets, sendTransaction, pollInvoice, isGift, giftRecipientName, giftRecipientEmail, giftMessage, giftTheme, getAccessToken]);

  const typeLabel = isEsim ? "Data Plan" : isTopup ? "Phone Top-Up" : "Digital Card";

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-t-3xl bg-[#1B1C19] p-6 pb-10 border-t border-[#2A2B27]">

        {/* Header */}
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] overflow-hidden">
            {logoUrl(product) && !imgFailed ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl(product)!} alt={product.name}
                className="h-full w-full object-contain p-1"
                onError={() => setImgFailed(true)} />
            ) : (
              <span className="text-xl">{productEmoji(product.name, screenTab)}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold text-[#F2F0E8] leading-tight">{product.name}</h3>
            {product.subtitles && (
              <p className="text-xs text-[#A7A79A] mt-0.5 truncate">{product.subtitles}</p>
            )}
            <div className="flex items-center gap-2 flex-wrap mt-1">
              {detailsLoading ? (
                <div className="h-3 w-16 animate-pulse rounded bg-white/[0.06]" />
              ) : priceRange(product) ? (
                <span className="rounded-full bg-[#8FAE82]/15 px-2 py-0.5 text-xs font-semibold text-[#8FAE82]">
                  {priceRange(product)}
                </span>
              ) : null}
              {product.ratings && (
                <span className="flex items-center gap-1 text-xs text-[#A7A79A]">
                  <span className="text-yellow-400">★</span>
                  <span>{product.ratings.rating_value.toFixed(1)}</span>
                  <span className="text-[#5C5D58]">({product.ratings.rating_count})</span>
                </span>
              )}
            </div>
          </div>
          {/* Back button — shown on reversible steps */}
          {(step === "prepay" || step === "email" || step === "pick" || step === "error" || step === "address") && (
            <button
              onClick={() => {
                if (step === "prepay") onClose();
                else if (step === "email") onClose();
                else if (step === "pick") setStep("email");
                else if (step === "error") setStep("pick");
                else if (step === "address") { setStep("pick"); setDepositAddress(null); setDepositAmount(null); setDepositPaymentUri(null); if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }
              }}
              className="rounded-full p-1.5 text-[#A7A79A] hover:bg-white/[0.06]"
              aria-label="Back"
            >
              ←
            </button>
          )}
          {/* Close button — always visible but disabled during irreversible steps */}
          <button
            onClick={onClose}
            disabled={step === "paying" || step === "polling"}
            className="rounded-full p-1.5 text-[#A7A79A] hover:bg-white/[0.06] disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {/* ── Step 0: Prepayment form (bill-payment products) ── */}
        {step === "prepay" && (
          <>
            <p className="mb-1 text-sm font-semibold text-[#F2F0E8]">Bill Payment Details</p>
            <p className="mb-4 text-xs text-[#A7A79A]">
              This product requires additional information before checkout.
            </p>
            <div className="space-y-3 mb-4">
              {prepayFields.map((field) => (
                <div key={field.id}>
                  <p className="mb-1.5 text-xs font-medium text-[#A7A79A]">
                    {field.label}
                    {field.required && <span className="ml-0.5 text-red-400">*</span>}
                  </p>
                  {field.type === "select" && field.options ? (
                    <select
                      value={prepayData[field.id] ?? ""}
                      onChange={(e) => setPrepayData((d) => ({ ...d, [field.id]: e.target.value }))}
                      className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] focus:border-[#8FAE82] focus:outline-none"
                    >
                      <option value="">Select…</option>
                      {field.options.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.type === "number" ? "number" : "text"}
                      value={prepayData[field.id] ?? ""}
                      onChange={(e) => setPrepayData((d) => ({ ...d, [field.id]: e.target.value }))}
                      maxLength={field.max_length ?? undefined}
                      className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
                    />
                  )}
                </div>
              ))}
            </div>
            {prepayError && (
              <p className="mb-3 rounded-xl bg-red-900/20 px-4 py-2.5 text-sm text-red-400">{prepayError}</p>
            )}
            <button
              onClick={handlePrepaySubmit}
              disabled={prepayLoading || prepayFields.filter(f => f.required).some(f => !prepayData[f.id]?.trim())}
              className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-60"
            >
              {prepayLoading ? "Submitting…" : "Continue"}
            </button>
          </>
        )}

        {/* ── Step 1: Email (+ phone for top-ups) collection ── */}
        {step === "email" && (
          <>
            {isTopup ? (
              <>
                <p className="mb-1 text-sm font-semibold text-[#F2F0E8]">Top-up details</p>
                <p className="mb-4 text-xs text-[#A7A79A]">
                  Enter the mobile number to receive the credit and your email for the order receipt.
                </p>
                <div className="mb-4">
                  <p className="mb-2 text-xs font-medium text-[#A7A79A]">Phone Number <span className="text-red-400">*</span></p>
                  <input
                    type="tel"
                    autoFocus
                    placeholder={countryCode === "NG" ? "0801 234 5678" : countryCode === "AE" ? "050 123 4567" : countryCode === "GH" ? "024 123 4567" : countryCode === "KE" ? "0712 345 678" : countryCode === "ZA" ? "071 234 5678" : "Phone number"}
                    value={phoneNumber}
                    onChange={(e) => {
                      // Format as user types using AsYouType for the selected country
                      const raw = e.target.value;
                      try {
                        const formatted = new AsYouType(countryCode as any).input(raw);
                        setPhoneNumber(formatted);
                      } catch {
                        setPhoneNumber(raw);
                      }
                      setEmailError(null);
                    }}
                    className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
                  />
                  <p className="mt-1.5 text-xs text-[#A7A79A]">
                    ⚠️ Must be a <span className="font-medium text-[#F2F0E8]">{product.name}</span> number
                  </p>
                </div>
              </>
            ) : isAccountType || isUsernameType || isEmailRecipient ? (
              <>
                <p className="mb-1 text-sm font-semibold text-[#F2F0E8]">{accountLabel} required</p>
                <p className="mb-4 text-xs text-[#A7A79A]">
                  {isEmailRecipient
                    ? "Enter the email address where the product should be delivered."
                    : `Enter your ${accountLabel.toLowerCase()} so the top-up is applied to the right account.`}
                </p>
                <div className="mb-4">
                  <p className="mb-2 text-xs font-medium text-[#A7A79A]">{accountLabel} <span className="text-red-400">*</span></p>
                  <input
                    type={isEmailRecipient ? "email" : "text"}
                    autoFocus
                    placeholder={accountPlaceholder}
                    value={refillInput}
                    onChange={(e) => { setRefillInput(e.target.value); setEmailError(null); }}
                    onKeyDown={(e) => e.key === "Enter" && handleEmailNext()}
                    className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
                  />
                </div>
              </>
            ) : (
              <>
                <p className="mb-1 text-sm font-semibold text-[#F2F0E8]">Where should we send your code?</p>
                <p className="mb-4 text-xs text-[#A7A79A]">
                  Your {typeLabel.toLowerCase()} details will be emailed to you so you can always retrieve them — even if you close this chat.
                </p>
              </>
            )}
            <div className="mb-4">
              <p className="mb-2 text-xs font-medium text-[#A7A79A]">
                {isTopup ? "Email (receipt)" : needsRefillInput ? "Email (receipt)" : "Email Address"}
              </p>
              <input
                type="email"
                autoFocus={!needsRefillInput}
                placeholder="you@example.com"
                value={recipientEmail}
                onChange={(e) => { setRecipientEmail(e.target.value); setEmailError(null); }}
                onKeyDown={(e) => e.key === "Enter" && handleEmailNext()}
                className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
              />
              {emailError && (
                <p className="mt-1.5 text-xs text-red-400">{emailError}</p>
              )}
            </div>
            {/* ── Gift toggle — available for all product types, matching Bitrefill's website ── */}
            <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setIsGift((g) => !g)}
                  className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm transition-colors
                    ${isGift ? "border-[#8FAE82]/50 bg-[#8FAE82]/10" : "border-[#2A2B27] hover:border-[#8FAE82]/30"}`}
                >
                  <span className="flex items-center gap-2 font-medium text-[#F2F0E8]">
                    🎁 Send as a Gift
                  </span>
                  <span className={`h-5 w-9 rounded-full transition-colors ${isGift ? "bg-[#8FAE82]" : "bg-[#2A2B27]"} relative flex items-center`}>
                    <span className={`absolute h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${isGift ? "translate-x-[18px]" : "translate-x-[3px]"}`} />
                  </span>
                </button>

                {isGift && (
                  <div className="mt-3 space-y-3 rounded-2xl border border-[#2A2B27] bg-[#141513] p-4">
                    <p className="text-xs text-[#A7A79A]">Bitrefill will email the gift card directly to the recipient.</p>
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-[#A7A79A]">Recipient Name <span className="text-red-400">*</span></p>
                      <input
                        type="text"
                        placeholder="e.g. Jane Doe"
                        value={giftRecipientName}
                        onChange={(e) => { setGiftRecipientName(e.target.value); setEmailError(null); }}
                        className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
                      />
                    </div>
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-[#A7A79A]">Recipient Email <span className="text-red-400">*</span></p>
                      <input
                        type="email"
                        placeholder="recipient@example.com"
                        value={giftRecipientEmail}
                        onChange={(e) => { setGiftRecipientEmail(e.target.value); setEmailError(null); }}
                        className="w-full rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
                      />
                    </div>
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-[#A7A79A]">Personal Message (optional)</p>
                      <textarea
                        placeholder="Happy Birthday! Enjoy this gift 🎉"
                        value={giftMessage}
                        onChange={(e) => setGiftMessage(e.target.value)}
                        maxLength={500}
                        rows={2}
                        className="w-full resize-none rounded-xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-2.5 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
                      />
                    </div>
                    <div>
                      <p className="mb-1.5 text-xs font-medium text-[#A7A79A]">Gift Theme</p>
                      <div className="flex flex-wrap gap-1.5">
                        {GIFT_THEMES.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => setGiftTheme(t.id)}
                            className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors
                              ${giftTheme === t.id
                                ? "border-[#8FAE82] bg-[#8FAE82]/10 text-[#8FAE82]"
                                : "border-[#2A2B27] text-[#A7A79A] hover:border-[#8FAE82]/30"}`}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
            </div>

            <button
              onClick={handleEmailNext}
              className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513]"
            >
              Continue →
            </button>
          </>
        )}

        {/* ── Pick / error step ── */}
        {(step === "pick" || step === "error") && (
          <>
            {/* Loading indicator while fetching full product details */}
            {detailsLoading && (
              <div className="mb-3 flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
                <div className="h-3 w-3 animate-spin rounded-full border border-[#8FAE82] border-t-transparent" />
                <span className="text-xs text-[#A7A79A]">Loading available packages…</span>
              </div>
            )}

            {/* Fixed denominations */}
            {isFixed && (product.packages?.length ?? 0) > 0 && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-medium text-[#A7A79A]">
                  {isEsim ? "Data Plan" : "Select Amount"}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(product.packages ?? []).map((pkg) => {
                    const val = pkgDisplayValue(pkg);
                    const isSelected = selectedPkg
                      ? pkgDisplayValue(selectedPkg) === val
                      : false;
                    return (
                      <button
                        key={pkg.package_value ?? (pkg as BitrefillPackage).value ?? String(Math.random())}
                        onClick={() => setSelectedPkg(pkg)}
                        className={`rounded-xl border px-4 py-2 text-sm font-semibold transition-colors
                          ${isSelected
                            ? "border-[#8FAE82] bg-[#8FAE82]/10 text-[#8FAE82]"
                            : "border-[#2A2B27] text-[#A7A79A] hover:border-[#8FAE82]/40"}`}
                      >
                        {isEsim ? val : pkgLabel(pkg, productCurrency)}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Flexible amount (range pricing) */}
            {!isFixed && product.range && (
              <div className="mb-4">
                <p className="mb-2 text-xs font-medium text-[#A7A79A]">
                  Amount ({isUsdProduct ? `$${product.range.min}–$${product.range.max}` : `${productCurrency} ${product.range.min}–${productCurrency} ${product.range.max}`})
                </p>
                <input
                  type="number"
                  min={product.range.min}
                  max={product.range.max}
                  step={product.range.step}
                  value={customValue}
                  onChange={(e) => setCustomValue(Number(e.target.value))}
                  className="w-full rounded-xl border border-[#2A2B27] bg-[#141513] px-4 py-2.5 text-sm text-[#F2F0E8] focus:border-[#8FAE82] focus:outline-none"
                />
              </div>
            )}

            {/* Payment method selector — filtered to what this product supports */}
            {(() => {
              const pm = product.payment_methods;
              const supported: Set<string> | null = pm
                ? new Set([
                    ...(pm.address_based ?? []),
                    ...(pm.link_only ?? []),
                    ...(pm.balance ?? []),
                  ])
                : null; // null = no info = show all
              const visibleGroups = PAYMENT_METHOD_GROUPS
                .map((g) => ({
                  ...g,
                  methods: supported
                    ? g.methods.filter((m) => supported.has(m.id))
                    : g.methods,
                }))
                .filter((g) => g.methods.length > 0);
              return (
                <div className="mb-4">
                  <p className="mb-2 text-xs font-medium text-[#A7A79A]">Pay with</p>
                  <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                    {visibleGroups.map((group) => (
                      <div key={group.label}>
                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#5C5D58]">
                          {group.label}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {group.methods.map((m) => {
                            const active = paymentMethodId === m.id;
                            return (
                              <button
                                key={m.id}
                                onClick={() => setPaymentMethodId(m.id)}
                                className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors
                                  ${active
                                    ? "border-[#8FAE82] bg-[#8FAE82]/10 text-[#8FAE82]"
                                    : "border-[#2A2B27] text-[#A7A79A] hover:border-[#8FAE82]/30 hover:text-[#F2F0E8]"
                                  }`}
                              >
                                <span>{m.icon}</span>
                                <span>{m.label}</span>
                                <span className={`text-[10px] ${active ? "text-[#8FAE82]/70" : m.badgeColor} opacity-80`}>
                                  {m.badge}
                                </span>
                                {m.chain === "link" && (
                                  <span className="text-[9px] text-[#5C5D58]">↗</span>
                                )}
                                {(m.chain === "address" || m.id === "usdt_bsc") && (
                                  <span className="text-[9px] text-[#5C5D58]">⬇</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Phone + email badges */}
            {isTopup && phoneNumber && (
              <div className="mb-2 flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
                <span className="text-xs text-[#A7A79A]">📱 Sending to:</span>
                <span className="text-xs font-medium text-[#F2F0E8] flex-1 truncate">{phoneNumber}</span>
                <button onClick={() => setStep("email")} className="text-xs text-[#8FAE82] underline shrink-0">Change</button>
              </div>
            )}
            {(isAccountType || isUsernameType || isEmailRecipient) && refillInput && (
              <div className="mb-2 flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
                <span className="text-xs text-[#A7A79A]">
                  {isEmailRecipient ? "📧" : isUsernameType ? "👤" : "🆔"} {accountLabel}:
                </span>
                <span className="text-xs font-medium text-[#F2F0E8] flex-1 truncate">{refillInput}</span>
                <button onClick={() => setStep("email")} className="text-xs text-[#8FAE82] underline shrink-0">Change</button>
              </div>
            )}
            {isGift && giftRecipientEmail && (
              <div className="mb-2 flex items-center gap-2 rounded-xl bg-[#8FAE82]/10 border border-[#8FAE82]/20 px-3 py-2">
                <span className="text-xs text-[#A7A79A]">🎁 Gift to:</span>
                <span className="text-xs font-medium text-[#8FAE82] flex-1 truncate">{giftRecipientName} · {giftRecipientEmail}</span>
                <button onClick={() => setStep("email")} className="text-xs text-[#8FAE82] underline shrink-0">Change</button>
              </div>
            )}
            <div className="mb-3 flex items-center gap-2 rounded-xl bg-white/[0.03] px-3 py-2">
              <span className="text-xs text-[#A7A79A]">✉️ {isGift ? "Your receipt:" : needsRefillInput ? "Receipt to:" : "Code sent to:"}</span>
              <span className="text-xs font-medium text-[#F2F0E8] flex-1 truncate">{recipientEmail}</span>
              <button onClick={() => setStep("email")} className="text-xs text-[#8FAE82] underline shrink-0">
                Change
              </button>
            </div>

            {step === "error" && errMsg && (
              <p className="mb-3 rounded-xl bg-red-900/20 px-4 py-2.5 text-sm text-red-400">{errMsg}</p>
            )}

            <button
              onClick={handleConfirm}
              disabled={isFixed ? !selectedPkg : customValue <= 0}
              className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-60"
            >
              {(() => {
                const pm = getPaymentMethod(paymentMethodId);
                if (pm.chain === "address") return `Get ${pm.token} Deposit Address · ${pm.badge}`;
                if (pm.chain === "link") return `Continue on Bitrefill · ${pm.label}`;
                return `Pay ${formatAmount(displayAmount)} · ${pm.token} on ${pm.label}`;
              })()}
            </button>

            {/* ── About section ── */}
            {(product.descriptions || product.instructions || product.termsConditions || (product.reviews?.length ?? 0) > 0) && (
              <div className="mt-5 space-y-1 border-t border-[#2A2B27] pt-4">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#5C5D58]">About</p>

                {/* Description */}
                {product.descriptions && (
                  <div className="rounded-xl border border-[#2A2B27] overflow-hidden">
                    <button
                      onClick={() => setAboutOpen(aboutOpen === "description" ? null : "description")}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-xs font-medium text-[#F2F0E8]">📋 Description</span>
                      <span className="text-xs text-[#5C5D58]">{aboutOpen === "description" ? "▲" : "▼"}</span>
                    </button>
                    {aboutOpen === "description" && (
                      <div
                        className="px-4 pb-4 text-xs text-[#A7A79A] leading-relaxed prose-style"
                        dangerouslySetInnerHTML={{ __html: product.descriptions }}
                      />
                    )}
                  </div>
                )}

                {/* Redemption instructions */}
                {product.instructions && (
                  <div className="rounded-xl border border-[#2A2B27] overflow-hidden">
                    <button
                      onClick={() => setAboutOpen(aboutOpen === "instructions" ? null : "instructions")}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-xs font-medium text-[#F2F0E8]">📖 How to Redeem</span>
                      <span className="text-xs text-[#5C5D58]">{aboutOpen === "instructions" ? "▲" : "▼"}</span>
                    </button>
                    {aboutOpen === "instructions" && (
                      <div
                        className="px-4 pb-4 text-xs text-[#A7A79A] leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: product.instructions }}
                      />
                    )}
                  </div>
                )}

                {/* Terms & Conditions */}
                {product.termsConditions && (
                  <div className="rounded-xl border border-[#2A2B27] overflow-hidden">
                    <button
                      onClick={() => setAboutOpen(aboutOpen === "terms" ? null : "terms")}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-xs font-medium text-[#F2F0E8]">📜 Terms & Conditions</span>
                      <span className="text-xs text-[#5C5D58]">{aboutOpen === "terms" ? "▲" : "▼"}</span>
                    </button>
                    {aboutOpen === "terms" && (
                      <p className="px-4 pb-4 text-xs text-[#A7A79A] leading-relaxed whitespace-pre-wrap">
                        {product.termsConditions}
                      </p>
                    )}
                  </div>
                )}

                {/* Reviews */}
                {(product.reviews?.length ?? 0) > 0 && (
                  <div className="rounded-xl border border-[#2A2B27] overflow-hidden">
                    <button
                      onClick={() => setAboutOpen(aboutOpen === "reviews" ? null : "reviews")}
                      className="flex w-full items-center justify-between px-4 py-3 text-left"
                    >
                      <span className="text-xs font-medium text-[#F2F0E8]">
                        ★ Reviews
                        {product.ratings && (
                          <span className="ml-2 text-[#5C5D58]">
                            {product.ratings.rating_value.toFixed(1)} · {product.ratings.rating_count}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-[#5C5D58]">{aboutOpen === "reviews" ? "▲" : "▼"}</span>
                    </button>
                    {aboutOpen === "reviews" && (
                      <div className="px-4 pb-4 space-y-3">
                        {product.reviews!.map((r, i) => (
                          <div key={i} className="border-t border-[#2A2B27] pt-3 first:border-0 first:pt-0">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-medium text-[#F2F0E8]">@{r.author_name}</span>
                              <span className="text-[10px] text-[#5C5D58]">{r.date}</span>
                            </div>
                            <div className="mb-1">
                              {Array.from({ length: r.score_max ?? 5 }).map((_, s) => (
                                <span key={s} className={s < r.score ? "text-yellow-400" : "text-[#2A2B27]"}>★</span>
                              ))}
                            </div>
                            <p className="text-xs text-[#A7A79A] leading-relaxed">{r.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Waiting for wallet ── */}
        {step === "paying" && (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
            <div>
              <p className="font-semibold text-[#F2F0E8]">Confirm in your wallet</p>
              <p className="mt-1 text-sm text-[#A7A79A]">
                {(() => {
                  const pm = getPaymentMethod(paymentMethodId);
                  if (pm.chain === "address") return `Generating ${pm.token} deposit address…`;
                  if (pm.chain === "link") return `Opening ${pm.label} checkout…`;
                  return `Sending ${formatAmount(displayAmount)} · ${pm.token} on ${pm.label}`;
                })()}
              </p>
            </div>
          </div>
        )}

        {/* ── Deposit address (BTC, LTC, TON, DOGE, etc.) ── */}
        {step === "address" && (
          <div className="flex flex-col gap-4 py-2">
            {!depositAddress ? (
              /* Null guard — address not returned by Bitrefill for this method */
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-4 text-center">
                <p className="text-sm font-semibold text-amber-400">No deposit address returned</p>
                <p className="mt-1 text-xs text-[#A7A79A]">
                  Please use the Bitrefill link below to complete payment.
                </p>
                {paymentLink && (
                  <a href={paymentLink} target="_blank" rel="noopener noreferrer"
                    className="mt-3 inline-block rounded-xl bg-[#8FAE82] px-4 py-2 text-xs font-semibold text-[#141513]">
                    Open on Bitrefill ↗
                  </a>
                )}
              </div>
            ) : (
              <>
                {/* Header — icon + network + instructions */}
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#8FAE82]/10 text-lg">
                    {getPaymentMethod(paymentMethodId).icon}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[#F2F0E8]">
                      Send {getPaymentMethod(paymentMethodId).token} on {getPaymentMethod(paymentMethodId).badge}
                    </p>
                    <p className="text-xs text-[#A7A79A]">
                      {depositAmount
                        ? "Send the exact amount — we'll detect it automatically"
                        : "Bitrefill didn't provide an exact amount for this network"}
                    </p>
                  </div>
                </div>

                {/* Amount */}
                {depositAmount ? (
                  <div className="rounded-2xl border border-[#8FAE82]/30 bg-[#8FAE82]/5 px-4 py-3 text-center">
                    <p className="text-xs text-[#A7A79A] mb-1">Amount to send</p>
                    <p className="font-mono text-2xl font-bold text-[#8FAE82]">
                      {depositAmount} <span className="text-base">{getPaymentMethod(paymentMethodId).token}</span>
                    </p>
                    <button
                      onClick={() => { navigator.clipboard.writeText(depositAmount); setDepositCopied(true); setTimeout(() => setDepositCopied(false), 2000); }}
                      className="mt-1.5 text-xs text-[#A7A79A] hover:text-[#F2F0E8]"
                    >
                      {depositCopied ? "✓ Copied!" : "Copy amount"}
                    </button>
                  </div>
                ) : paymentLink ? (
                  // Bitcoin, TON, usdt_ton, ark, and Solana never return an exact
                  // amount under guest checkout — Bitrefill's own hosted checkout
                  // page (payment_link) is the only place that shows it.
                  <a
                    href={paymentLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-2xl border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-center text-sm font-semibold text-amber-300 hover:bg-amber-400/10"
                  >
                    ⚠ View exact amount on Bitrefill →
                  </a>
                ) : null}

                {/* QR code (paymentUri preferred; fall back to raw address) */}
                <div className="flex justify-center">
                  <div className="rounded-2xl bg-white p-3">
                    <QRCodeSVG
                      value={depositPaymentUri ?? depositAddress}
                      size={160}
                      level="M"
                      includeMargin={false}
                    />
                  </div>
                </div>

                {/* Address / Lightning invoice */}
                <div className="rounded-2xl border border-[#2A2B27] bg-[#141513] px-4 py-3">
                  <p className="text-xs text-[#A7A79A] mb-2">
                    {paymentMethodId === "lightning" || paymentMethodId === "usdt_lightning"
                      ? "Lightning invoice"
                      : "Deposit address"}
                  </p>
                  <p className="font-mono text-xs text-[#F2F0E8] break-all leading-relaxed">{depositAddress}</p>
                  <button
                    onClick={() => { navigator.clipboard.writeText(depositAddress!); setDepositCopied(true); setTimeout(() => setDepositCopied(false), 2000); }}
                    className={`mt-2.5 w-full rounded-xl py-2 text-xs font-semibold transition-colors
                      ${depositCopied ? "bg-[#8FAE82]/20 text-[#8FAE82]" : "bg-white/[0.06] text-[#F2F0E8] hover:bg-white/[0.1]"}`}
                  >
                    {depositCopied
                      ? "✓ Copied!"
                      : paymentMethodId === "lightning" || paymentMethodId === "usdt_lightning"
                        ? "Copy Invoice"
                        : "Copy Address"}
                  </button>
                </div>

                {/* Status / expiry */}
                {pollStatus && pollStatus !== "unpaid" ? (
                  <p className="text-center text-xs font-medium text-[#8FAE82]">
                    ✓ {invoiceStatusLabel(pollStatus)}
                  </p>
                ) : expirySecsLeft !== null ? (
                  <p className={`text-center text-xs ${expirySecsLeft < 120 ? "text-amber-400 font-medium" : "text-[#A7A79A]"}`}>
                    {expirySecsLeft > 0
                      ? `⏳ Expires in ${Math.floor(expirySecsLeft / 60)}:${String(expirySecsLeft % 60).padStart(2, "0")}`
                      : "⚠️ Invoice expired · Please start a new purchase"}
                  </p>
                ) : (
                  <p className="text-center text-xs text-[#A7A79A]">⏳ Waiting for payment · Expires in ~15 min</p>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Processing order ── */}
        {step === "polling" && (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <div className="h-10 w-10 animate-pulse rounded-full border-2 border-[#8FAE82]" />
            <div>
              <p className="font-semibold text-[#F2F0E8]">{invoiceStatusLabel(pollStatus)}</p>
              <p className="mt-1 text-sm text-[#A7A79A]">Preparing your {typeLabel.toLowerCase()}</p>
              {invoice && (
                <p className="mt-1 text-xs text-[#A7A79A]/50">
                  Order {invoice.invoice_id ?? invoice.id}
                </p>
              )}
            </div>
            {paymentLink && (
              <a
                href={paymentLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 text-xs text-[#8FAE82] underline"
              >
                Open payment page ↗
              </a>
            )}
          </div>
        )}

        {/* ── Done ── */}
        {step === "done" && (
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-900/30 text-3xl">✓</div>
            <div>
              <p className="text-lg font-semibold text-green-400">
                {isTopup ? "Top-Up Sent!" : isEsim ? "eSIM Ready!" : "Purchase Complete!"}
              </p>
              <p className="mt-1 text-sm text-[#A7A79A]">Your {product.name} is ready</p>
            </div>
            {code ? (
              <div className="w-full rounded-2xl border border-[#8FAE82]/30 bg-[#141513] p-4">
                <p className="mb-1 text-xs font-medium text-[#A7A79A]">
                  {isEsim ? "Activation Code" : isTopup ? "Confirmation" : "Redemption Code"}
                </p>
                <p className="font-mono text-xl font-bold tracking-widest text-[#8FAE82]">{code}</p>
                <button
                  onClick={() => navigator.clipboard.writeText(code)}
                  className="mt-2 text-xs text-[#A7A79A] hover:text-[#F2F0E8]"
                >
                  Copy code
                </button>
              </div>
            ) : (
              <div className="w-full rounded-2xl bg-[#141513] p-4 text-center text-sm text-[#A7A79A]">
                {isTopup
                  ? "Top-up applied to your number ✓"
                  : `Details sent to ${recipientEmail} ✉️`}
              </div>
            )}
            <button
              onClick={onClose}
              className="w-full rounded-2xl bg-[#8FAE82] py-3 text-sm font-semibold text-[#141513]"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Product detail sheet ──────────────────────────────────────────────────────
// Shown between the browse grid and the checkout sheet.
// Fetches full product details and shows all rich fields.

function ProductDetailSheet({
  product: initialProduct,
  screenTab,
  onClose,
  onBuy,
}: {
  product: BitrefillProduct;
  screenTab: ScreenTab;
  onClose: () => void;
  onBuy: (p: BitrefillProduct) => void;
}) {
  const [product, setProduct] = useState<BitrefillProduct>(initialProduct);
  const [loading, setLoading] = useState(!initialProduct.descriptions);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    if (initialProduct.descriptions) return; // already rich
    fetchWithRetry(`/api/bitrefill/products/${encodeURIComponent(initialProduct.id)}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d: BitrefillProduct | null) => { if (d) setProduct(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [initialProduct.id, initialProduct.descriptions]);

  const pm = product.payment_methods;
  const allSupported = pm
    ? [...(pm.address_based ?? []), ...(pm.link_only ?? []), ...(pm.balance ?? [])]
    : [];
  // Show only methods we have defined in our groups
  const supportedUi = PAYMENT_METHOD_GROUPS
    .flatMap((g) => g.methods)
    .filter((m) => allSupported.includes(m.id));

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col rounded-t-3xl bg-[#1B1C19] border-t border-[#2A2B27] max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-4 border-b border-[#2A2B27] shrink-0">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] overflow-hidden">
            {logoUrl(product) && !imgFailed ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl(product)!} alt={product.name}
                className="h-full w-full object-contain p-1.5"
                onError={() => setImgFailed(true)} />
            ) : (
              <span className="text-xl">{productEmoji(product.name, screenTab)}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-[#F2F0E8] leading-tight">{product.name}</h3>
            {loading ? (
              <div className="mt-1 h-2.5 w-32 animate-pulse rounded bg-white/[0.06]" />
            ) : product.subtitles ? (
              <p className="mt-0.5 text-xs text-[#A7A79A] truncate">{product.subtitles}</p>
            ) : null}
            {product.ratings && (
              <span className="mt-0.5 flex items-center gap-1 text-xs text-[#A7A79A]">
                <span className="text-yellow-400">★</span>
                {product.ratings.rating_value.toFixed(1)}
                <span className="text-[#5C5D58]">({product.ratings.rating_count})</span>
              </span>
            )}
          </div>
          <button onClick={onClose} className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-[#A7A79A] hover:bg-white/[0.06] hover:text-[#F2F0E8] transition-colors">
            ← Back
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">

          {/* Price range */}
          {priceRange(product) && (
            <div className="mb-4 flex items-center gap-2">
              <span className="rounded-full bg-[#8FAE82]/15 px-3 py-1 text-sm font-semibold text-[#8FAE82]">
                {priceRange(product)}
              </span>
              {product.in_stock === false && (
                <span className="rounded-full bg-[#2A2B27] px-3 py-1 text-xs text-[#5C5D58]">Out of stock</span>
              )}
            </div>
          )}

          {/* Descriptions */}
          {loading ? (
            <div className="space-y-2 mb-5">
              {[70, 90, 55, 80].map((w) => (
                <div key={w} className={`h-2.5 animate-pulse rounded bg-white/[0.06]`} style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : product.descriptions ? (
            <div
              className="mb-5 text-xs leading-relaxed text-[#A7A79A] [&_a]:text-[#8FAE82] [&_strong]:text-[#F2F0E8] [&_ul]:ml-4 [&_ol]:ml-4 [&_li]:mb-1"
              dangerouslySetInnerHTML={{ __html: product.descriptions }}
            />
          ) : null}

          {/* How to redeem */}
          {product.instructions && (
            <div className="mb-5">
              <p className="mb-2 text-xs font-semibold text-[#F2F0E8]">How to Redeem</p>
              <div
                className="text-xs leading-relaxed text-[#A7A79A] [&_a]:text-[#8FAE82] [&_strong]:text-[#F2F0E8] [&_ul]:ml-4 [&_ol]:ml-4 [&_li]:mb-1"
                dangerouslySetInnerHTML={{ __html: product.instructions }}
              />
            </div>
          )}

          {/* Supported payment methods */}
          {supportedUi.length > 0 && (
            <div className="mb-5">
              <p className="mb-2 text-xs font-semibold text-[#F2F0E8]">Accepted Payment Methods</p>
              <div className="flex flex-wrap gap-1.5">
                {supportedUi.map((m) => (
                  <span
                    key={m.id}
                    className="flex items-center gap-1 rounded-lg border border-[#2A2B27] bg-white/[0.03] px-2 py-1 text-xs text-[#A7A79A]"
                  >
                    <span>{m.icon}</span>
                    <span>{m.label}</span>
                    <span className={`text-[10px] ${m.badgeColor} opacity-70`}>{m.badge}</span>
                    {m.chain === "link" && <span className="text-[9px] text-[#5C5D58]">↗</span>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Reviews */}
          {(product.reviews?.length ?? 0) > 0 && (
            <div className="mb-5">
              <p className="mb-2 text-xs font-semibold text-[#F2F0E8]">
                Reviews
                {product.ratings && (
                  <span className="ml-1.5 font-normal text-[#A7A79A]">
                    ★ {product.ratings.rating_value.toFixed(1)} · {product.ratings.rating_count} ratings
                  </span>
                )}
              </p>
              <div className="space-y-2">
                {product.reviews!.map((r, i) => (
                  <div key={i} className="rounded-xl bg-white/[0.03] px-3 py-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-[#F2F0E8]">{r.author_name}</span>
                      <span className="text-[10px] text-[#5C5D58]">
                        <span className="text-yellow-400 mr-1">{"★".repeat(Math.round(r.score))}</span>
                        {r.date}
                      </span>
                    </div>
                    <p className="text-xs text-[#A7A79A] leading-relaxed">{r.content}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Terms */}
          {product.termsConditions && (
            <details className="mb-5 rounded-xl border border-[#2A2B27] bg-white/[0.02] px-3 py-2">
              <summary className="cursor-pointer text-xs font-semibold text-[#A7A79A] list-none flex justify-between items-center">
                Terms & Conditions <span className="text-[10px]">▼</span>
              </summary>
              <p className="mt-2 text-[11px] leading-relaxed text-[#5C5D58]">{product.termsConditions}</p>
            </details>
          )}
        </div>

        {/* Footer CTA */}
        <div className="shrink-0 px-5 pb-8 pt-3 border-t border-[#2A2B27]">
          <button
            onClick={() => onBuy(product)}
            disabled={product.in_stock === false}
            className="w-full rounded-2xl bg-[#8FAE82] py-3.5 text-sm font-semibold text-[#141513] disabled:opacity-50"
          >
            {product.in_stock === false
              ? "Out of Stock"
              : (product.recipient_type === "phone_number" || screenTab === "topup") ? "Refill Now"
              : (product.recipient_type === "esim"          || screenTab === "esim")  ? "Get Plan"
              : "Buy Now"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Skeleton loader ────────────────────────────────────────────────────────────

function SkeletonList() {
  return (
    <div className="flex flex-col gap-3">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
          <div className="h-11 w-11 shrink-0 animate-pulse rounded-xl bg-white/[0.06]" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-3/4 animate-pulse rounded bg-white/[0.06]" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-white/[0.04]" />
          </div>
          <div className="h-8 w-16 animate-pulse rounded-xl bg-white/[0.06]" />
        </div>
      ))}
    </div>
  );
}

// ── Bitrefill detail (full product browse + checkout) ─────────────────────────

function BitrefillDetail() {
  const { getAccessToken } = usePrivy();
  const { paidBillIds } = useDemoState();
  const { open: openChat, sendMessage } = useChatSheet();

  const [screenTab, setScreenTab]   = useState<ScreenTab>("cards");
  const [cardTab, setCardTab]       = useState<CardTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [country, setCountry]       = useState<CountryEntry>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("br_country");
      if (saved) return getCountry(saved);
    }
    return COUNTRIES[0]; // US default
  });
  const [products, setProducts]     = useState<BitrefillProduct[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [loading, setLoading]       = useState(true);
  const [detailProduct, setDetailProduct]     = useState<BitrefillProduct | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<BitrefillProduct | null>(null);
  const [purchasedIds, setPurchasedIds]       = useState<Set<string>>(new Set());

  // Count completed bill purchases from the DB (includes AI-initiated purchases)
  const { billPayments } = usePaymentsContext();

  // Persist country preference
  const handleCountryChange = useCallback((c: CountryEntry) => {
    setCountry(c);
    if (typeof window !== "undefined") localStorage.setItem("br_country", c.code);
    setProducts([]);
  }, []);

  // Fetch products
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setProducts([]);

    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "40", country: country.code });

    if (screenTab === "esim") {
      params.set("category", "esim");
    } else if (screenTab === "topup") {
      params.set("category", "topup");
    } else {
      const category = CARD_TAB_TO_CATEGORY[cardTab];
      if (category) params.set("category", category);
    }

    if (searchQuery.trim()) params.set("q", searchQuery.trim());

    setFetchError(null);
    fetchWithRetry(`/api/bitrefill/products?${params}`)
      .then(async (r) => {
        const data = await r.json();
        if (cancelled) return;
        if (!r.ok || data.error) {
          setFetchError(data.error ?? `Server error ${r.status}`);
          setProducts([]);
        } else {
          setProducts(data.data ?? []);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.name !== "AbortError") setFetchError("Could not reach product catalog. Check your connection.");
        setProducts([]);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; controller.abort(); };
  }, [screenTab, cardTab, searchQuery, country, retryCount]);

  const handlePurchased = useCallback((invoiceId: string, _code: string | null, paymentMethod: string) => {
    if (selectedProduct) setPurchasedIds((prev) => new Set([...prev, selectedProduct.id]));
    const firstPkg = selectedProduct?.packages?.[0];
    // Use price_usd / priceInUsd for accurate USD amount; for non-USD packages
    // that have no USD price, default to 0 to avoid logging raw native-currency
    // amounts as if they were dollars.
    const _fp = firstPkg as BitrefillPackage | undefined;
    const amountUsdc = _fp ? (_fp.price_usd ?? _fp.priceInUsd ?? 0) : 0;
    // Detect actual chain from payment method
    const chain = paymentMethod.includes("solana") ? "solana" : "evm";
    // PATCH updates the pending row created by /api/bitrefill/invoice (prevents duplicates).
    // Falls back to POST only if the PATCH finds no existing row (referenceId not yet in DB).
    authFetch("/api/payments", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        referenceId: invoiceId,
        description: `Purchased ${selectedProduct?.name ?? "digital product"} via ${paymentMethod}`,
        amountUsdc: amountUsdc.toFixed(6),
        status: "completed",
        txHash: null,
        chain,
      }),
    }, getAccessToken).then(async (res) => {
      // If no existing row found, insert fresh (invoice creation may have been skipped)
      if (res.status === 404) {
        return authFetch("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "bill",
            referenceId: invoiceId,
            description: `Purchased ${selectedProduct?.name ?? "digital product"} via ${paymentMethod}`,
            amountUsdc: amountUsdc.toFixed(6),
            status: "completed",
            chain,
          }),
        }, getAccessToken);
      }
    }).catch(() => {});
    // Regenerate weekly insight in the background so it reflects this spend immediately
    authFetch("/api/insights/weekly", { method: "POST" }, getAccessToken).catch(() => {});
    // Also upsert the bitrefill_orders row to complete
    authFetch("/api/bitrefill/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invoiceId,
        status: "complete",
        redemptionCode: _code ?? undefined,
      }),
    }, getAccessToken).catch(() => {});
  }, [selectedProduct, getAccessToken]);

  // Unique completed bill count: DB rows (AI + UI purchases) + any local-only
  // purchases not yet persisted. De-duplicate by using DB as the source of truth.
  const dbCompletedBills = billPayments.filter((p) => p.status === "completed").length;
  const totalPurchased = Math.max(purchasedIds.size + paidBillIds.length, dbCompletedBills);

  const aiPromptByTab: Record<ScreenTab, string> = {
    cards:  "Find me a good gift card for gaming or streaming",
    topup:  "Help me top up my mobile phone",
    esim:   "I need a travel eSIM data plan for my trip",
  };

  return (
    <div className="flex flex-col gap-4">

      {/* Summary card */}
      <div className="rounded-3xl bg-[#8FAE82] p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm font-medium text-[#141513]/70">Digital Products</p>
            <p className="mt-1 text-3xl font-bold text-[#141513]">
              {totalPurchased}
              <span className="text-base font-medium ml-2">purchased</span>
            </p>
            <p className="mt-0.5 text-xs text-[#141513]/50">
              10,000+ products · {country.flag} {country.name} · {country.currency}
            </p>
          </div>
          <CountrySelector selected={country} onChange={handleCountryChange} />
        </div>
        <button
          onClick={() => { sendMessage(aiPromptByTab[screenTab]); openChat(); }}
          className="mt-4 rounded-xl bg-[#141513]/20 px-4 py-2 text-sm font-semibold text-[#141513]"
        >
          Ask AI to find products
        </button>
      </div>

      {/* Screen-level tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {SCREEN_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setScreenTab(tab.key); setSearchQuery(""); setCardTab("all"); }}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              screenTab === tab.key
                ? "bg-[#F2F0E8] text-[#141513]"
                : "bg-white/[0.06] text-[#A7A79A]"
            }`}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Gift-card category sub-tabs */}
      {screenTab === "cards" && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {CARD_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => { setCardTab(tab.key); setSearchQuery(""); }}
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                cardTab === tab.key
                  ? "bg-[#8FAE82]/20 text-[#8FAE82] border border-[#8FAE82]/40"
                  : "bg-white/[0.04] text-[#A7A79A] border border-transparent"
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* Search bar */}
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A7A79A]">🔍</span>
        <input
          type="text"
          placeholder={
            screenTab === "esim"  ? "Search eSIM plans…" :
            screenTab === "topup" ? "Search carrier or country…" :
            "Search gift cards…"
          }
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full rounded-2xl border border-[#2A2B27] bg-[#1B1C19] py-2.5 pl-9 pr-4 text-sm text-[#F2F0E8] placeholder-[#A7A79A] focus:border-[#8FAE82] focus:outline-none"
        />
      </div>

      {/* Phone refill info banner */}
      {screenTab === "topup" && !loading && products.length > 0 && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 flex items-center gap-3">
          <span className="text-xl">📱</span>
          <p className="text-xs text-[#A7A79A]">
            Select your carrier below, then enter your phone number to top up.
            Works with most networks in {country.flag} {country.name}.
          </p>
        </div>
      )}

      {/* eSIM info banner */}
      {screenTab === "esim" && !loading && products.length > 0 && (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] px-4 py-3 flex items-center gap-3">
          <span className="text-xl">🌐</span>
          <p className="text-xs text-[#A7A79A]">
            Travel eSIM data plans — scan the QR code on your phone to activate.
            No physical SIM swap needed.
          </p>
        </div>
      )}

      {/* Product list */}
      {loading ? (
        <SkeletonList />
      ) : products.length === 0 ? (
        <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-8 text-center">
          <p className="mb-2 text-2xl">{fetchError ? "⚠️" : "🔍"}</p>
          <p className="text-sm text-[#A7A79A]">
            {fetchError
              ? fetchError
              : searchQuery
                ? `No results for "${searchQuery}"`
                : `No ${screenTab === "esim" ? "eSIM plans" : screenTab === "topup" ? "carriers" : "products"} found for ${country.name}`}
          </p>
          {fetchError ? (
            <button
              onClick={() => setRetryCount((n) => n + 1)}
              className="mt-3 text-xs text-[#8FAE82] underline"
            >
              Retry
            </button>
          ) : searchQuery ? (
            <button
              onClick={() => setSearchQuery("")}
              className="mt-3 text-xs text-[#8FAE82] underline"
            >
              Clear search
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              screenTab={screenTab}
              onSelect={setDetailProduct}
              purchased={purchasedIds.has(product.id)}
            />
          ))}
        </div>
      )}

      {/* Product detail sheet — shown on card tap, before checkout */}
      {detailProduct && !selectedProduct && (
        <ProductDetailSheet
          product={detailProduct}
          screenTab={screenTab}
          onClose={() => setDetailProduct(null)}
          onBuy={(p) => { setSelectedProduct(p); }}
        />
      )}

      {/* Checkout sheet */}
      {selectedProduct && (
        <CheckoutSheet
          product={selectedProduct}
          screenTab={screenTab}
          countryCode={country.code}
          onClose={() => { setSelectedProduct(null); setDetailProduct(null); }}
          onPurchased={(invoiceId, code, paymentMethod) => {
            handlePurchased(invoiceId, code, paymentMethod);
          }}
        />
      )}
    </div>
  );
}

// ── Main BillsScreen ─────────────────────────────────────────────────────────

export function BillsScreen() {
  const { paidBillIds } = useDemoState();
  const { open: openChat, sendMessage } = useChatSheet();
  const [viewTab, setViewTab] = useState<"bills" | "browse">("bills");
  const [bitrefillOpen, setBitrefillOpen] = useState(false);

  // Count completed purchases from DB — includes AI-initiated ones, not just UI purchases
  const { billPayments, loading: billsLoading } = usePaymentsContext();
  const dbCompletedCount = billPayments.filter((p) => p.status === "completed").length;
  const totalPurchased = Math.max(paidBillIds.length, dbCompletedCount);

  return (
    <div className="flex flex-col gap-4">

      {/* Summary card */}
      <div className="rounded-3xl bg-[#8FAE82] p-5">
        <p className="text-sm font-medium text-[#141513]/70">Digital Products</p>
        <p className="mt-1 text-3xl font-bold text-[#141513]">
          {billsLoading ? "…" : totalPurchased}
          <span className="text-base font-medium ml-2">purchased</span>
        </p>
        <p className="mt-0.5 text-xs text-[#141513]/50">
          Gift cards · Mobile top-ups · eSIM data plans
        </p>
        <button
          onClick={() => {
            sendMessage("Find me a good gift card for gaming or streaming");
            openChat();
          }}
          className="mt-4 rounded-xl bg-[#141513]/20 px-4 py-2 text-sm font-semibold text-[#141513]"
        >
          Ask AI to find products
        </button>
      </div>

      {/* View toggle */}
      <div className="flex gap-2">
        {(["bills", "browse"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setViewTab(tab)}
            className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
              viewTab === tab
                ? "bg-[#F2F0E8] text-[#141513]"
                : "bg-white/[0.06] text-[#A7A79A]"
            }`}
          >
            {tab === "bills" ? "My Bills" : "Browse"}
          </button>
        ))}
      </div>

      {/* My Bills view */}
      {viewTab === "bills" && (
        billsLoading ? (
          // Don't flash "No purchases yet" while DB is loading
          <div className="py-12 text-center">
            <div className="mx-auto h-8 w-32 animate-pulse rounded-xl bg-white/[0.06]" />
          </div>
        ) : totalPurchased === 0 ? (
          <div className="py-12 text-center">
            <p className="text-4xl">🧾</p>
            <p className="mt-2 font-semibold text-[#F2F0E8]">No purchases yet</p>
            <p className="mt-1 text-sm text-[#A7A79A]">
              Browse digital products to get started
            </p>
            <button
              onClick={() => setViewTab("browse")}
              className="mt-4 rounded-2xl bg-[#8FAE82] px-6 py-2.5 text-sm font-semibold text-[#141513]"
            >
              Browse Products
            </button>
          </div>
        ) : (
          <div className="rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-center">
            <p className="text-sm text-[#A7A79A]">
              {totalPurchased} product{totalPurchased !== 1 ? "s" : ""} purchased
            </p>
          </div>
        )
      )}

      {/* Browse view */}
      {viewTab === "browse" && (
        <div className="flex flex-col gap-3">
          <button
            onClick={() => setBitrefillOpen(true)}
            className="flex items-center gap-4 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4 text-left transition-colors hover:border-[#3A3B37] active:bg-white/[0.04] w-full"
          >
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="https://files.readme.io/4d0d667c7bc96cf97cd030670700d5a4163c361f3ed8a83dec0b6b1ce5cc5076-iOS_app_icon_1024.png"
                alt="Bitrefill"
                className="h-full w-full object-contain p-1.5"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; (e.currentTarget.parentElement as HTMLElement).textContent = "🎁"; }}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-[#F2F0E8]">Bitrefill</p>
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-[#A7A79A]">Digital Products</span>
                <span className="rounded-full px-2 py-0.5 text-xs font-medium text-green-400 bg-green-400/10">USDC</span>
              </div>
              <p className="truncate text-xs text-[#A7A79A] mt-0.5">
                Gift cards, mobile top-ups &amp; eSIM data plans — 10,000+ products worldwide
              </p>
            </div>
            <svg className="shrink-0 text-[#A7A79A]" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      )}

      {/* Bitrefill detail sheet */}
      {bitrefillOpen && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[70] flex flex-col">
          <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={() => setBitrefillOpen(false)} />
          <div className="bg-[#141513] rounded-t-3xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[#2A2B27] shrink-0">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-xl bg-white/[0.06] overflow-hidden flex items-center justify-center shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="https://files.readme.io/4d0d667c7bc96cf97cd030670700d5a4163c361f3ed8a83dec0b6b1ce5cc5076-iOS_app_icon_1024.png"
                    alt="Bitrefill"
                    className="h-full w-full object-contain p-1"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                  />
                </div>
                <div>
                  <p className="font-semibold text-[#F2F0E8] text-sm">Bitrefill</p>
                  <p className="text-xs text-[#A7A79A]">Digital Products</p>
                </div>
              </div>
              <button
                onClick={() => setBitrefillOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.06] text-[#A7A79A] hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-4 pb-[calc(max(env(safe-area-inset-bottom),24px)+72px)]">
              <BitrefillDetail />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
