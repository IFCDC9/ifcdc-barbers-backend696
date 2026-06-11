# TestFlight / App Store build 35 — final readiness release

## Production alignment

| Layer | Target |
|-------|--------|
| API | `https://ifcdc-barbers-backend696.onrender.com` |
| Website | `https://ifcdcbarbersapp.com` |
| Database | Supabase `vtkxuagevtiwtoheomjt` via `DATABASE_URL` |
| Storage | Supabase `barber-styles` bucket |
| iOS | 1.0.0 (35) `com.ifcdc.barbers` |
| Android | versionCode 28 `com.ifcdc.barbers` |

```bash
curl -sS https://ifcdc-barbers-backend696.onrender.com/api/deploy-info
# mobile.repoIosBuildNumber: 35
# mobile.requiredIosBuildNumberMin: 35
# mobile.testFlightReady: true
```

## Build 35 highlights (App Store readiness)

- **Style & service photo persistence** — uploads route to production API; gallery rows verified after save
- **Booking photo sync** — `bookingServiceImages.js` merges gallery + service covers on every platform
- **Per-service photo management** — upload many, delete, set primary, reorder (website Barber Settings)
- **Gallery limit** — 500 photos/barber, 25 per batch
- **Placeholder covers** — every service shows a photo or IFCDC placeholder (no blank cards)
- **Password reset** — `app_users` + Resend, SPA deep links
- **PayPal checkout** — customer email gate, finalize recovery, confirmation emails
- **Admin** — JWT auth, styles management, barber settings, invites
- **Security** — RLS hardening, no public super_admin registration

## Pre-submit verification (all must pass)

```bash
npm run verify:password-reset      # 13/13
npm run verify:storage             # Supabase reachable
npm run verify:domains             # ifcdcbarbersapp.com SPA
npm run verify:cleanup
node scripts/test-production-readiness.mjs   # 16/16
node --import ./loadBackendEnv.mjs scripts/verify-service-photo-workflow.mjs
```

## Build & submit

```bash
cd mobile
eas build --platform ios --profile production --non-interactive
eas submit --platform ios --profile production --latest --non-interactive
```

| Field | Value |
|-------|--------|
| EAS Build ID | `f146102a-edd9-448b-b15a-c92a94f5de6b` |
| IPA | https://expo.dev/artifacts/eas/x-MQmPLIcKm6jle2ROOqikCMI7FsLjPjN8aFnT8eYYk.ipa |
| Submission ID | `f7beaf4f-6f74-40f6-9d7c-8878c1cfa1ac` |
| Version | 1.0.0 (35) |
| Git at build | `54b61c87` |
| Backend deploy | `c3b03bc2`+ (photo persistence fixes on Render) |

TestFlight: https://appstoreconnect.apple.com/apps/6766149605/testflight/ios

`app.json` iOS **buildNumber: 35**.

## Cross-platform sync checklist

- [ ] **Website** — booking wizard shows service photos + gallery styles; prices match services
- [ ] **iPhone Safari** — same booking flow and photos as website
- [ ] **Android Chrome** — same API, same photos and prices
- [ ] **TestFlight Build 35** — service picker photos, gallery cards, PayPal checkout

## App Store submission checklist

- [ ] TestFlight Build 35 installed and smoke-tested on physical iPhone
- [ ] Login / register / password reset
- [ ] Book appointment end-to-end with PayPal; confirmation email received
- [ ] Style photos visible in booking; prices correct per service
- [ ] Profile tab, booking history, no broken navigation or missing tab icons
- [ ] App Store Connect → version 1.0.0, build 35 selected
- [ ] Screenshots, description, privacy policy URL: `https://ifcdcbarbersapp.com/privacy`
- [ ] Terms URL: `https://ifcdcbarbersapp.com/terms`
- [ ] Export compliance: `ITSAppUsesNonExemptEncryption: false` (already in Info.plist)
- [ ] Submit for App Review
