# IFCDC Barbers production monetization

**Status (2026-09-14):** Production go-live for Apple confirm/ASSN (Production + Sandbox StoreKit APIs), Play Developer API verify + RTDN, customer UI copy, and billing metrics. Additive schema is on live **supabase-emerald-kite** (`vtkxuagevtiwtoheomjt`). Nobody is gated: **ENTITLEMENTS_ENFORCE=0**, **ENTITLEMENTS_LOCK_SHOPS=0**. Booking, PayPal appointments, $0.99 booking fee, Management Team, auth, SMS, AURA, and shop isolation stay on.

Do **not** combine app access + SaaS subscription + booking fee into one field.

## Flags (keep until stores are ready)

`ENTITLEMENTS_ENFORCE=0`  
`ENTITLEMENTS_LOCK_SHOPS=0`

Set these to `1` only after **all** of: Apple subscriptions approved, iOS released, Google products active, verifiers healthy. Those are not all true yet.

## Rollback (new tables only)

Never drop `businesses`, `app_users`, `bookings`, `payments`, or `management_assignments`.

```sql
DROP TABLE IF EXISTS public.subscription_events;
DROP TABLE IF EXISTS public.app_access_entitlements;
DROP TABLE IF EXISTS public.account_subscriptions;
DROP TABLE IF EXISTS public.platform_product_catalog;
```

## Legacy writes (frozen)

| Path | Behavior |
|------|----------|
| Barber self-serve `subscription_tier` PATCH | Ignored; column still readable as mirror |
| PayPal `pro:` SaaS | Still mirrors `barber_settings.is_pro` historically; does **not** write `account_subscriptions`. Appointment PayPal unchanged |
| `POST /api/admin/subscriptions/:id/start-trial` | HTTP 410 |
| `POST /api/admin/subscriptions/:id/activate-monthly` | HTTP 410 |
| `POST /api/admin/shops/:id/trial/start` as store replacement | HTTP 410. `approveShop` onboarding flags on `businesses` remain a separate access workflow |

Historical `barber_subscriptions` rows are **not** deleted. No retroactive charges. No automatic trial start on existing users.

## Store credentials (Tessa) — names only, never commit keys

Obtain and paste into Render **ifcdc-barbers-backend696** Environment (see `render.yaml` comments). Do not put `.p8` or service-account JSON in git.

| Env name | Obtain from |
|----------|-------------|
| `APPLE_IAP_ISSUER_ID` | App Store Connect → Users and Access → Integrations → In-App Purchase → Issuer ID |
| `APPLE_IAP_KEY_ID` | Same page → In-App Purchase key → Key ID |
| Secret File `ifcdc-barbers-iap.p8` | Render → Environment → Secret Files. Original SubscriptionKey `.p8` (never git) |
| `APPLE_IAP_PRIVATE_KEY_FILE` | `/etc/secrets/ifcdc-barbers-iap.p8` (preferred source) |
| `APPLE_IAP_PRIVATE_KEY` | Fallback PEM only if the secret file env is unset or the path is missing |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Google Cloud service account with Play Android Developer API + Play Console → Setup → API access linked |
| `GOOGLE_PLAY_ACCESS_TOKEN` | Short-lived alternative; prefer service account JSON |
| `GOOGLE_ACCESS_PRODUCT_ID` | Optional override; default `ifcdc.barbers.access` |

Webhooks:

- `POST https://ifcdc-barbers-backend696.onrender.com/api/billing/apple/assn`
- `POST https://ifcdc-barbers-backend696.onrender.com/api/billing/google/rtdn`

Confirm Apple lookups use Production StoreKit (`api.storekit.apple.com`) when the JWS environment is Production, and Sandbox otherwise. A 404 retries the other environment.

## Promo / win-back — do not invent IDs

Code stores `appleOfferId: null` / `googleOfferId: null`. Tessa must copy from App Store Connect **for each product**:

| Product ID | Promo price (3 months) | Copy from App Store Connect |
|------------|------------------------|-----------------------------|
| `ifcdc.barbers.individual.monthly` | $4.99 | Offer code **and** promotional offer identifier |
| `ifcdc.barbers.shop.monthly` | $14.99 | Offer code **and** promotional offer identifier |
| `ifcdc.barbers.multilocation.monthly` | $29.99 | Offer code **and** promotional offer identifier |

Path: App Store Connect → Apps → IFCDC Barbers → Subscriptions → IFCDC Barbers Pro Plans → product → Subscription Prices / Offer Codes / Promotional Offers. Keep existing promo offers; do not delete them.

## iOS $0.99 download

Do **not** change App Store list price in this release. We cannot query Apple’s agreement status from here. Tessa must check **App Store Connect → Business / Agreements, Tax, and Banking → Paid Apps Agreement** (must be Active), then set $0.99 in App Store Connect.

## Android — Tessa must create products

Package remains `com.ifcdc.barbers`. Do **not** create a second Android app. Full Play Console steps: `docs/GOOGLE_PLAY_CONSOLE.md`.

**Do not turn on ENTITLEMENTS_ENFORCE.**

## Monitoring

Structured logs (`{"event":"billing_metric",...}`) and Super Admin counters: `verify_fail`, `webhook_fail`, `duplicate`. No PII, tokens, JWS, or keys. Production MRR on Super Admin → Subscriptions excludes sandbox.

## Schema

Checked in: `supabase/migrations/20260914133000_account_subscriptions_entitlements.sql`  
**Live:** applied 2026-09-14 as `account_subscriptions_entitlements` on emerald-kite.  
**Boot:** `ensureEntitlementSchema` stays IF NOT EXISTS. Render still skips unless `ENTITLEMENTS_SCHEMA_ENSURE=1` (not required now that MCP applied SQL).
