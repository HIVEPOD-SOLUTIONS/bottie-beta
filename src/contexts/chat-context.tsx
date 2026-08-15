"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
export interface ActiveSheet {
  type: "deposit" | "withdraw" | "swap" | "goal";
  onConfirm: () => void;
  onCancel: () => void;
  step: "idle" | "processing" | "success" | "error";
}

// Generic financial context data passed to AI
export interface FinancialData {
  totalBillsDueUsd?: number;
  portfolioValueUsd?: number;
  billCount?: number;
  walletBalanceUsd?: number;
  totalSavingsUsd?: number;
  hasPositions?: boolean;
  // Stablecoin balances — kept in sync with the dashboard's useStablecoinBalances hook
  evmUsdc?: number;
  evmUsdt?: number;
  solUsdc?: number;
  solUsdt?: number;
}

interface ChatContextType {
  isOpen: boolean;
  open: (prefill?: string) => void;
  close: () => void;
  prefill: string | null;
  clearPrefill: () => void;
  dashboardData: FinancialData | null;
  registerDashboardData: (data: FinancialData) => void;
  sidebarOpen: boolean;
  openSidebar: () => void;
  closeSidebar: () => void;
  activeSheet: ActiveSheet | null;
  setActiveSheet: React.Dispatch<React.SetStateAction<ActiveSheet | null>>;
  chatInput: string;
  setChatInput: (v: string) => void;
  sendMessage: (text: string) => void;
  registerSendMessage: (fn: (text: string) => void) => void;
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
}

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeSheet, setActiveSheet] = useState<ActiveSheet | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const dataRef = useRef<FinancialData | null>(null);
  const sendRef = useRef<((text: string) => void) | null>(null);

  const open = useCallback((msg?: string) => {
    if (msg) setPrefill(msg);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);
  const clearPrefill = useCallback(() => setPrefill(null), []);
  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  const registerDashboardData = useCallback((data: FinancialData) => {
    dataRef.current = data;
  }, []);

  const registerSendMessage = useCallback((fn: (text: string) => void) => {
    sendRef.current = fn;
  }, []);

  const sendMessage = useCallback((text: string) => {
    if (sendRef.current && text.trim()) {
      sendRef.current(text);
    }
  }, []);

  return (
    <ChatContext.Provider
      value={{
        isOpen,
        open,
        close,
        prefill,
        clearPrefill,
        get dashboardData() {
          return dataRef.current;
        },
        registerDashboardData,
        sidebarOpen,
        openSidebar,
        closeSidebar,
        activeSheet,
        setActiveSheet,
        chatInput,
        setChatInput,
        sendMessage,
        registerSendMessage,
        isStreaming,
        setIsStreaming,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChatSheet() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatSheet must be used within ChatProvider");
  return ctx;
}
