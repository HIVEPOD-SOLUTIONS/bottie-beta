"use client";

import { useEffect, useState } from "react";
import { LandingStack } from "@/components/landing/landing-stack";
import { OnboardingScreen } from "@/components/onboarding/onboarding-screen";

function isCapacitorApp() {
  if (typeof window === "undefined") return false;
  return (
    !!(window as unknown as { Capacitor?: unknown }).Capacitor ||
    window.location.protocol === "capacitor:"
  );
}

export default function LandingPage() {
  const [isMobile, setIsMobile] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setIsMobile(isCapacitorApp());
    setReady(true);
  }, []);

  if (!ready) return null;

  if (isMobile) {
    return <OnboardingScreen />;
  }

  return (
    <main className="relative overflow-hidden">
      <LandingStack />
    </main>
  );
}
