# Build 36 — App Store compliance resubmission

## What changed (Apple rejection fixes)

1. **Guideline 4.8** — Sign in with Apple on the login screen (`Profile → Sign In`).
2. **Guideline 5.1.1(ii)** — `NSPhotoLibraryUsageDescription` updated in `app.json`.
3. **Guideline 5.1.1(v)** — In-app account deletion: `Profile → Delete account → type DELETE → confirm`.

## Before building

1. **Deploy backend** — Push `main` so Render serves:
   - `POST /api/auth/apple`
   - `DELETE /api/auth/account`
2. **Apple Developer** — Ensure **Sign in with Apple** capability is enabled for `com.ifcdc.barbers` (EAS usually applies via `usesAppleSignIn: true`).

## Build & upload

```bash
cd mobile
eas build --platform ios --profile production --non-interactive
eas submit --platform ios --latest --non-interactive
eas metadata:push
node scripts/resubmit-app-store-review-eas.cjs
```

## Screen recording for Apple (physical iPhone)

Record on a **physical device** with Build 36 installed:

1. Sign in with the review account (`apple.review@ifcdcbarbersapp.com` / password from App Review Information).
2. **Profile** tab → **Delete account**.
3. Type `DELETE` → **Delete my account** → confirm.
4. Show success message and signed-out state.

Upload the video in App Store Connect → App Review → **Attachment** (or paste link in Review Notes).

## Review notes (also in `store.config.json`)

- Demo email/password sign-in
- Sign in with Apple on login screen
- Delete account path: Profile → Delete account
