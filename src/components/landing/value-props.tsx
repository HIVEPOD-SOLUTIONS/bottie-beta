"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";

const PROPS = [
  {
    label: "Just talk",
    heading: "No tapping through menus.",
    body: "Tell Bluvfi to pay your Netflix bill or buy 2 shares of Apple — it handles the payment and confirms back in plain English.",
  },
  {
    label: "Gas-free",
    heading: "Payments settle instantly.",
    body: "Circle Gateway nanopayments mean every transaction settles in seconds on Base with zero gas fees — you never touch crypto manually.",
  },
  {
    label: "Any wallet",
    heading: "Fund from anywhere.",
    body: "Send USDC directly or bridge from Ethereum, Arbitrum, Optimism, and 5 other networks in one tap using Arc AppKit.",
  },
];

const ease = [0.16, 1, 0.3, 1] as [number, number, number, number];

function PropRow({
  prop,
  delay,
  isParentInView,
}: {
  prop: (typeof PROPS)[number];
  delay: number;
  isParentInView: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20, filter: "blur(8px)" }}
      animate={isParentInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
      transition={{ delay: delay / 1000, duration: 0.7, ease }}
      className="border-t border-border/40 pt-6"
    >
      <p className="font-display italic text-sm text-sage/70">{prop.label}</p>
      <h3 className="mt-2 font-display text-[clamp(1.6rem,7vw,2.2rem)] leading-tight tracking-tight text-ink">
        {prop.heading}
      </h3>
      <p className="mt-3 font-body text-sm leading-relaxed text-ink-light/60 text-pretty">
        {prop.body}
      </p>
    </motion.div>
  );
}

export function ValueProps() {
  const sectionRef = useRef<HTMLElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.25 });

  return (
    <section ref={sectionRef} className="flex min-h-dvh flex-col justify-center px-6 py-16">
      <motion.p
        initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
        animate={isInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
        transition={{ duration: 0.6, ease }}
        className="font-display italic text-2xl text-sage/70"
      >
        Why Bluvfi
      </motion.p>

      <div className="mt-8 flex flex-col gap-8">
        {PROPS.map((prop, i) => (
          <PropRow key={prop.label} prop={prop} delay={i * 200} isParentInView={isInView} />
        ))}
      </div>
    </section>
  );
}
