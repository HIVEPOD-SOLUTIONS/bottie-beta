"use client";

import { usePrivy } from "@privy-io/react-auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const PENDING_KEY = "bluvfi:pending-redirect";

export function useHandleLogin() {
  const router = useRouter();
  const { ready, authenticated, login } = usePrivy();

  useEffect(() => {
    if (ready && authenticated && localStorage.getItem(PENDING_KEY)) {
      localStorage.removeItem(PENDING_KEY);
      router.push("/app");
    }
  }, [ready, authenticated, router]);

  const handleLogin = () => {
    if (authenticated) {
      router.push("/app");
      return;
    }
    localStorage.setItem(PENDING_KEY, "1");
    login();
  };

  return handleLogin;
}
