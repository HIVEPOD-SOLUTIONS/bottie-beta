"use client";

import { useLogin, usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";

const PENDING_KEY = "bluvfi:pending-redirect";

export function useHandleLogin() {
  const router = useRouter();
  const { ready, authenticated } = usePrivy();
  const { login } = useLogin({
    onComplete: () => {
      localStorage.removeItem(PENDING_KEY);
      router.push("/app");
    },
    onError: (error) => {
      localStorage.removeItem(PENDING_KEY);
      console.warn("[auth] Login did not complete", {
        error: String(error),
      });
    },
  });

  const handleLogin = () => {
    if (!ready) return;
    if (authenticated) {
      router.push("/app");
      return;
    }
    localStorage.setItem(PENDING_KEY, "1");
    login();
  };

  return handleLogin;
}
