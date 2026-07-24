# Backend MULTI_LANGUAGE_DROPDOWN_V2 — verification

Generated: 2026-07-24T00:26:00Z

## Production email backends

| Service | Role | Flag status |
|---------|------|-------------|
| **ifcdc-barbers-backend696** | Primary API — booking confirmations, reminders, refunds, review prompts, loyalty Resend | **ON** (`multiLanguage.enabled: true`) |
| **aura-backend** | Voice booking path (may send booking emails) | Flag set in `render.yaml` to `1`; service currently not responding to HTTP probe (likely spun down). Will apply on next deploy/wake. |
| **ifcdc-barbers-frontend** | Website (not email) | `VITE_MULTI_LANGUAGE_DROPDOWN_V2=1` baked in live JS |

## Live confirmation (backend696)

```
GET https://ifcdc-barbers-backend696.onrender.com/api/deploy-info
→ activeCommitShort: a4d26c06
→ multiLanguage.enabled: true
→ features.multiLanguageDropdownV2: true
→ codes: en, es, fr, ht, pt, ar, zh-CN, ko, vi
→ englishFallback: true
```

## Frontend alignment

Live website bundle includes `VITE_MULTI_LANGUAGE_DROPDOWN_V2:"1"`.
Mobile EAS production profile includes `EXPO_PUBLIC_MULTI_LANGUAGE_DROPDOWN_V2=1` (Build 67).

Same language codes on all three surfaces.

## Customer email language coverage (commit a4d26c06)

| Email | Uses customer preferred language | English fallback |
|-------|----------------------------------|------------------|
| Booking confirmation | Yes (`bookingEmail.cjs` + `resolveCustomerLanguage`) | Yes |
| Reminders (~30 min) | Yes (`bookingReminders.js`) | Yes |
| Review request | Yes (`reviewNotificationEmail.cjs`) | Yes |
| Refund / cancellation money notice | Yes (`sendBookingRefundEmail`) | Yes |
| Loyalty reward notice (Resend path) | Yes (`hubspotStarterAutomationService.js`) | Yes |
| Admin / Super Admin ops emails | Remain English | N/A |

## Unchanged (protected)

- PayPal order create/capture
- Fees, booking totals, calendar availability
- Rewards calculation engine
- Manual Bypass / Super Admin permissions

## How to re-verify later

```bash
curl -sS https://ifcdc-barbers-backend696.onrender.com/api/deploy-info | jq .multiLanguage
RENDER_API_KEY=rnd_... node scripts/enable-multilang-backend-env.mjs --verify-only
```
