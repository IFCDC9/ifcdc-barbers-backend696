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

## Included since build 32

- Password reset: `app_users` + Resend email, SPA link (`ifcdcbarbersapp.com/reset-password`)
- PayPal handler no longer hijacks reset `?token=` links
- Mobile `PasswordResetScreen` wired to real API
- Service photo sync on booking cards (`bookingServiceImages.js`)
- RLS + function hardening (backend)
- Register page fix, routing (`/styles`, 404, messages)
- Footer / legal links, production API URLs locked

## Build & submit

```bash
cd mobile
npm install
npx eas-cli build --platform ios --profile production --non-interactive
npx eas-cli submit --platform ios --profile production --latest --non-interactive
```

`app.json` iOS **buildNumber: 33**.

## Device QA checklist

- [ ] Login / register
- [ ] Password reset: in-app request → email → Safari reset page → login
- [ ] Booking → service photos (not emoji)
- [ ] PayPal checkout + confirmation email
- [ ] Profile / booking history
- [ ] Admin (if applicable): photos upload/delete
