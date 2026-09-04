# XRP Wallet Reset — Runbook

## What is an "orphaned" XRP wallet?

The bluvfi app stores XRP sidebar wallet info in two places:

| Store | What it holds |
|---|---|
| **Neon DB** (`xrpl_sidebar_wallets`) | `walletRequestId`, `address`, `userId` |
| **bluvfi-xrpl service DB** | The actual wallet request, activities, balances |

An orphaned wallet means the row exists in Neon but the XRPL service no longer has it — usually because the `bluvfi-xrpl` Docker container was redeployed with a fresh database while Neon was left intact.

**Symptoms:**
- `GET /api/xrpl/balance?walletRequestId=... 404 (Not Found)` in browser console
- XRP balance row hidden in the sidebar (by design — better than spinning "…")
- `404 Not Found: /wallet-requests/<id>` in `sudo docker logs bluvfi-xrpl`

---

## How to detect orphaned wallets

On the VPS, test any `walletRequestId` from Neon against the XRPL service:

```bash
curl -s \
  -H "x-api-key: $BLUVFI_XRPL_API_KEY" \
  https://bluvfi-xrpl.bluvfi.xyz/wallet-requests/<walletRequestId> \
  | jq .error
```

If it returns `"Not Found"` — the wallet is orphaned.

---

## How to fix (user-facing reset)

A one-time admin endpoint exists for this. The flow is:

1. **Create the endpoint** (if not already deployed):

   File: `src/app/api/admin/reset-xrpl-wallet/route.ts`
   ```ts
   // POST /api/admin/reset-xrpl-wallet
   // Deletes the xrpl_sidebar_wallets row for the authenticated user.
   // The sidebar will re-create a fresh wallet on next load.
   ```

2. **Deploy it:**
   ```bash
   git add -A && git commit -m "temp: one-time XRP wallet reset endpoint" && git push
   ```

3. **Run it** — open browser DevTools on the app while logged in as the affected user, then paste in the console:
   ```js
   fetch('/api/admin/reset-xrpl-wallet', { method: 'POST' })
     .then(r => r.json())
     .then(console.log)
   ```

   Expected response:
   ```json
   {
     "ok": true,
     "deleted": 1,
     "message": "Cleared 1 XRP wallet row(s). Refresh the app to generate a new wallet."
   }
   ```

4. **Refresh the page** — the sidebar hits the XRPL service with idempotency key `"primary-xrp-wallet"`, a fresh wallet is created, and the new `walletRequestId` is stored in Neon. The XRP balance row reappears.

5. **Remove the endpoint** after use:
   ```bash
   git rm src/app/api/admin/reset-xrpl-wallet/route.ts
   git commit -m "chore: remove one-time XRP wallet reset endpoint"
   git push
   ```

---

## How to prevent this in future

**Never wipe the bluvfi-xrpl database without also clearing `xrpl_sidebar_wallets` in Neon.**

If you do need to reset the XRPL service DB, run this in the Neon SQL editor ([console.neon.tech](https://console.neon.tech)) beforehand:

```sql
-- Clear all sidebar wallet mappings so the app re-creates them
TRUNCATE xrpl_sidebar_wallets;
```

This way both stores are in sync — users get fresh wallets generated automatically on next login rather than hitting orphaned IDs.

---

## App behaviour for orphaned wallets (post-fix)

| Scenario | Behaviour |
|---|---|
| XRPL service knows the wallet | XRP balance shown normally ✅ |
| Wallet is orphaned (404) | XRP row silently hidden — no error shown ✅ |
| Transient XRPL error (502) | Shows `"…"`, retries on next sidebar open |

Relevant files:
- `src/app/api/xrpl/balance/route.ts` — propagates 404 from XRPL service
- `src/lib/xrplBackend.ts` — attaches `.status` to thrown errors
- `src/components/dashboard/settings-sidebar.tsx` — `xrplOrphaned` state hides the row on 404
