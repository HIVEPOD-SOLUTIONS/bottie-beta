"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

const SPINNER_FRAMES = ["✦", "✧", "✶", "✷", "✸", "✹", "✺", "✻"];

const BLUVFI_PHRASES = [
  "Checking bills",
  "Crunching numbers",
  "Looking up prices",
  "Reviewing portfolio",
  "Fetching market data",
  "Analyzing options",
  "Looking things up",
  "Working on it",
];

export function ThinkingIndicator() {
  const [frameIndex, setFrameIndex] = useState(0);
  const [phraseIndex, setPhraseIndex] = useState(
    Math.floor(Math.random() * BLUVFI_PHRASES.length),
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 100);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % BLUVFI_PHRASES.length);
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.3 }}
      className="my-1.5 flex items-center gap-2"
    >
      <span className="font-mono text-lg text-sage">
        {SPINNER_FRAMES[frameIndex]}
      </span>

      <AnimatePresence mode="wait">
        <motion.span
          key={phraseIndex}
          initial={{ opacity: 0, x: -5 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 5 }}
          transition={{ duration: 0.3 }}
          className="font-body text-xs text-sage"
        >
          {BLUVFI_PHRASES[phraseIndex]}...
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}
