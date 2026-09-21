"use client";

import { motion } from "framer-motion";
import { useState } from "react";

interface Partner {
  name: string;
  domain: string;
  category: string;
}

const PARTNERS: Partner[] = [
  // Auth
  { name: "Privy", domain: "privy.io", category: "Auth" },
  // AI & LLM
  { name: "OpenAI", domain: "openai.com", category: "AI" },
  { name: "Google Gemini", domain: "google.com", category: "AI" },
  { name: "Qwen", domain: "alibabacloud.com", category: "AI" },
  // Blockchain Infra
  { name: "Alchemy", domain: "alchemy.com", category: "Infra" },
  { name: "Helius", domain: "helius.dev", category: "Infra" },
  { name: "QuickNode", domain: "quicknode.com", category: "Infra" },
  { name: "MagicBlock", domain: "magicblock.gg", category: "Infra" },
  // Payments
  { name: "Circle", domain: "circle.com", category: "Payments" },
  { name: "Arc AppKit", domain: "circle.com", category: "Payments" },
  { name: "x402", domain: "x402.org", category: "Payments" },
  { name: "SpherePay", domain: "spherepay.co", category: "Payments" },
  { name: "Fuze Finance", domain: "fuze.finance", category: "Payments" },
  // Bills
  { name: "Bitrefill", domain: "bitrefill.com", category: "Bills" },
  // DeFi / Trading
  { name: "Flash Trade", domain: "flash.trade", category: "DeFi" },
  { name: "Velvet Capital", domain: "velvet.capital", category: "DeFi" },
  { name: "dYdX", domain: "dydx.trade", category: "DeFi" },
  { name: "0x Protocol", domain: "0x.org", category: "DeFi" },
  { name: "Doma Protocol", domain: "doma.xyz", category: "DeFi" },
  { name: "Yo Protocol", domain: "yoprotocol.io", category: "DeFi" },
  // RWA
  { name: "xStocks", domain: "xstocks.fi", category: "RWA" },
  { name: "Backed", domain: "backed.fi", category: "RWA" },
  { name: "GRAIL", domain: "grail.finance", category: "RWA" },
  // XRP / XRPL
  { name: "XRPL", domain: "xrpl.org", category: "XRP" },
  { name: "NEAR Intents", domain: "near.org", category: "Intents" },
  // Banking
  { name: "Credible Finance", domain: "credible.finance", category: "Banking" },
  { name: "Ripple", domain: "ripple.com", category: "Banking" },
  // GPU / Compute
  { name: "Nosana", domain: "nosana.io", category: "GPU" },
  // Entertainment
  { name: "Roaster", domain: "roaster.gg", category: "Gaming" },
  // Market Data
  { name: "CoinMarketCap", domain: "coinmarketcap.com", category: "Data" },
  // Ads
  { name: "AdMob", domain: "admob.google.com", category: "Ads" },
  // Database
  { name: "Neon", domain: "neon.tech", category: "Database" },
  // Mobile / PWA
  { name: "Capacitor", domain: "capacitorjs.com", category: "Mobile" },
  // SDK / Protocol
  { name: "Wagmi", domain: "wagmi.sh", category: "SDK" },
  { name: "viem", domain: "viem.sh", category: "SDK" },
  // Hosting
  { name: "AWS Amplify", domain: "aws.amazon.com", category: "Infra" },
  { name: "Vercel", domain: "vercel.com", category: "Infra" },
  { name: "Upstash", domain: "upstash.com", category: "Database" },
];

const MID = Math.ceil(PARTNERS.length / 2);
const ROW_1 = PARTNERS.slice(0, MID);
const ROW_2 = PARTNERS.slice(MID);

const MARQUEE_CSS = `
  @keyframes bluvfi-marquee-left {
    from { transform: translateX(0); }
    to   { transform: translateX(-50%); }
  }
  @keyframes bluvfi-marquee-right {
    from { transform: translateX(-50%); }
    to   { transform: translateX(0); }
  }
`;

function PartnerChip({ partner }: { partner: Partner }) {
  const [imgOk, setImgOk] = useState(true);

  return (
    <div
      className="flex flex-none items-center gap-2.5 rounded-xl border border-border/40 bg-cream-dark/70 px-4 py-2.5 backdrop-blur-sm"
      style={{ minWidth: 130 }}
    >
      {imgOk ? (
        <img
          src={`https://logo.clearbit.com/${partner.domain}?size=64`}
          alt=""
          width={28}
          height={28}
          className="h-7 w-7 flex-none rounded-md object-contain"
          onError={() => setImgOk(false)}
        />
      ) : (
        <div className="flex h-7 w-7 flex-none items-center justify-center rounded-md bg-sage/10">
          <span className="text-[11px] font-bold text-sage">
            {partner.name.slice(0, 2).toUpperCase()}
          </span>
        </div>
      )}
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-ink/80 leading-tight">{partner.name}</p>
        <p className="text-[9px] uppercase tracking-wider text-ink/30 leading-tight mt-0.5">{partner.category}</p>
      </div>
    </div>
  );
}

function MarqueeRow({
  partners,
  direction,
  duration,
}: {
  partners: Partner[];
  direction: "left" | "right";
  duration: number;
}) {
  const doubled = [...partners, ...partners];
  const animName = direction === "left" ? "bluvfi-marquee-left" : "bluvfi-marquee-right";

  return (
    <div className="overflow-hidden">
      <div
        className="flex gap-3"
        style={{
          width: "max-content",
          animation: `${animName} ${duration}s linear infinite`,
        }}
      >
        {doubled.map((p, i) => (
          <PartnerChip key={`${p.name}-${i}`} partner={p} />
        ))}
      </div>
    </div>
  );
}

export function PartnersSection() {
  return (
    <section className="relative flex min-h-dvh flex-col justify-center overflow-hidden">
      <style>{MARQUEE_CSS}</style>

      {/* Ambient gradient */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 50% 50%, rgba(143,174,130,0.04), transparent)",
        }}
      />

      {/* Heading */}
      <div className="relative mx-auto mb-14 max-w-3xl px-6">
        <motion.p
          initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
          whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="font-display italic text-2xl text-sage/70"
        >
          Built with the best
        </motion.p>

        <motion.p
          initial={{ opacity: 0, y: 20, filter: "blur(8px)" }}
          whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="mt-5 font-display text-3xl leading-snug text-ink sm:text-4xl"
        >
          Integrated with{" "}
          <span className="text-sage">40+ trusted partners</span> — from AI
          models to blockchain infrastructure and payments.
        </motion.p>
      </div>

      {/* Marquee rows */}
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.8, delay: 0.25 }}
        className="relative flex flex-col gap-4"
      >
        {/* Edge fade — left */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24"
          style={{ background: "linear-gradient(to right, var(--color-cream), transparent)" }}
        />
        {/* Edge fade — right */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24"
          style={{ background: "linear-gradient(to left, var(--color-cream), transparent)" }}
        />

        <MarqueeRow partners={ROW_1} direction="left" duration={50} />
        <MarqueeRow partners={ROW_2} direction="right" duration={42} />
      </motion.div>

      {/* Partner count badge */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.5 }}
        className="relative mx-auto mt-12 px-6"
      >
        <span className="inline-flex items-center gap-2 rounded-full border border-border/40 bg-cream-dark/60 px-4 py-2 text-xs text-ink/40">
          <span className="h-1.5 w-1.5 rounded-full bg-sage/60" />
          {PARTNERS.length} active integrations
        </span>
      </motion.div>
    </section>
  );
}
