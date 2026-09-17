import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Source_Serif_4, JetBrains_Mono, Sora, Manrope } from "next/font/google";
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

const sora = Sora({
  weight: ["700"],
  subsets: ["latin"],
  variable: "--font-sora",
  display: "swap",
});

const manrope = Manrope({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-manrope",
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
      className={`${instrumentSerif.variable} ${sourceSerif4.variable} ${jetbrainsMono.variable} ${sora.variable} ${manrope.variable}`}
    >
      <body>
        <CapacitorFetchPatch />
        <AppUrlListener />
        <Providers>{children}</Providers>
        {/* Desktop blocker — mobile only app */}
        <div className="pointer-events-none fixed inset-0 z-[9999] hidden flex-col items-center justify-center bg-cream px-8 md:flex">
          <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
            {/* Logo */}
            <img src="/Bluvfiv2.jpg" alt="Bluvfi" className="h-16 w-16 rounded-2xl object-cover shadow-lg" />

            {/* Heading */}
            <div>
              <p className="font-display text-2xl text-ink">Bluvfi is built for mobile</p>
              <p className="mt-1.5 font-body text-sm text-ink-light">
                To preview it right here in your browser, switch to mobile view:
              </p>
            </div>

            {/* Steps */}
            <div className="w-full rounded-2xl border border-border bg-cream-dark px-5 py-4 text-left">
              <ol className="space-y-3">
                {[
                  <>Press <kbd className="rounded bg-ink/10 px-1.5 py-0.5 font-mono text-xs text-ink">F12</kbd> to open DevTools</>,
                  <>Click the <span className="font-medium text-ink">Toggle Device Toolbar</span> icon <span className="font-mono text-xs text-ink-light">(or press Ctrl+Shift+M / ⌘+Shift+M)</span></>,
                  <>Choose a phone like <span className="font-medium text-ink">iPhone 14</span> or <span className="font-medium text-ink">Pixel 7</span> from the device list</>,
                  <>Refresh the page and enjoy 🎉</>,
                ].map((step, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sage/20 font-mono text-[11px] font-semibold text-sage">
                      {i + 1}
                    </span>
                    <span className="font-body text-sm leading-snug text-ink-light">{step}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Divider */}
            <div className="flex w-full items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="font-body text-xs text-ink-light/40">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            {/* Play Store */}
            <div className="flex flex-col items-center gap-2">
              <p className="font-body text-xs text-ink-light/50">Get the full experience on Android</p>
              <a
                href="https://play.google.com/store/apps/details?id=com.bluvfi.xyz"
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-ink/10 bg-ink/5 px-4 py-2.5 transition-colors hover:bg-ink/10"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="shrink-0 text-ink/60">
                  <path d="M3.18 23.76c.37.21.8.22 1.2.03l12.5-7.03-2.67-2.67L3.18 23.76zM.5 1.5C.19 1.87 0 2.4 0 3.07v17.86c0 .67.19 1.2.5 1.57l.08.08 10-10v-.24L.58 1.42.5 1.5zm19.4 9.53-2.7-1.52-2.96 2.96 2.96 2.97 2.71-1.53c.77-.44.77-1.44-.01-1.88zM4.38.21l12.5 7.03-2.67 2.67L3.18.24C3.58.05 4.01.06 4.38.21z" />
                </svg>
                <div className="text-left">
                  <p className="font-mono text-[9px] uppercase tracking-widest text-ink/40">Get it on</p>
                  <p className="font-body text-sm font-semibold leading-tight text-ink/70">Google Play</p>
                </div>
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
