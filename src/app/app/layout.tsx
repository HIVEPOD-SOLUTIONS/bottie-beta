"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChatProvider, useChatSheet } from "@/contexts/chat-context";
import { DemoStateProvider } from "@/contexts/demo-state-context";
import { GoalsProvider } from "@/contexts/goals-context";
import { ChatSheet } from "@/components/chat/chat-sheet";
import { useVoiceRecorder } from "@/hooks/use-voice-recorder";
import { useWalletBootstrap } from "@/hooks/use-wallet-bootstrap";
import { VoiceWaveform } from "@/components/chat/voice-waveform";
import {
  SettingsSidebar,
  ScreenStackWrapper,
} from "@/components/dashboard/settings-sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { ready, authenticated } = usePrivy();
  const router = useRouter();

  useEffect(() => {
    if (ready && !authenticated) {
      router.push("/");
    }
  }, [ready, authenticated, router]);

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-cream-dark">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-sage border-t-transparent" />
      </div>
    );
  }

  if (!authenticated) return null;

  return (
    <DemoStateProvider>
      <ChatProvider>
        <GoalsProvider value={{ goals: {}, refetch: async () => {} }}>
          <AppShell>{children}</AppShell>
        </GoalsProvider>
      </ChatProvider>
    </DemoStateProvider>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const { isOpen, sidebarOpen, openSidebar, closeSidebar } = useChatSheet();
  const walletBootstrap = useWalletBootstrap();

  // Lock body scroll when chat sheet or sidebar is open
  useEffect(() => {
    if (isOpen || sidebarOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen, sidebarOpen]);

  return (
    <div className="relative min-h-dvh bg-cream-dark">
      {/* Sidebar */}
      <SettingsSidebar
        open={sidebarOpen}
        onClose={closeSidebar}
      />

      {/* Main content */}
      <ScreenStackWrapper open={sidebarOpen} onOpen={openSidebar} onClose={closeSidebar}>
        <div className="flex min-h-dvh flex-col bg-cream-dark">
          <main className="flex-1 overflow-y-auto pb-20">{children}</main>
        </div>
      </ScreenStackWrapper>

      {/* Chat panel */}
      <ChatSheet visible={isOpen} />

      {!sidebarOpen && <WalletBootstrapStrip walletBootstrap={walletBootstrap} />}

      {/* Input bar */}
      {!sidebarOpen && <ChatInputBar />}
    </div>
  );
}

function WalletBootstrapStrip({
  walletBootstrap,
}: {
  walletBootstrap: ReturnType<typeof useWalletBootstrap>;
}) {
  if (!walletBootstrap.missingWallet || walletBootstrap.status === "ready") return null;

  const isError = walletBootstrap.status === "error";
  const isCreating = walletBootstrap.status === "creating";
  const label = isError ? "Wallet creation needs a retry" : isCreating ? "Creating your wallet" : "Create your wallet";

  return (
    <div className="fixed inset-x-0 bottom-[96px] z-[55] px-4">
      <div className="mx-auto flex max-w-lg items-center justify-between gap-3 rounded-xl border border-[#8FAE82]/30 bg-[#1B1C19]/95 px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.22)] backdrop-blur lg:max-w-3xl">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-[#F2F0E8]">{label}</p>
          {isError && walletBootstrap.error && (
            <p className="mt-0.5 truncate text-xs text-[#A7A79A]">{walletBootstrap.error}</p>
          )}
        </div>
        {isCreating ? (
          <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-[#8FAE82] border-t-transparent" />
        ) : (
          <button
            type="button"
            onClick={walletBootstrap.createMissingWallets}
            className="shrink-0 rounded-lg bg-[#8FAE82] px-3 py-1.5 text-xs font-semibold text-[#141513]"
          >
            {isError ? "Retry" : "Create"}
          </button>
        )}
      </div>
    </div>
  );
}

const morphEase = [0.16, 1, 0.3, 1] as const;
const morphProps = {
  initial: { opacity: 0, scale: 0.97 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.97 },
  transition: { duration: 0.2, ease: morphEase },
};
const iconMorphProps = (dir: 1 | -1) => ({
  initial: { opacity: 0, scale: 0.6, rotate: dir * 90 },
  animate: { opacity: 1, scale: 1, rotate: 0 },
  exit: { opacity: 0, scale: 0.6, rotate: dir * -90 },
  transition: { duration: 0.15, ease: morphEase },
});

const MicIcon = ({ className = "text-sage" }: { className?: string }) => (
  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M8 1a2.5 2.5 0 00-2.5 2.5v4a2.5 2.5 0 005 0v-4A2.5 2.5 0 008 1z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 7.5a4 4 0 01-8 0M8 12.5v2M6.5 14.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ArrowIcon = () => (
  <svg width="20" height="20" viewBox="0 0 16 16" fill="none" className="text-sage">
    <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const PILL_INNER = "flex h-[66px] w-full items-center px-5";

function ChatInputBar() {
  const { open, isOpen, activeSheet, chatInput, setChatInput, sendMessage, isStreaming } = useChatSheet();
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    isRecording, isTranscribing, setIsTranscribing,
    error: voiceError, analyserNode,
    startRecording, stopRecording, cancelRecording, clearError,
  } = useVoiceRecorder();

  const IDLE_LABELS: Record<NonNullable<typeof activeSheet>["type"], string> = {
    deposit: "Deposit",
    withdraw: "Withdraw",
    swap: "Confirm",
    goal: "Save goal",
  };
  const stepLabel = activeSheet
    ? activeSheet.step === "idle"
      ? IDLE_LABELS[activeSheet.type]
      : activeSheet.step === "processing"
        ? "Processing..."
        : activeSheet.step === "success"
          ? "Done!"
          : "Try again"
    : null;
  const stepBg = activeSheet?.step === "error" ? "bg-fail" : "bg-sage";
  const isActionDisabled = activeSheet?.step === "processing" || activeSheet?.step === "success";

  useEffect(() => {
    if (isOpen && !activeSheet && !isRecording) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen, activeSheet, isRecording]);

  useEffect(() => {
    if (voiceError) {
      const t = setTimeout(clearError, 3000);
      return () => clearTimeout(t);
    }
  }, [voiceError, clearError]);

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (chatInput.trim() && !isStreaming) sendMessage(chatInput);
  };

  const handleMicTap = async () => {
    if (isRecording) {
      const blob = await stopRecording();
      if (!blob) return;
      setIsTranscribing(true);
      try {
        const formData = new FormData();
        formData.append("audio", blob, `voice.${blob.type.includes("mp4") ? "mp4" : "webm"}`);
        const res = await fetch("/api/voice/transcribe", { method: "POST", body: formData });
        if (!res.ok) throw new Error("Transcription failed");
        const { text } = await res.json();
        if (text?.trim()) {
          sendMessage(text.trim());
          if (!isOpen) open();
        }
      } catch {
        // Silently fail
      } finally {
        setIsTranscribing(false);
      }
    } else {
      startRecording();
    }
  };

  const mode = activeSheet ? "action"
    : isRecording ? "recording"
    : isTranscribing ? "transcribing"
    : isOpen ? "chat"
    : "idle";

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] px-4 pb-[max(env(safe-area-inset-bottom),20px)] pt-3">
      <div className="mx-auto max-w-lg lg:max-w-3xl">
        <div className="overflow-hidden rounded-full border border-border/60 bg-cream/70 shadow-[0_1px_8px_rgba(0,0,0,0.06)] backdrop-blur-xl transition-colors duration-300">
          <AnimatePresence mode="wait" initial={false}>

            {mode === "action" && activeSheet && (
              <motion.div key="action" {...morphProps} className={`${PILL_INNER} justify-between`}>
                <button
                  onClick={activeSheet.onCancel}
                  disabled={activeSheet.step === "processing"}
                  className="font-body text-sm text-ink-light transition-opacity disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={activeSheet.onConfirm}
                  disabled={isActionDisabled}
                  className={`rounded-full ${stepBg} px-6 py-2 font-body text-sm text-cream transition-all duration-200 disabled:opacity-70 ${
                    activeSheet.step === "processing" ? "animate-pulse" : ""
                  }`}
                >
                  {stepLabel}
                </button>
              </motion.div>
            )}

            {mode === "recording" && (
              <motion.div key="recording" {...morphProps} className={`${PILL_INNER} gap-3`}>
                <button onClick={cancelRecording} className="rounded-full p-1 text-ink-light/60 transition-opacity hover:text-ink">
                  <CloseIcon />
                </button>
                <div className="flex-1">
                  <VoiceWaveform analyserNode={analyserNode} isRecording={isRecording} />
                </div>
                <button onClick={handleMicTap} className="rounded-full bg-sage p-1.5 text-cream transition-transform duration-200 active:scale-90">
                  <ArrowIcon />
                </button>
              </motion.div>
            )}

            {mode === "transcribing" && (
              <motion.div key="transcribing" {...morphProps} className={`${PILL_INNER} justify-center`}>
                <span className="animate-pulse font-body text-sm text-sage">Transcribing...</span>
              </motion.div>
            )}

            {mode === "chat" && (
              <motion.form key="chat" {...morphProps} onSubmit={handleChatSubmit} className={`${PILL_INNER} gap-3`}>
                <input
                  ref={inputRef}
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={voiceError ? "Mic unavailable — type instead" : "Ask Bluvfi anything…"}
                  className="flex-1 bg-transparent font-body text-sm text-ink outline-none placeholder:text-ink-light/40"
                />
                <AnimatePresence mode="wait" initial={false}>
                  {chatInput.trim() ? (
                    <motion.button key="send" type="submit" disabled={isStreaming} {...iconMorphProps(-1)} className="rounded-full p-1 disabled:opacity-30">
                      <ArrowIcon />
                    </motion.button>
                  ) : (
                    <motion.button key="mic" type="button" onClick={handleMicTap} disabled={isStreaming} {...iconMorphProps(1)} className="rounded-full p-1 disabled:opacity-30">
                      <MicIcon />
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.form>
            )}

            {mode === "idle" && (
              <motion.div key="idle" {...morphProps} className={`${PILL_INNER} gap-3`}>
                <button onClick={() => open()} className="flex-1 text-left font-body text-sm text-ink-light/50">
                  Ask Bluvfi anything…
                </button>
                <button onClick={handleMicTap} className="rounded-full p-1">
                  <MicIcon className="text-ink-light/30" />
                </button>
              </motion.div>
            )}

          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
