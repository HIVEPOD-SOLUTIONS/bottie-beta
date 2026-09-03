"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { SmartWalletsProvider } from "@privy-io/react-auth/smart-wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "@privy-io/wagmi";
import { useState } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { privyConfig } from "@/lib/privy";

// After Google OAuth, Privy redirects here. Android App Links intercepts the
// HTTPS URL and opens the Capacitor app. AppUrlListener then appends the
// OAuth params to the WebView URL for PrivyProvider to exchange automatically.
const CAPACITOR_OAUTH_REDIRECT_URL = "https://bluvfi.xyz";

function getOAuthRedirectUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Capacitor?: unknown }).Capacitor
    ? CAPACITOR_OAUTH_REDIRECT_URL
    : undefined;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  const [customOAuthRedirectUrl] = useState<string | undefined>(getOAuthRedirectUrl);

  const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!privyAppId) return <>{children}</>;

  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        ...privyConfig,
        ...(customOAuthRedirectUrl ? { customOAuthRedirectUrl } : {}),
      }}
    >
      <SmartWalletsProvider>
        <QueryClientProvider client={queryClient}>
          <WagmiProvider config={wagmiConfig}>
            {children}
          </WagmiProvider>
        </QueryClientProvider>
      </SmartWalletsProvider>
    </PrivyProvider>
  );
}
