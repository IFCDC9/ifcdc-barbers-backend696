# Build 37 — Profile tab crash fix (Apple 2.1(a))

## Rejection (Build 36)

**Guideline 2.1(a) – App Completeness**

Apple reported on iPhone 17 Pro Max:

> We were unable to access Profile, error messages were displayed.

## Root cause

`ProfileStack.tsx` registered `SupportHelpScreen` on the navigator but **did not import it** (regression when Delete Account was added in Build 36).

When the Profile tab loads, `LazyScreen` requires `ProfileStack`. Evaluating the stack file throws:

`ReferenceError: SupportHelpScreen is not defined`

`LazyScreen` catches this and shows **“Feature unavailable”** with the error — exactly what Apple saw.

## Fix

- Restored missing import in `mobile/navigation/ProfileStack.tsx`
- Added `mobile/scripts/verify-profile-stack-imports.cjs` to prevent recurrence

## Build numbers

| Platform | Build |
|----------|-------|
| iOS | **37** (`app.json` → `ios.buildNumber`) |
| Android | **30** (`versionCode`) |

## Pre-flight

```bash
cd mobile
node scripts/verify-profile-stack-imports.cjs
npx tsc --noEmit
```

## Build & submit

```bash
cd mobile
eas build --platform ios --profile production --non-interactive
eas submit --platform ios --latest --non-interactive
eas metadata:push
node scripts/update-asc-review-notes-only-eas.cjs
node scripts/resubmit-app-store-review-eas.cjs
```

Update review notes to reference **Build 37** and note Profile tab fix.

## Test checklist (TestFlight / physical iPhone)

After installing Build 37:

1. **Fresh install** → open app → tap **Profile** → home loads (no “Feature unavailable”)
2. **Email/password** (`apple.review@ifcdcbarbersapp.com`) → Profile shows name/email/menu
3. **Sign in with Apple** → Profile loads
4. Profile → **Delete account** → still works
5. Profile → **Support & help** → screen opens
6. Profile → **Booking history** → loads or shows empty state (not crash)

## Files changed

- `mobile/navigation/ProfileStack.tsx` — add `SupportHelpScreen` import
- `mobile/app.json` — iOS build 37, Android versionCode 30
- `mobile/scripts/verify-profile-stack-imports.cjs` — guard script
- `mobile/store.config.json` — release notes for Build 37
