"use client";

/**
 * Shared error display — used anywhere a failed action or fetch needs to
 * tell the user something went wrong. Consolidates what had drifted into
 * three near-identical but slightly different copies (bills-screen.tsx,
 * fund-wallet-sheet.tsx, payments-screen.tsx) so error styling can't keep
 * drifting apart, and so every error gets the same friendly treatment: an
 * icon (not just colored text — easier to scan at a glance), and an
 * optional one-click retry instead of leaving the user stuck.
 *
 * Only handles presentation. Callers are still responsible for the message
 * itself being human-readable — see bills-screen.tsx's handleConfirm for
 * the pattern of translating a raw/technical error into plain language
 * before it ever reaches this component.
 */
export function ErrorBanner({
  message,
  onRetry,
  retryLabel = "Try again",
  className = "",
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex items-start gap-2.5 rounded-xl border border-red-900/40 bg-red-900/15 px-4 py-3 text-sm text-red-400 ${className}`}
    >
      <span className="mt-0.5 shrink-0 leading-none" aria-hidden>⚠</span>
      <div className="flex-1 leading-relaxed">
        {message}
        {onRetry && (
          <button
            onClick={onRetry}
            className="ml-2 font-medium underline underline-offset-2 hover:text-red-300"
          >
            {retryLabel}
          </button>
        )}
      </div>
    </div>
  );
}
