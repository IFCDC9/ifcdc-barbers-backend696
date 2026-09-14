# IFCDC Barbers production monetization foundation

**Status (2026-09-14):** Additive schema applied on live **supabase-emerald-kite** (`vtkxuagevtiwtoheomjt`). Observe/sandbox only. **Not** App Store review. **Not** Play product activation. Nobody charged, blocked, downgraded, or gated.

**Flags (production):** `ENTITLEMENTS_ENFORCE=0` (default). `ENTITLEMENTS_LOCK_SHOPS=0` (default). Do **not** set either to `1` in this phase. Existing booking, PayPal appointments, $0.99 booking fee, Management Team, auth, SMS, AURA, and shop isolation stay on.

Do **not** combine app access + SaaS subscription + booking fee into one field.

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

Until Apple/Google keys are set, confirm/ASSN/RTDN **refuse grants** (closed).

Webhooks:

- `POST https://ifcdc-barbers-backend696.onrender.com/api/billing/apple/assn`
- `POST https://ifcdc-barbers-backend696.onrender.com/api/billing/google/rtdn`

## Promo / win-back — do not invent IDs

Code stores `appleOfferId: null` / `googleOfferId: null`. Tessa must copy from App Store Connect **for each product**:

| Product ID | Promo price (3 months) | Copy from App Store Connect |
|------------|------------------------|-----------------------------|
| `ifcdc.barbers.individual.monthly` | $4.99 | Offer code **and** promotional offer identifier |
| `ifcdc.barbers.shop.monthly` | $14.99 | Offer code **and** promotional offer identifier |
| `ifcdc.barbers.multilocation.monthly` | $29.99 | Offer code **and** promotional offer identifier |

Path: App Store Connect → Apps → IFCDC Barbers → Subscriptions → IFCDC Barbers Pro Plans → product → Subscription Prices / Offer Codes / Promotional Offers.

## iOS $0.99 download

Do **not** change App Store list price in this release. We cannot query Apple’s agreement status from here. Tessa must check **App Store Connect → Business / Agreements, Tax, and Banking → Paid Apps Agreement** (must be Active).

## Android $0.99 access — DRAFT, do not activate gating

Code is ready for non-consumable restorable account-bound SKU `ifcdc.barbers.access` (`GOOGLE_ACCESS_PRODUCT_ID`). Package remains `com.ifcdc.barbers`. **Do not turn on ENTITLEMENTS_ENFORCE.**

Play Console steps for Tessa (draft):

1. Play Console → IFCDC Barbers (`com.ifcdc.barbers`) → Monetize → In-app products.
2. Create one-time product ID **exactly** `ifcdc.barbers.access`, $0.99, non-consumable, restorable.
3. Create subscription products with the same IDs as Apple (monthly group), intro free first month — **do not activate customer gating**.
4. Monetize → Subscriptions if using Play Billing subscriptions.
5. Setup → API access → link the service account used in `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
6. Monetize → Monetization setup → Real-time developer notifications → Pub/Sub topic that POSTs to `/api/billing/google/rtdn` (when Tessa is ready; not required to gate anyone this phase).

## Schema

Checked in: `supabase/migrations/20260914133000_account_subscriptions_entitlements.sql`  
**Live:** applied 2026-09-14 as `account_subscriptions_entitlements` on emerald-kite.  
**Boot:** `ensureEntitlementSchema` stays IF NOT EXISTS. Render still skips unless `ENTITLEMENTS_SCHEMA_ENSURE=1` (not required now that MCP applied SQL).

## Sandbox test checklist (do not force real customers)

Use sandbox Apple ID / Play license testers only. Observe mode: purchases may confirm in DB if credentials exist, but shops/bookings are **not** gated.

1. Health: `GET https://ifcdc-barbers-backend696.onrender.com/api/health` → `{ "status": "OK" }`.
2. Catalog: `GET /api/entitlements/catalog` → mode `observe_sandbox`, Apple IDs exact, promo IDs null.
3. Super Admin → Subscriptions: empty store rows, Environment column sandbox vs Production, **no invented MRR**.
4. iOS TestFlight 1.1.12 (82): sandbox Apple ID; fetch products; restore; do **not** use a production Apple ID.
5. Do not start trials, do not charge production customers, do not expire shops.
6. Booking $0.99 platform fee unchanged on checkout.
7. After credentials exist: ASSN/RTDN sandbox notifications only.

## TestFlight

Use `mobile/eas.json` **production** profile → `https://ifcdc-barbers-backend696.onrender.com`. iOS version **1.1.12** build **82**. Submit TestFlight only — **no App Store review**.
