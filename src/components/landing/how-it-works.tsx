"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useInView } from "framer-motion";

const STEPS = [
  {
    number: "01",
    title: "Sign up in seconds",
    micro: "email, Google, or Apple — no wallet, no seed phrases",
  },
  {
    number: "02",
    title: "Tell Bluvfi what you need",
    micro: "pay a bill, buy a stock, check your balance — just ask",
  },
  {
    number: "03",
    title: "Done — instantly",
    micro: "Circle nanopayments settle in seconds, no gas, no fuss",
  },
];

const ease = [0.16, 1, 0.3, 1] as [number, number, number, number];

function StepRow({
  step,
  delay,
  isParentInView,
}: {
  step: (typeof STEPS)[number];
  delay: number;
  isParentInView: boolean;
}) {
  const [triggered, setTriggered] = useState(false);

  useEffect(() => {
    if (!isParentInView || triggered) return;
    const t = setTimeout(() => setTriggered(true), delay);
    return () => clearTimeout(t);
  }, [isParentInView, delay, triggered]);

  const show = triggered;

  return (
    <div className="relative overflow-hidden py-6">
      {/* Ghosted step number — right-aligned, massive, sigil-style */}
      <motion.span
        aria-hidden
        className="pointer-events-none absolute -right-3 top-1/2 -translate-y-1/2 select-none font-display italic text-[clamp(100px,22vw,160px)] leading-none text-ink/[0.03]"
        initial={{ opacity: 0 }}
        animate={show ? { opacity: 1 } : {}}
        transition={{ duration: 0.6 }}
      >
        {step.number}
      </motion.span>

      <div className="relative z-10">
        {/* Title */}
        <motion.h3
          className="font-display text-[clamp(1.75rem,8vw,2.5rem)] leading-tight tracking-tight text-ink text-balance"
          initial={{ opacity: 0, y: 16, filter: "blur(8px)" }}
          animate={show ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
          transition={{ delay: 0.1, duration: 0.7, ease }}
        >
          {step.title}
        </motion.h3>

        {/* Micro */}
        <motion.p
          className="mt-2 font-body text-sm leading-snug text-ink-light/50 text-pretty"
          initial={{ opacity: 0 }}
          animate={show ? { opacity: 1 } : {}}
          transition={{ delay: 0.45, duration: 0.5 }}
        >
          {step.micro}
        </motion.p>
      </div>
    </div>
  );
}

export function HowItWorks() {
  const sectionRef = useRef<HTMLElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.35 });

  return (
    <section ref={sectionRef} className="flex min-h-dvh flex-col justify-center px-6 py-16">
      <motion.p
        initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
        animate={isInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
        transition={{ duration: 0.6, ease }}
        className="font-display italic text-2xl text-sage/70 text-balance"
      >
        How it works
      </motion.p>

      <div className="mt-8 flex flex-col gap-2">
        {STEPS.map((step, i) => (
          <StepRow key={step.number} step={step} delay={i * 280} isParentInView={isInView} />
        ))}
      </div>
    </section>
  );
}
