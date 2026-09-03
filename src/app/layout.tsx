import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Source_Serif_4, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/providers";
import { CapacitorFetchPatch } from "@/components/capacitor-fetch-patch";
import { AppUrlListener } from "@/components/app-url-listener";
import "./globals.css";

const instrumentSerif = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
});

const sourceSerif4 = Source_Serif_4({
  weight: ["300", "400", "600", "700"],
  subsets: ["latin"],
  variable: "--font-source-serif-4",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Bluvfi — Your AI Finance Assistant",
  description:
    "Pay bills, invest in assets, and manage your finances with an AI assistant. Powered by Circle and Arc.",
  manifest: "/manifest.json",
  icons: {
    icon: "/Bluvfiv2.jpg",
    apple: "/Bluvfiv2.jpg",
  },
  openGraph: {
    title: "Bluvfi — Your AI Finance Assistant",
    description: "Pay bills, invest in assets, and manage your finances with an AI assistant.",
    type: "website",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Bluvfi",
  },
};

export const viewport: Viewport = {
  themeColor: "#141513",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${instrumentSerif.variable} ${sourceSerif4.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <CapacitorFetchPatch />
        <AppUrlListener />
        <Providers>{children}</Providers>
        {/* Desktop blocker — mobile only app */}
        <div className="pointer-events-none fixed inset-0 z-[9999] hidden flex-col items-center justify-center gap-4 bg-cream md:flex">
          <img src="/Bluvfiv2.jpg" alt="Bluvfi" className="h-24 w-24 rounded-full object-cover" />
          <p className="font-body text-base text-ink-light">designed for mobile — open on your phone</p>
        </div>
      </body>
    </html>
  );
}
