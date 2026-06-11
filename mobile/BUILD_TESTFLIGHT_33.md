# TestFlight build 33 — pre-App Store sync release

## Production alignment

| Layer | Target |
|-------|--------|
| API | `https://ifcdc-barbers-backend696.onrender.com` |
| Website | `https://ifcdcbarbersapp.com` |
| Database | Supabase `vtkxuagevtiwtoheomjt` via `DATABASE_URL` |
| iOS | 1.0.0 (33) `com.ifcdc.barbers` |

Backend must be on commit **21070361** or newer before device QA.

```bash
curl -sS https://ifcdc-barbers-backend696.onrender.com/api/deploy-info
# activeCommitShort: 21070361+
# mobile.repoIosBuildNumber: 33
```

## Build 34 follow-up (style gallery — after backend deploy)

Build **33** does not include unlimited style gallery on mobile. After deploying the backend + website:

- **Photo limit:** **100 gallery photos per barber** (batch upload up to 25 per request)
- Website Styles Management: multi-upload, delete, reorder (↑↓)
- Mobile booking: submit **Build 34** with `bookingServiceImages.js` gallery cards

## Included since build 32

- Password reset: `app_users` + Resend email, SPA link (`ifcdcbarbersapp.com/reset-password`)
- PayPal handler no longer hijacks reset `?token=` links
- Mobile `PasswordResetScreen` wired to real API
- Service photo sync on booking cards (`bookingServiceImages.js`)
- RLS + function hardening (backend)
- Register page fix, routing (`/styles`, 404, messages)
- Footer / legal links, production API URLs locked

## Build & submit — completed 2026-06-11

| Field | Value |
|-------|--------|
| EAS Build ID | `2d80f954-129a-4396-b5d6-13483ed25589` |
| IPA | https://expo.dev/artifacts/eas/7CUQqStOs_e5I0ZywEKs2BfjuhYJUMfC2TdnTDI_-O4.ipa |
| Submission | `b0a8d716-88d1-4766-bd39-05543615298f` |
| Version | 1.0.0 (33) |
| Git at build | `8242bffa` (includes `21070361` password-reset + PayPal token fix) |

TestFlight: https://appstoreconnect.apple.com/apps/6766149605/testflight/ios

`app.json` iOS **buildNumber: 33**.

## Device QA checklist

- [ ] Login / register
- [ ] Password reset: in-app request → email → Safari reset page → login
- [ ] Booking → service photos (not emoji)
- [ ] PayPal checkout + confirmation email
- [ ] Profile / booking history
- [ ] Admin (if applicable): photos upload/delete
