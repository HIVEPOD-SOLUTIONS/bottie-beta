"use client";

import { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useHandleLogin } from "@/hooks/use-handle-login";
import { isCapacitorApp } from "@/hooks/use-admob";
import { DEMO_EMAIL, DEMO_OTP_HINT, enterDemoMode } from "@/lib/demo-mode";

async function openUrl(url: string) {
  if (isCapacitorApp()) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

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

/* ── Demo login screens ───────────────────────────────────── */
function DemoEmailScreen({ onBack, onNext }: { onBack: () => void; onNext: (email: string) => void }) {
  const [email, setEmail] = useState(DEMO_EMAIL);
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email.trim().toLowerCase() !== DEMO_EMAIL) {
      setError(`Please use ${DEMO_EMAIL} for demo access.`);
      return;
    }
    onNext(email.trim().toLowerCase());
  };

  return (
    <motion.div
      key="demo-email"
      initial={{ x: 60, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -60, opacity: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 32 }}
      className="flex flex-col flex-1 px-8"
    >
      <button onClick={onBack} className="self-start mb-8 -ml-1 p-1 text-ink/40 active:text-ink/70">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <h2 className="font-display text-2xl font-bold text-ink mb-2" style={{ letterSpacing: "-0.03em" }}>
        Sign in to Bluvfi
      </h2>
      <p className="font-body text-sm mb-8" style={{ color: "var(--color-ink-light)" }}>
        Enter your email address to receive a one-time code.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="block font-body text-xs font-medium mb-1.5" style={{ color: "var(--color-ink-light)" }}>
            Email address
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(""); }}
            className="w-full rounded-2xl border px-4 py-3.5 font-body text-sm outline-none transition-colors"
            style={{
              background: "var(--color-cream)",
              borderColor: error ? "#E05252" : "rgba(20,21,15,0.14)",
              color: "var(--color-ink)",
            }}
            placeholder="you@example.com"
            autoComplete="email"
            inputMode="email"
          />
          {error && <p className="mt-1.5 font-body text-xs text-red-500">{error}</p>}
        </div>

        <div className="rounded-xl px-4 py-3 font-body text-xs" style={{ background: "rgba(143,174,130,0.1)", color: "var(--color-ink-light)" }}>
          🔍 <strong style={{ color: "var(--color-ink)" }}>Demo account</strong> — use{" "}
          <span className="font-mono" style={{ color: "var(--color-ink)" }}>{DEMO_EMAIL}</span> to explore the app.
        </div>

        <motion.button
          whileTap={{ scale: 0.97 }}
          type="submit"
          className="mt-2 w-full rounded-full py-4 font-body font-semibold text-base"
          style={{ background: "var(--color-sage)", color: "var(--color-cream)" }}
        >
          Send Code
        </motion.button>
      </form>
    </motion.div>
  );
}

function DemoOtpScreen({ email, onBack, onVerify }: { email: string; onBack: () => void; onVerify: () => void }) {
  const [otp, setOtp] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (otp.replace(/\D/g, "").length < 6) {
      setError("Enter the 6-digit code.");
      return;
    }
    onVerify();
  };

  return (
    <motion.div
      key="demo-otp"
      initial={{ x: 60, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: -60, opacity: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 32 }}
      className="flex flex-col flex-1 px-8"
    >
      <button onClick={onBack} className="self-start mb-8 -ml-1 p-1 text-ink/40 active:text-ink/70">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: "rgba(143,174,130,0.15)" }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" stroke="var(--color-sage)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
          <polyline points="22,6 12,13 2,6" stroke="var(--color-sage)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      <h2 className="font-display text-2xl font-bold text-ink mb-2" style={{ letterSpacing: "-0.03em" }}>
        Check your email
      </h2>
      <p className="font-body text-sm mb-2" style={{ color: "var(--color-ink-light)" }}>
        We sent a 6-digit code to
      </p>
      <p className="font-body text-sm font-semibold text-ink mb-6">{email}</p>

      <div className="mb-6 flex items-center gap-2 rounded-xl px-4 py-3 font-body text-sm" style={{ background: "rgba(201,168,76,0.1)", border: "1px solid rgba(201,168,76,0.25)" }}>
        <span>🔑</span>
        <span style={{ color: "var(--color-ink-light)" }}>
          Demo code:{" "}
          <strong className="font-mono" style={{ color: "var(--color-ink)", letterSpacing: "0.15em" }}>
            {DEMO_OTP_HINT}
          </strong>
        </span>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="block font-body text-xs font-medium mb-1.5" style={{ color: "var(--color-ink-light)" }}>
            6-digit code
          </label>
          <input
            type="text"
            inputMode="numeric"
            pattern="\d*"
            maxLength={6}
            value={otp}
            onChange={(e) => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
            className="w-full rounded-2xl border px-4 py-3.5 font-mono text-xl tracking-[0.25em] text-center outline-none transition-colors"
            style={{
              background: "var(--color-cream)",
              borderColor: error ? "#E05252" : "rgba(20,21,15,0.14)",
              color: "var(--color-ink)",
            }}
            placeholder="• • • • • •"
            autoComplete="one-time-code"
            autoFocus
          />
          {error && <p className="mt-1.5 font-body text-xs text-red-500">{error}</p>}
        </div>

        <motion.button
          whileTap={{ scale: 0.97 }}
          type="submit"
          className="mt-2 w-full rounded-full py-4 font-body font-semibold text-base disabled:opacity-50"
          style={{ background: "var(--color-sage)", color: "var(--color-cream)" }}
          disabled={otp.length < 6}
        >
          Verify &amp; Continue
        </motion.button>
      </form>
    </motion.div>
  );
}

/* ── Main component ───────────────────────────────────────── */
export function OnboardingScreen() {
  const [slide, setSlide] = useState(0);
  const [direction, setDirection] = useState(1);
  const [demoStep, setDemoStep] = useState<"slides" | "email" | "otp">("slides");
  const [demoEmail, setDemoEmail] = useState("");
  const handleLogin = useHandleLogin();
  const router = useRouter();

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

  // Demo mode handlers
  const handleDemoAccess = useCallback(() => setDemoStep("email"), []);
  const handleDemoEmailNext = useCallback((email: string) => {
    setDemoEmail(email);
    setDemoStep("otp");
  }, []);
  const handleDemoOtpVerify = useCallback(() => {
    enterDemoMode();
    router.push("/app");
  }, [router]);
  const handleDemoBack = useCallback(() => {
    if (demoStep === "otp") setDemoStep("email");
    else setDemoStep("slides");
  }, [demoStep]);

  return (
    <div
      className="relative flex flex-col overflow-hidden"
      style={{
        height: "100dvh",
        background: "var(--color-cream)",
        userSelect: "none",
      }}
      onTouchStart={demoStep === "slides" ? onTouchStart : undefined}
      onTouchEnd={demoStep === "slides" ? onTouchEnd : undefined}
    >
      <AnimatePresence mode="wait">
        {demoStep === "email" && (
          <motion.div key="demo-email-wrap" className="flex flex-col flex-1 pt-16" style={{ height: "100dvh" }}>
            <DemoEmailScreen onBack={handleDemoBack} onNext={handleDemoEmailNext} />
          </motion.div>
        )}

        {demoStep === "otp" && (
          <motion.div key="demo-otp-wrap" className="flex flex-col flex-1 pt-16" style={{ height: "100dvh" }}>
            <DemoOtpScreen email={demoEmail} onBack={handleDemoBack} onVerify={handleDemoOtpVerify} />
          </motion.div>
        )}

        {demoStep === "slides" && (
          <motion.div key="slides-wrap" className="flex flex-col" style={{ height: "100dvh" }}>
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
                <>
                  <p className="text-xs text-center" style={{ color: "var(--color-ink-light)" }}>
                    By continuing you agree to our{" "}
                    <button
                      onClick={() => openUrl("https://waitlist.bluvfi.xyz/terms")}
                      className="underline underline-offset-2"
                    >Terms</button>
                    {" "}and{" "}
                    <button
                      onClick={() => openUrl("https://waitlist.bluvfi.xyz/privacy")}
                      className="underline underline-offset-2"
                    >Privacy Policy</button>
                  </p>
                  <button
                    onClick={handleDemoAccess}
                    className="font-body text-xs rounded-full px-4 py-2 active:opacity-60"
                    style={{
                      color: "var(--color-ink-light)",
                      border: "1px solid rgba(143,174,130,0.35)",
                      background: "rgba(143,174,130,0.06)",
                    }}
                  >
                    Demo access →
                  </button>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
