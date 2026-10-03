"use client";

import { useMemo, useState } from "react";

/**
 * Pay card for GetEquity's fund-and-invest / fund-wallet tools. GetEquity
 * returns either a hosted payment link (card, USSD, mobile money) or a
 * virtual bank account to transfer to. The response shape isn't fixed, so
 * pull the link and bank details out of it wherever they sit.
 */

type Output = {
  getEquityPayment: true;
  purpose: "invest" | "fund_wallet";
  amount: number;
  currency: string;
  paymentMethod: string;
  result: unknown;
};

const LINK_KEY = /link|url|checkout|authori[sz]ation/i;
const BANK_FIELDS: [RegExp, string][] = [
  [/^bank_?name$|^bank$/i, "Bank"],
  [/^account_?name$/i, "Account name"],
  [/^account_?number$|^nuban$|^iban$/i, "Account number"],
  [/^(sort|routing)_?code$/i, "Sort / routing code"],
  [/^reference$|^narration$|^payment_?reference$/i, "Reference"],
  [/^ussd(_?code|_?string)?$|^dial_?code$/i, "Dial (USSD)"],
  [/^(expires?_?at|expiry|expiration)$/i, "Expires"],
];

function walk(v: unknown, visit: (key: string, value: unknown) => void, key = "") {
  if (Array.isArray(v)) v.forEach((x) => walk(x, visit, key));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { visit(k, x); walk(x, visit, k); }
}

function extract(result: unknown) {
  let link: string | null = null;
  const bank: { label: string; value: string }[] = [];
  walk(result, (k, v) => {
    if (typeof v !== "string" && typeof v !== "number") return;
    const s = String(v);
    if (!link && typeof v === "string" && /^https:\/\//.test(s) && LINK_KEY.test(k)) link = s;
    const field = BANK_FIELDS.find(([re]) => re.test(k));
    if (field && !bank.some((b) => b.label === field[1])) bank.push({ label: field[1], value: s });
  });
  return { link: link as string | null, bank };
}

export function GetEquityPaymentCard({ output }: { output: Output }) {
  const { link, bank } = useMemo(() => extract(output.result), [output.result]);
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (v: string) =>
    navigator.clipboard?.writeText(v).then(() => { setCopied(v); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  const amount = `${output.currency} ${Number(output.amount).toLocaleString()}`;

  return (
    <div className="my-2 rounded-2xl border border-[#2A2B27] bg-[#1B1C19] p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-400/10 text-xs font-bold text-indigo-400">GE</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#F2F0E8]">{output.purpose === "invest" ? "Fund & invest" : "Fund GetEquity wallet"}</p>
          <p className="text-xs text-[#A7A79A]">GetEquity · {output.paymentMethod.replace("_", " ")}</p>
        </div>
        <p className="shrink-0 text-sm font-bold text-[#F2F0E8]">{amount}</p>
      </div>

      {link && (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 block w-full rounded-xl bg-[#8FAE82] py-2.5 text-center text-xs font-semibold text-[#141513]"
        >
          Pay {amount} on GetEquity ↗
        </a>
      )}

      {bank.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs text-[#A7A79A]">Transfer exactly <span className="text-[#F2F0E8]">{amount}</span> to:</p>
          {bank.map((b) => (
            <button key={b.label} onClick={() => copy(b.value)} className="flex w-full items-center justify-between rounded-lg bg-[#141513] px-3 py-2 text-left">
              <span className="text-[11px] text-[#A7A79A]">{b.label}</span>
              <span className="font-mono text-xs text-[#F2F0E8]">{copied === b.value ? "Copied" : b.value}</span>
            </button>
          ))}
        </div>
      )}

      {!link && bank.length === 0 && (
        <p className="mt-3 text-xs text-amber-400/90">GetEquity created the payment but didn&apos;t return a link or account here. Check your email or the GetEquity screen.</p>
      )}

      <p className="mt-3 text-[11px] text-[#A7A79A]">
        {output.purpose === "invest"
          ? "Once your payment clears, GetEquity funds your wallet and places the investment."
          : "Once your payment clears, it shows in your GetEquity wallet."}
      </p>
    </div>
  );
}
