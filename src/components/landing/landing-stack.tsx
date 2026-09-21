"use client";

import { useRef } from "react";
import { motion, useScroll, useTransform, MotionValue } from "framer-motion";
import { HeroSection } from "./hero";
import { TrustSignals } from "./trust-signals";
import { PartnersSection } from "./partners";
import { ValueProps } from "./value-props";
import { HowItWorks } from "./how-it-works";
import { Footer } from "./footer";

const SECTIONS = [HeroSection, TrustSignals, PartnersSection, ValueProps, HowItWorks, Footer];
const N = SECTIONS.length;

/* ── Each card tracks scroll progress and scales back as next slides in ── */

function SectionCard({
  children,
  index,
  scrollProgress,
}: {
  children: React.ReactNode;
  index: number;
  scrollProgress: MotionValue<number>;
}) {
  const isLast = index === N - 1;

  // This section occupies [index/(N-1), (index+1)/(N-1)] of total scroll range
  const start = index / (N - 1);
  const end = Math.min((index + 1) / (N - 1), 1);

  // Scale back from 1 → 0.88 as the next section scrolls over this one
  const scale = useTransform(scrollProgress, [start, end], [1, 0.88]);
  // Slight darken so it feels pushed back into the deck
  const opacity = useTransform(scrollProgress, [start, end], [1, 0.65]);

  return (
    <div className="snap-start" style={{ height: "100dvh" }}>
      <motion.div
        style={{
          scale: isLast ? undefined : scale,
          opacity: isLast ? undefined : opacity,
          height: "100%",
          overflow: "hidden",
          backgroundColor: "var(--color-cream)",
          transformOrigin: "50% 30%",
        }}
      >
        {children}
      </motion.div>
    </div>
  );
}

/* ── Main stack ──────────────────────────────────────────── */

export function LandingStack() {
  const containerRef = useRef<HTMLDivElement>(null);

  const { scrollYProgress } = useScroll({ container: containerRef });

  return (
    <div
      ref={containerRef}
      style={{
        height: "100dvh",
        overflowY: "scroll",
        overflowX: "hidden",
        scrollSnapType: "y mandatory",
        background: "var(--color-cream)",
      }}
    >
      {SECTIONS.map((Section, i) => (
        <SectionCard key={i} index={i} scrollProgress={scrollYProgress}>
          <Section />
        </SectionCard>
      ))}
    </div>
  );
}
