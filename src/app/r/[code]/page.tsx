import type { Metadata } from "next";
import { isReferralCode } from "@/lib/shar-rules";

/**
 * The page behind a Bluvfi referral link: https://www.bluvfi.xyz/r/<code>.
 * No account or database needed. It shows the code and a button that opens the Android app straight to it (bluvfi://ref/<code>);
 * the app keeps the code and applies it when the person creates their account. Anyone without the app can still copy the code.
 */
export const metadata: Metadata = {
  title: "Join me on Bluvfi",
  description: "Pay bills and invest with USDC, and light your own way with Shar. Use my code when you sign up.",
  robots: { index: false, follow: false },
};

export default async function ReferralPage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params;
  const code = (raw ?? "").toUpperCase();
  const valid = isReferralCode(code);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-black px-6 py-16 text-center text-white">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-white/60">A friend invited you</p>
      <h1 className="max-w-md text-3xl font-semibold leading-tight">Join me on Bluvfi and light your own way</h1>
      <p className="max-w-md text-base text-white/70">
        Pay bills and invest with USDC, and earn Shar along the way. Use my code when you create your account.
      </p>

      {valid ? (
        <>
          <div className="rounded-2xl border border-white/15 bg-white/5 px-8 py-5">
            <p className="font-mono text-xs uppercase tracking-widest text-white/50">Referral code</p>
            <p className="mt-1 select-all font-mono text-3xl font-semibold tracking-[0.25em]">{code}</p>
          </div>
          <a
            href={`bluvfi://ref/${code}`}
            className="rounded-full bg-[#0a0ae8] px-8 py-3 text-base font-semibold text-white transition hover:opacity-90"
          >
            Open in Bluvfi
          </a>
          <p className="max-w-sm text-sm text-white/50">
            Don’t have the app yet? Install Bluvfi on Android, then choose “Have a referral code?” and enter the code above.
          </p>
        </>
      ) : (
        <p className="max-w-sm text-sm text-white/60">That referral link doesn’t look right. Ask your friend to send it again.</p>
      )}
    </main>
  );
}
