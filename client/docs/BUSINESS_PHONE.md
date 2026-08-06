# Business phone (customer-facing)

## Resolution order

1. **Shop database** — `businesses.phone` (set via `PUT /api/shop/detail` from Shop Settings; barber profile phone is separate).
2. **Platform fallback** — `BUSINESS_PHONE` on the API host and/or `VITE_BUSINESS_PHONE` at client build time (temporary IFCDC-wide default when no shop phone exists).

No phone numbers are hard-coded in application source. Official IFCDC Barbers App line (production): **+19895141064** / **(989) 514-1064** — set via `businesses.phone`, `BUSINESS_PHONE`, `AURA_PHONE_NUMBER`, and Twilio `TWILIO_PHONE_NUMBER` (same E.164). Keep `SUPER_ADMIN_SMS_PHONE` and owner/admin notify numbers separate.

## Client

- `GET /api/config` → `{ phone, phoneSource, auraPhone }`
- `usePublicBusinessPhone()` / `resolveDisplayBusinessPhone()` in `client/src/hooks/` and `client/src/lib/publicBusinessPhone.js`

## Server

- `src/services/publicContactConfig.js` — `resolvePublicBusinessPhone(businessId?)`
