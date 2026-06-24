# Build 39 — Version 1.1 Super Admin platform management

## What's included

- **Global Shop & Location Management** — Admin shops list, pending approvals, shop detail with barber counts
- **Super Admin controls** — Monetization toggles (bookings, payments, subscriptions, platform fees), website/mobile access, lifetime free approval
- **Barber Management** — Approve, reject, suspend, reactivate; mobile signup with required shop/location fields; pending approval banner
- **Production backend sync** — `https://ifcdc-barbers-backend696.onrender.com` (signup provisioning + orphan backfill)
- **Bug fixes & performance** — Profile stack guards, admin API SQL joins, server boot fix

## Build numbers

| Platform | Version | Build |
|----------|---------|-------|
| iOS | **1.1.0** | **39** (`app.json` → `ios.buildNumber`) |
| Android | **1.1.0** | **32** (`versionCode`) |

## Pre-flight

```bash
cd mobile
node scripts/verify-profile-stack-imports.cjs
node scripts/verify-app-json.cjs
npx tsc --noEmit
```

## Build & submit

```bash
cd mobile
eas build --platform ios --profile production --non-interactive
eas submit --platform ios --profile production --latest --non-interactive
eas metadata:push
node scripts/update-asc-review-notes-only-eas.cjs
```

## Test checklist (TestFlight / physical iPhone)

1. Sign in as Super Admin → **Admin** tab visible
2. **Admin → Shops** — list loads, pending queue, open shop detail
3. Shop detail — approve/reject, toggle monetization & access flags
4. **Admin → Barbers** — list shows shop/email; Approve/Suspend/Delete work
5. Customer flow — Home → Book → PayPal checkout still works
6. Profile → Support & Help, Delete Account — no crash

## Files changed

- `mobile/app.json` — version 1.1.0, iOS build 39, Android versionCode 32
- `mobile/eas.json` — production API env vars
- `mobile/store.config.json` — release notes & review notes for 1.1 / Build 39
