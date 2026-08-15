"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

interface LoadingScreenProps {
  progress: number; // 0–100
  onExit?: () => void;
  skipEntry?: boolean;
}

export function LoadingScreen({ progress, onExit, skipEntry = false }: LoadingScreenProps) {
  const [exiting, setExiting] = useState(false);
  const onExitRef = useRef(onExit);
  useEffect(() => { onExitRef.current = onExit; });

  useEffect(() => {
    if (progress >= 100 && !exiting) {
      const t1 = setTimeout(() => setExiting(true), 200);
      const t2 = setTimeout(() => onExitRef.current?.(), 200 + 450);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [progress, exiting]);

  const entryInitial = skipEntry
    ? { opacity: 1, y: 0, filter: "blur(0px)", scale: 1 }
    : { opacity: 0, y: 16, filter: "blur(8px)" };

  const exitTarget = { opacity: 1, y: -8, scale: 1.08, filter: "blur(10px)" };
  const visibleTarget = { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" };

  return (
    <motion.div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-cream"
      initial={{ opacity: 1 }}
      animate={{ opacity: exiting ? 0 : 1 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      <motion.img
        src="/Bluvfiv2.jpg"
        alt="Bluvfi"
        className="h-28 w-28 rounded-full object-cover"
        initial={entryInitial}
        animate={exiting ? exitTarget : visibleTarget}
        transition={
          exiting
            ? { duration: 0.45, ease: [0.16, 1, 0.3, 1] }
            : { type: "spring", stiffness: 80, damping: 20 }
        }
      />

      {/* Progress bar — upgraded */}
      <div className="fixed bottom-0 left-0 right-0 h-[3px]">
        <div
          className="h-full rounded-full bg-sage/60 transition-[width] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
          style={{ width: `${progress}%` }}
        />
      </div>
    </motion.div>
  );
}
