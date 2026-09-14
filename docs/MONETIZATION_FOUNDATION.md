# IFCDC Barbers production monetization foundation

**Status:** Code on Render after this commit. **Not** App Store review. **Not** Play product creation. **Not** applied to live Postgres until Tessa approves SQL.

**Flags (production):** `ENTITLEMENTS_ENFORCE=0` (default). `ENTITLEMENTS_LOCK_SHOPS=0` (default). Existing booking, PayPal appointments, $0.99 booking fee, Management Team, auth, SMS, AURA, and shop isolation stay on.

Do **not** combine app access + SaaS subscription + booking fee into one field.

## Legacy writes (frozen)

| Path | Behavior |
|------|----------|
| Barber self-serve `subscription_tier` PATCH | Ignored; column still readable as mirror |
| PayPal `pro:` SaaS | Still mirrors `barber_settings.is_pro` historically; does **not** write `account_subscriptions`. Appointment PayPal unchanged |
| `POST /api/admin/subscriptions/:id/start-trial` | HTTP 410 |
| `POST /api/admin/subscriptions/:id/activate-monthly` | HTTP 410 |
| `POST /api/admin/shops/:id/trial/start` as store replacement | HTTP 410. `approveShop` onboarding flags on `businesses` remain a separate access workflow |

Historical `barber_subscriptions` rows are **not** deleted. No retroactive charges. No automatic trial start on existing users.

## Store credentials (Tessa)

- Apple: `APPLE_IAP_ISSUER_ID`, `APPLE_IAP_KEY_ID`, `APPLE_IAP_PRIVATE_KEY` (never log). Until set, confirm/ASSN **refuse grants** (closed).
- Google: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` or `GOOGLE_PLAY_ACCESS_TOKEN`. Access SKU `GOOGLE_ACCESS_PRODUCT_ID` default `ifcdc.barbers.access` — **confirm with Tessa before production**.

Webhooks (after Render deploy):

- `POST https://ifcdc-barbers-backend696.onrender.com/api/billing/apple/assn`
- `POST https://ifcdc-barbers-backend696.onrender.com/api/billing/google/rtdn`

## iOS $0.99 download

Do **not** change App Store list price in this release. Paid Apps Agreement must be confirmed by Tessa first.

## Android $0.99 access

Implement as configurable `ifcdc.barbers.access` (non-consumable, restorable, account-bound). Play Console product creation is Tessa’s action. Do not create a second Android app or change `com.ifcdc.barbers`.

## Schema

Checked in: `supabase/migrations/20260914133000_account_subscriptions_entitlements.sql`  
**Boot:** `ensureEntitlementSchema` is IF NOT EXISTS + catalog seed only. Render **does not** run it unless `ENTITLEMENTS_SCHEMA_ENSURE=1` after Tessa approves the SQL.

**Do not apply to production until Tessa approves SQL.**
