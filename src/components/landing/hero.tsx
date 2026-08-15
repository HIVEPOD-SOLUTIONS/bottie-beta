"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useHandleLogin } from "@/hooks/use-handle-login";

/* ── Prompts ──────────────────────────────────────────────── */
const PROMPTS = [
  "Pay my Netflix and Spotify bills",
  "Buy 2 shares of Apple",
  "What's my portfolio worth?",
];

/* ── Cursor SVG ───────────────────────────────────────────── */
function CursorIcon() {
  return (
    <svg width="18" height="22" viewBox="0 0 18 22" fill="none" aria-hidden="true">
      <path
        d="M2 2L16 10.5L10.5 12L8 18L2 2Z"
        fill="var(--color-ink)"
        stroke="var(--color-cream)"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ── Typewriter chat content ──────────────────────────────── */
type TypePhase = "typing" | "paused" | "fading";

const TypewriterContent = memo(function TypewriterContent({
  onDone,
}: {
  onDone: () => void;
}) {
  const [promptIdx, setPromptIdx] = useState(0);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<TypePhase>("typing");
  const [textVisible, setTextVisible] = useState(true);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    const prompt = PROMPTS[promptIdx];
    const clear = () => { if (t.current) clearTimeout(t.current); };

    if (phase === "typing") {
      if (text.length < prompt.length) {
        t.current = setTimeout(
          () => setText(prompt.slice(0, text.length + 1)),
          46 + Math.random() * 36,
        );
      } else {
        t.current = setTimeout(() => setPhase("paused"), 1500);
      }
    } else if (phase === "paused") {
      t.current = setTimeout(() => { setTextVisible(false); setPhase("fading"); }, 200);
    } else if (phase === "fading") {
      const next = (promptIdx + 1) % PROMPTS.length;
      t.current = setTimeout(() => {
        if (next === 0) { done.current = true; onDone(); return; }
        setText(""); setPromptIdx(next); setTextVisible(true); setPhase("typing");
      }, 360);
    }

    return clear;
  }, [text, phase, promptIdx, onDone]);

  const textDone = text.length === PROMPTS[promptIdx].length && phase !== "fading";

  return (
    <div className="flex w-full items-center gap-3">
      <div className="flex flex-1 items-center overflow-hidden">
        <span
          className="truncate font-body text-sm text-ink transition-opacity duration-300"
          style={{ opacity: textVisible ? 1 : 0 }}
        >
          {text ? (
            <>
              {text}
              {phase === "typing" && (
                <motion.span
                  className="ml-[1px] inline-block h-[0.8em] w-[1.5px] translate-y-[1px] bg-ink align-middle"
                  animate={{ opacity: [1, 1, 0, 0] }}
                  transition={{ duration: 0.85, repeat: Infinity, times: [0, 0.5, 0.5, 1] }}
                />
              )}
            </>
          ) : (
            <span className="text-ink-light/40">anything...</span>
          )}
        </span>
      </div>
      <motion.div
        animate={{ scale: textDone ? 1 : 0.75, opacity: textDone ? 1 : 0.2 }}
        transition={{ type: "spring", stiffness: 400, damping: 28, bounce: 0 }}
        className="flex h-8 w-8 flex-none items-center justify-center rounded-full"
        style={{ background: textDone ? "var(--color-sage)" : "var(--color-border)" }}
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M2.5 7h9M8 3.5L11.5 7 8 10.5"
            stroke={textDone ? "var(--color-cream)" : "var(--color-ink-light)"}
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </motion.div>
    </div>
  );
});

/* ── Morphing CTA ─────────────────────────────────────────── */
type CtaPhase = "button" | "cursor" | "clicking" | "chat";
interface CursorData { startX: number; startY: number; endX: number; endY: number; }

function MorphingCTA({ onLogin }: { onLogin: () => void }) {
  const [phase, setPhase] = useState<CtaPhase>("button");
  const [cursor, setCursor] = useState<CursorData | null>(null);
  const cycleKey = useRef(0);
  const pillRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const startSequence = useCallback(() => {
    requestAnimationFrame(() => {
      if (!pillRef.current || !wrapRef.current) return;
      const pr = pillRef.current.getBoundingClientRect();
      const wr = wrapRef.current.getBoundingClientRect();
      const cx = pr.left - wr.left + pr.width * 0.45 - 9;
      const cy = pr.top - wr.top + pr.height * 0.45 - 5;
      cycleKey.current += 1;
      setCursor({ startX: cx + 88, startY: cy - 28, endX: cx, endY: cy });
      setPhase("cursor");
      schedule(() => {
        setPhase("clicking");
        schedule(() => setPhase("chat"), 160);
      }, 1200);
    });
  }, [schedule]);

  useEffect(() => {
    const t = setTimeout(startSequence, 2800);
    return () => { clearTimeout(t); clearTimers(); };
  }, [startSequence, clearTimers]);

  const handleChatDone = useCallback(() => {
    setPhase("button");
    schedule(startSequence, 3000);
  }, [startSequence, schedule]);

  const isBtn = phase !== "chat";

  return (
    <div ref={wrapRef} className="relative mt-10" style={{ contain: "layout" }}>
      {/* Cursor */}
      <AnimatePresence>
        {cursor && (phase === "cursor" || phase === "clicking") && (
          <motion.div
            key={`cur-${cycleKey.current}`}
            className="pointer-events-none absolute z-10"
            initial={{ x: cursor.startX, y: cursor.startY, opacity: 0, scale: 0.7 }}
            animate={{
              x: cursor.endX, y: cursor.endY, opacity: 1,
              scale: phase === "clicking" ? 0.85 : 1,
            }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{
              x: { duration: 1.1, ease: [0.25, 0.46, 0.45, 0.94] },
              y: { duration: 1.1, ease: [0.25, 0.46, 0.45, 0.94] },
              opacity: { duration: 0.2 },
              scale: { type: "spring", stiffness: 500, damping: 22, bounce: 0 },
            }}
          >
            <CursorIcon />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Single unified pill — layout animates the width morph */}
      <motion.div
        ref={pillRef}
        layout
        animate={{ scale: phase === "clicking" ? 0.96 : 1 }}
        transition={{ layout: { type: "spring", stiffness: 180, damping: 32, bounce: 0 }, scale: { type: "spring", stiffness: 600, damping: 30 } }}
        onClick={onLogin}
        className="relative cursor-pointer overflow-hidden rounded-full"
        style={{ width: isBtn ? "fit-content" : "100%", willChange: "transform" }}
      >
        {/* Sage background (button state) */}
        <motion.div
          className="absolute inset-0 rounded-full bg-sage"
          animate={{ opacity: isBtn ? 1 : 0 }}
          transition={{ duration: 0.25 }}
        />
        {/* Cream background (chat state) */}
        <motion.div
          className="absolute inset-0 rounded-full border border-border bg-cream/70 shadow-[0_1px_8px_rgba(0,0,0,0.04)]"
          animate={{ opacity: isBtn ? 0 : 1 }}
          transition={{ duration: 0.25 }}
        />

        {/* Content — crossfade inside the pill */}
        <div className="relative z-10">
          <AnimatePresence mode="wait">
            {isBtn ? (
              <motion.div
                key="btn"
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                className="flex items-center gap-3 py-2.5 pl-5 pr-2"
              >
                <span className="font-body text-sm font-medium text-cream">Get started</span>
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-cream/20 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0.5">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M2.5 7h9M8 3.5L11.5 7 8 10.5" stroke="var(--color-cream)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </motion.div>
            ) : (
              <motion.div
                key="chat"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.15, duration: 0.25 }}
                className="px-5 py-2.5"
              >
                <TypewriterContent onDone={handleChatDone} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}

/* ── Word stagger variants ────────────────────────────────── */
const wordVariant = {
  hidden: { opacity: 0, y: 22, filter: "blur(6px)" },
  visible: {
    opacity: 1, y: 0, filter: "blur(0px)",
    transition: { duration: 0.65, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
  },
};
const WORDS = ["Your", "AI", "finance", "assistant."];

/* ── Hero ─────────────────────────────────────────────────── */
export function HeroSection() {
  const handleLogin = useHandleLogin();

  return (
    <section className="relative min-h-dvh px-6">
      {/* Mesh gradient */}
      <motion.div aria-hidden animate={{ x: [0, 28, -12, 0], y: [0, 18, -22, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: "easeInOut", repeatType: "mirror" }}
        className="pointer-events-none absolute -top-24 -left-24 h-[75vw] w-[75vw] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(143,174,130,0.28) 0%, transparent 65%)" }} />
      <motion.div aria-hidden animate={{ x: [0, -22, 14, 0], y: [0, -20, 24, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: "easeInOut", delay: 6, repeatType: "mirror" }}
        className="pointer-events-none absolute -bottom-16 -right-16 h-[65vw] w-[65vw] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(143,174,130,0.20) 0%, transparent 65%)" }} />
      <motion.div aria-hidden animate={{ x: [0, 32, -20, 0], y: [0, -28, 18, 0] }}
        transition={{ duration: 26, repeat: Infinity, ease: "easeInOut", delay: 3, repeatType: "mirror" }}
        className="pointer-events-none absolute top-1/3 -right-20 h-[50vw] w-[50vw] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(143,174,130,0.15) 0%, transparent 65%)" }} />
      <motion.div aria-hidden animate={{ x: [0, -16, 22, 0], y: [0, 26, -12, 0] }}
        transition={{ duration: 20, repeat: Infinity, ease: "easeInOut", delay: 10, repeatType: "mirror" }}
        className="pointer-events-none absolute bottom-1/3 -left-10 h-[45vw] w-[45vw] rounded-full"
        style={{ background: "radial-gradient(circle, rgba(143,174,130,0.12) 0%, transparent 65%)" }} />

      {/* Masthead */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
        className="absolute inset-x-0 top-0 flex justify-center pt-6">
        <div className="relative inline-block">
          <img src="/Bluvfiv2.jpg" alt="Bluvfi" className="h-12 w-12 rounded-full object-cover" />
          <span className="absolute -top-1 -right-6 rounded text-[9px] font-bold tracking-wide uppercase bg-violet-500/20 text-violet-400 px-1 py-px leading-none">beta</span>
        </div>
      </motion.div>

      {/* Content — fixed top offset so morph doesn't cause reflow */}
      <div className="relative z-10 pt-[38vh]">
        <motion.h1
          initial="hidden" animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } } }}
          className="font-display text-[clamp(3rem,13vw,4rem)] leading-[1.06] tracking-tight text-ink"
        >
          <span className="block">
            {WORDS.slice(0, 2).map((w) => (
              <motion.span key={w} variants={wordVariant} className="mr-[0.22em] inline-block">{w}</motion.span>
            ))}
          </span>
          <span className="block">
            {WORDS.slice(2).map((w) => (
              <motion.span key={w} variants={wordVariant} className="mr-[0.22em] inline-block">{w}</motion.span>
            ))}
          </span>
        </motion.h1>

        <motion.div
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <MorphingCTA onLogin={handleLogin} />
        </motion.div>
      </div>
    </section>
  );
}
