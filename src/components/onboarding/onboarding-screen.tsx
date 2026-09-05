"use client";

import { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useHandleLogin } from "@/hooks/use-handle-login";

/* ── Slide data ───────────────────────────────────────────── */
const SLIDES = [
  {
    id: 0,
    illustration: (
      <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        {/* Phone with AI chat */}
        <rect x="55" y="30" width="90" height="140" rx="16" fill="var(--color-sage)" fillOpacity="0.15" />
        <rect x="63" y="48" width="74" height="10" rx="5" fill="var(--color-sage)" fillOpacity="0.5" />
        <rect x="63" y="66" width="50" height="8" rx="4" fill="var(--color-sage)" fillOpacity="0.35" />
        <rect x="87" y="82" width="50" height="8" rx="4" fill="var(--color-ink)" fillOpacity="0.12" />
        <rect x="63" y="98" width="56" height="8" rx="4" fill="var(--color-sage)" fillOpacity="0.35" />
        <rect x="79" y="114" width="50" height="8" rx="4" fill="var(--color-ink)" fillOpacity="0.12" />
        {/* Sparkle */}
        <circle cx="148" cy="48" r="14" fill="var(--color-sage)" fillOpacity="0.2" />
        <path d="M148 40v16M140 48h16" stroke="var(--color-sage)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="52" cy="148" r="10" fill="var(--color-sage)" fillOpacity="0.2" />
        <path d="M52 142v12M46 148h12" stroke="var(--color-sage)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
    heading: "Your AI Finance\nAssistant",
    body: "Meet Bluvfi — your personal AI that handles bills, investments, and your finances through simple conversation.",
  },
  {
    id: 1,
    illustration: (
      <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        {/* Bills + chart */}
        <rect x="30" y="70" width="65" height="80" rx="10" fill="var(--color-sage)" fillOpacity="0.15" />
        <rect x="42" y="85" width="40" height="6" rx="3" fill="var(--color-sage)" fillOpacity="0.5" />
        <rect x="42" y="98" width="28" height="5" rx="2.5" fill="var(--color-ink)" fillOpacity="0.2" />
        <rect x="42" y="110" width="34" height="5" rx="2.5" fill="var(--color-ink)" fillOpacity="0.2" />
        <rect x="42" y="122" width="22" height="5" rx="2.5" fill="var(--color-ink)" fillOpacity="0.2" />
        {/* Chart bars */}
        <rect x="108" y="100" width="16" height="50" rx="4" fill="var(--color-sage)" fillOpacity="0.3" />
        <rect x="130" y="80" width="16" height="70" rx="4" fill="var(--color-sage)" fillOpacity="0.5" />
        <rect x="152" y="60" width="16" height="90" rx="4" fill="var(--color-sage)" fillOpacity="0.7" />
        {/* Check circle */}
        <circle cx="62" cy="52" r="18" fill="var(--color-sage)" fillOpacity="0.2" />
        <path d="M53 52l6 6 10-12" stroke="var(--color-sage)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    heading: "Pay Bills &\nInvest Smarter",
    body: "Pay Netflix, Spotify, electricity and more. Buy stocks and crypto — all in one place, powered by USDC.",
  },
  {
    id: 2,
    illustration: (
      <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
        {/* Shield / security */}
        <path d="M100 30L148 52v44c0 30-20 52-48 64C72 148 52 126 52 96V52L100 30z" fill="var(--color-sage)" fillOpacity="0.15" />
        <path d="M100 44L136 60v36c0 22-15 40-36 50C79 136 64 118 64 96V60L100 44z" fill="var(--color-sage)" fillOpacity="0.25" />
        <path d="M85 99l9 9 21-21" stroke="var(--color-sage)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {/* Stars */}
        <circle cx="40" cy="60" r="5" fill="var(--color-sage)" fillOpacity="0.4" />
        <circle cx="160" cy="80" r="4" fill="var(--color-sage)" fillOpacity="0.3" />
        <circle cx="155" cy="140" r="6" fill="var(--color-sage)" fillOpacity="0.35" />
        <circle cx="42" cy="138" r="4" fill="var(--color-sage)" fillOpacity="0.3" />
      </svg>
    ),
    heading: "Secure &\nNon-Custodial",
    body: "Your keys, your money. Bluvfi never holds your funds — everything runs on your own embedded wallet.",
  },
];

/* ── Dot indicator ────────────────────────────────────────── */
function Dots({ count, active }: { count: number; active: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <motion.div
          key={i}
          animate={{ width: i === active ? 24 : 8, opacity: i === active ? 1 : 0.35 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="h-2 rounded-full bg-sage"
        />
      ))}
    </div>
  );
}

/* ── Main component ───────────────────────────────────────── */
export function OnboardingScreen() {
  const [slide, setSlide] = useState(0);
  const [direction, setDirection] = useState(1);
  const handleLogin = useHandleLogin();

  const touchStart = useRef<number | null>(null);

  const goTo = useCallback((next: number, dir?: number) => {
    setDirection(dir ?? (next > slide ? 1 : -1));
    setSlide(next);
  }, [slide]);

  const handleNext = useCallback(() => {
    if (slide < SLIDES.length - 1) {
      goTo(slide + 1, 1);
    } else {
      handleLogin();
    }
  }, [slide, goTo, handleLogin]);

  const handleSkip = useCallback(() => {
    handleLogin();
  }, [handleLogin]);

  /* Swipe handling */
  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStart.current === null) return;
    const delta = touchStart.current - e.changedTouches[0].clientX;
    if (Math.abs(delta) > 50) {
      if (delta > 0 && slide < SLIDES.length - 1) goTo(slide + 1, 1);
      if (delta < 0 && slide > 0) goTo(slide - 1, -1);
    }
    touchStart.current = null;
  };

  const variants = {
    enter: (d: number) => ({ x: d * 60, opacity: 0, scale: 0.96 }),
    center: { x: 0, opacity: 1, scale: 1 },
    exit: (d: number) => ({ x: d * -60, opacity: 0, scale: 0.96 }),
  };

  const isLast = slide === SLIDES.length - 1;

  return (
    <div
      className="relative flex flex-col overflow-hidden"
      style={{
        height: "100dvh",
        background: "var(--color-cream)",
        userSelect: "none",
      }}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {/* Skip */}
      <div className="absolute top-0 inset-x-0 flex justify-end px-6 pt-14 z-10">
        {!isLast && (
          <button
            onClick={handleSkip}
            className="text-sm font-body text-ink/40 active:text-ink/70"
          >
            Skip
          </button>
        )}
      </div>

      {/* Slides */}
      <div className="flex-1 flex flex-col items-center justify-center px-8 pb-4 overflow-hidden">
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={slide}
            custom={direction}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 300, damping: 32, mass: 0.9 }}
            className="w-full flex flex-col items-center"
          >
            {/* Illustration */}
            <div
              className="rounded-3xl flex items-center justify-center mb-10"
              style={{
                width: "min(280px, 75vw)",
                height: "min(280px, 75vw)",
                background: "var(--color-sage)",
                opacity: 1,
                backgroundColor: "rgba(143, 174, 130, 0.1)",
              }}
            >
              <div style={{ width: "70%", height: "70%" }}>
                {SLIDES[slide].illustration}
              </div>
            </div>

            {/* Text */}
            <h1
              className="font-display text-center text-ink leading-tight mb-4"
              style={{ fontSize: "clamp(1.75rem, 8vw, 2.5rem)", whiteSpace: "pre-line" }}
            >
              {SLIDES[slide].heading}
            </h1>
            <p
              className="font-body text-center leading-relaxed"
              style={{ color: "var(--color-ink-light)", fontSize: "clamp(0.9rem, 4vw, 1.05rem)", maxWidth: 300 }}
            >
              {SLIDES[slide].body}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Bottom controls */}
      <div className="px-8 pb-12 flex flex-col items-center gap-6">
        <Dots count={SLIDES.length} active={slide} />

        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={handleNext}
          className="w-full rounded-full py-4 font-body font-semibold text-base flex items-center justify-center gap-2"
          style={{
            background: "var(--color-sage)",
            color: "var(--color-cream)",
            maxWidth: 360,
          }}
        >
          {isLast ? "Get Started" : "Continue"}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </motion.button>

        {isLast && (
          <p className="text-xs text-center" style={{ color: "var(--color-ink-light)" }}>
            By continuing you agree to our{" "}
            <a
              href="https://waitlist.bluvfi.xyz/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >Terms</a>
            {" "}and{" "}
            <a
              href="https://waitlist.bluvfi.xyz/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >Privacy Policy</a>
          </p>
        )}
      </div>
    </div>
  );
}
