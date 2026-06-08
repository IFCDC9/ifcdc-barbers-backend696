# TestFlight build 32 — service photo sync (website parity)

## What this build includes

- `utils/bookingServiceImages.js` — merge `/api/styles` photos onto booking services
- `services/bookingPayPalApi.js` — public `app-bookings/services` first, 12s timeout, photo enrichment
- `components/ServicePickerCard.js` — Supabase thumbnails (not emoji placeholders)
- `screens/BookingScreen.js` — longer safety timeout before offline fallback

Backend must be live on commit **1a50b8f5** or newer (photo sync + storage fix).

```bash
curl -sS https://ifcdc-barbers-backend696.onrender.com/api/deploy-info
# activeCommitShort: 1a50b8f5 (or newer)
# mobile.repoIosBuildNumber: 32
```

## Build & submit (machine with EAS login)

```bash
cd mobile
npm install
npx eas-cli login
npx eas-cli build --platform ios --profile production --non-interactive
npx eas-cli submit --platform ios --profile production --latest --non-interactive
```

`app.json` iOS **buildNumber: 32**.

## Verify service photos before device test

```bash
curl -sS "https://ifcdc-barbers-backend696.onrender.com/api/barber/services?barberName=IFCDC%20Barbers"
# Each service with a photo should have image_url containing supabase.co/storage/
```

Install **build 32** from TestFlight (not 31) before testing photo sync.

## Test checklist (iPhone)

- [ ] Booking → Choose service shows real photos (not emoji icons)
- [ ] Same images as website for the same barber/service
- [ ] Upload/replace/delete on website → refresh app booking step → image updates
- [ ] PayPal checkout completes
- [ ] Confirmation email received
