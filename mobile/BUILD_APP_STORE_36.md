# Build 36 — App Store compliance resubmission

## What changed (Apple rejection fixes)

1. **Guideline 4.8** — Sign in with Apple on the login screen (`Profile → Sign In`).
2. **Guideline 5.1.1(ii)** — `NSPhotoLibraryUsageDescription` updated in `app.json`.
3. **Guideline 5.1.1(v)** — In-app account deletion: `Profile → Delete account → type DELETE → confirm`.

## Before building

1. **Deploy backend** — Push `main` so Render serves:
   - `POST /api/auth/apple`
   - `DELETE /api/auth/account`
2. **Apple Developer** — Enable **Sign in with Apple** for App ID `com.ifcdc.barbers` (Identifiers → your app → Capabilities).
3. **Regenerate provisioning profile** (required once after adding Apple Sign In):

```bash
cd mobile
eas credentials:configure-build -p ios -e production
```

Choose to log in to Apple (or use your App Store Connect API key), then **regenerate the provisioning profile** so it includes the `com.apple.developer.applesignin` entitlement.

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
