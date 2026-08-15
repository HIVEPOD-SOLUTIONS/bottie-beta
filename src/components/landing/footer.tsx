"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { useHandleLogin } from "@/hooks/use-handle-login";

const ease = [0.16, 1, 0.3, 1] as [number, number, number, number];

export function Footer() {
  const handleLogin = useHandleLogin();
  const sectionRef = useRef<HTMLElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.35 });

  return (
    <footer
      ref={sectionRef}
      className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-16"
    >
      {/* Content */}
      <div className="relative z-10 flex flex-col items-center gap-10 text-center">
        {/* Two-part statement */}
        <div>
          <motion.p
            initial={{ opacity: 0, y: 20, filter: "blur(8px)" }}
            animate={isInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
            transition={{ duration: 0.7, ease }}
            className="font-display italic text-2xl text-sage/70"
          >
            Your money deserves better.
          </motion.p>
          <motion.p
            initial={{ opacity: 0, y: 20, filter: "blur(8px)" }}
            animate={isInView ? { opacity: 1, y: 0, filter: "blur(0px)" } : {}}
            transition={{ delay: 0.15, duration: 0.7, ease }}
            className="mt-3 font-display text-[clamp(2.5rem,11vw,3.5rem)] leading-tight tracking-tight text-ink text-balance"
          >
            Get started today.
          </motion.p>
        </div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ delay: 0.35, duration: 0.6, ease }}
        >
          <button
            onClick={handleLogin}
            className="group inline-flex items-center gap-3 rounded-full bg-sage py-2.5 pl-5 pr-2 font-body text-sm font-medium text-cream transition-[background-color,transform] duration-200 hover:bg-sage-light active:scale-[0.96]"
          >
            <span>Get started</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-cream/20 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0.5">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M2.5 7h9M8 3.5L11.5 7 8 10.5"
                  stroke="var(--color-cream)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
        </motion.div>
      </div>

      {/* Attribution — anchored to bottom */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={isInView ? { opacity: 1 } : {}}
        transition={{ delay: 0.6, duration: 0.6 }}
        className="absolute inset-x-0 bottom-8 flex flex-col items-center gap-3"
      >
        {/* Social links */}
        <div className="flex items-center gap-4">
          <a
            href="https://x.com/bluvfi"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-ink-light/50 transition-colors hover:text-ink-light/80"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.402 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.261 5.634 5.903-5.634Zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            x.com/bluvfi
          </a>
          <span className="text-ink-light/20">·</span>
          <a
            href="https://t.me/+KXpDSUAnfg44MTg0"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-ink-light/50 transition-colors hover:text-ink-light/80"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c-.242-.213-.054-.333-.373-.12L7.26 14.426l-2.965-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.893.133z" />
            </svg>
            Telegram
          </a>
        </div>
        <span className="font-mono text-[11px] tracking-[0.1em] text-ink-light/30">
          built with Bluvfi
        </span>
      </motion.div>
    </footer>
  );
}
