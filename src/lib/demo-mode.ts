export const DEMO_EMAIL = "demo@bluvfi.com";
export const DEMO_OTP_HINT = "123456";
export const DEMO_EVM_ADDRESS = "0x742d35Cc6634C0532925a3b844C9Ae49900000FF" as `0x${string}`;
export const DEMO_SOL_ADDRESS = "DemoBLUVFI1111111111111111111111111111111111";
export const DEMO_FIRST_NAME = "Reviewer";
export const DEMO_EVM_USDC = 247.50;
export const DEMO_SOL_USDC = 85.00;

const KEY = "bluvfi_demo_mode";

export function isDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function enterDemoMode(): void {
  try { localStorage.setItem(KEY, "1"); } catch {}
}

export function exitDemoMode(): void {
  try { localStorage.removeItem(KEY); } catch {}
}
