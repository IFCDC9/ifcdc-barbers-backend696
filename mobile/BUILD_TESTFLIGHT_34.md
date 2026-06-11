# TestFlight build 34 — synchronized production release

## Production alignment

| Layer | Target |
|-------|--------|
| API | `https://ifcdc-barbers-backend696.onrender.com` |
| Website | `https://ifcdcbarbersapp.com` |
| Database | Supabase `vtkxuagevtiwtoheomjt` via `DATABASE_URL` |
| Storage | Supabase `barber-styles` bucket |
| iOS | 1.0.0 (34) `com.ifcdc.barbers` |

```bash
curl -sS https://ifcdc-barbers-backend696.onrender.com/api/deploy-info
# mobile.repoIosBuildNumber: 34
# mobile.testFlightReady: true
```

## Post–build 34 hotfix (style photo persistence)

- All style uploads now persist to **`barber_style_gallery`** (single source of truth)
- Admin barber picker **remembers selected barber** across refresh (`sessionStorage`)
- Expired JWT no longer blocks style list load (falls back to admin key / public API)
- `GET /barbers` preview includes gallery URLs (not only `barber_services`)
- DB insert verified before API returns `persisted: true`

## Included in build 34

- **Password reset** — `app_users` + Resend, SPA links (`ifcdcbarbersapp.com/reset-password`), PayPal handler no longer hijacks `?token=`
- **Style gallery** — up to **100 photos per barber**, batch upload (25/request), delete, reorder (↑↓ on website)
- **Mobile gallery cards** — `bookingServiceImages.js` appends `gal-*` styles to booking picker
- **Photo rendering** — Supabase URLs, `ifcdc-cover-fill`, service image enrichment
- **Booking + PayPal** — customer email gate, finalize recovery, confirmation emails via Resend
- **RLS + function hardening** (production DB)
- **Footer / legal / navigation** — website SPA; mobile tab icons consistent
- **Profile + admin** — JWT auth, barber settings, styles management

## Pre-submit verification

```bash
npm run verify:password-reset
npm run verify:storage
npm run verify:domains
npm run verify:cleanup
node scripts/test-production-readiness.mjs
node --import ./loadBackendEnv.mjs scripts/test-photo-production-verification.mjs
```

## Build & submit

| Field | Value |
|-------|--------|
| EAS Build ID | `f66606ef-9b13-4ad5-8a60-6648a3414bf5` |
| IPA | https://expo.dev/artifacts/eas/59ZqJHZxqtwkwLbyFRAtMzUlk12e21hn4b2ojo2hH5g.ipa |
| Submission ID | `79ced35d-1258-4be5-a57a-638ef6224c09` |
| Version | 1.0.0 (34) |
| Git at build | `b7e22254` |
| Backend deploy | `b7e22254` live on backend696 |

TestFlight: https://appstoreconnect.apple.com/apps/6766149605/testflight/ios

`app.json` iOS **buildNumber: 34**.

## Device QA checklist

- [ ] Login / register
- [ ] Password reset: in-app → email → Safari reset → login
- [ ] Styles browse / booking — multiple photos per barber
- [ ] Gallery upload (website Styles Management): multi-select, delete, reorder
- [ ] PayPal checkout + confirmation email
- [ ] Profile / booking history
- [ ] Admin: user invite, photos, barber settings
