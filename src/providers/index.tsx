"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { SmartWalletsProvider } from "@privy-io/react-auth/smart-wallets";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "@privy-io/wagmi";
import { useState } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { privyConfig } from "@/lib/privy";

// After Google OAuth, Privy redirects here.
// - Capacitor: Android App Links intercepts this HTTPS URL and opens the app.
//   AppUrlListener then appends the OAuth params to the WebView URL for
//   PrivyProvider to exchange automatically.
// - Web: we explicitly pass window.location.origin (just the scheme+host, no
//   path or query params) so Privy never uses the full current URL — which may
//   still contain stale privy_oauth_code params from a previous login attempt,
//   causing a 401 "Redirect URL is not allowed" on the next OAuth init.
// Must be www.bluvfi.xyz — Amplify redirects the bare domain to www, and
// Android does not follow redirects during App Link verification, so only
// www.bluvfi.xyz is verified. Using www directly avoids the redirect chain.
const CAPACITOR_OAUTH_REDIRECT_URL = "https://www.bluvfi.xyz";

function getOAuthRedirectUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const isCapacitor = !!(window as unknown as { Capacitor?: unknown }).Capacitor;
  if (isCapacitor) return CAPACITOR_OAUTH_REDIRECT_URL;
  // Web: use origin only (e.g. "https://www.bluvfi.xyz") — clean, no stale params.
  // Both bluvfi.xyz and www.bluvfi.xyz are in Privy's allowed OAuth redirect URLs.
  return window.location.origin;
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
