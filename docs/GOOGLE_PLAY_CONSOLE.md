# Google Play Console — IFCDC Barbers (Tessa)

Do **not** create a second Android app. Package stays `com.ifcdc.barbers`.

Play products are **not** created by this repo. Tessa must create them in Play Console before Android charging. Backend verify + RTDN code is ready; `ENTITLEMENTS_ENFORCE` stays `0` until Apple subs are approved, iOS is released, Google products are active, and verifiers are healthy.

## Products (exact IDs — do not invent others)

| Product ID | Type | Price |
|------------|------|-------|
| `ifcdc.barbers.access` | One-time, non-consumable, restorable, account-bound | $0.99 |
| `ifcdc.barbers.individual.monthly` | Subscription, monthly | $9.99 |
| `ifcdc.barbers.shop.monthly` | Subscription, monthly | $29.99 |
| `ifcdc.barbers.multilocation.monthly` | Subscription, monthly | $59.99 |

Intro: first month free on the three monthly IDs, matching Apple. Keep promotional / win-back offers if you create them in Play — do not invent offer IDs in code.

## Steps

1. Play Console → **IFCDC Barbers** (`com.ifcdc.barbers`) — existing app only.
2. **Monetize → In-app products** → create `ifcdc.barbers.access` as a managed product, $0.99, non-consumable.
3. **Monetize → Subscriptions** → create the three monthly IDs (same strings as Apple). Intro free first month.
4. **Setup → API access** → link the Google Cloud service account whose JSON is on Render as `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (Play Android Developer API).
5. **Monetize → Monetization setup → Real-time developer notifications** → Pub/Sub topic that POSTs to:
   `https://ifcdc-barbers-backend696.onrender.com/api/billing/google/rtdn`
6. Do **not** turn on `ENTITLEMENTS_ENFORCE` or `ENTITLEMENTS_LOCK_SHOPS` from this checklist.

## Verify

After products exist and the service account is linked, production confirm uses Play Developer API (`purchases.subscriptionsv2` then v1 fallback; products.get for one-time). License-tester purchases store as sandbox and are excluded from Super Admin production MRR.
