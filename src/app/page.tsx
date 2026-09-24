"use client";

import { useEffect, useState } from "react";
import { LandingStack } from "@/components/landing/landing-stack";
import { OnboardingScreen } from "@/components/onboarding/onboarding-screen";
import { isCapacitorApp } from "@/hooks/use-admob";

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
