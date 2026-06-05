# TestFlight build 31 — payment finalize fix

## What this build includes

- `services/bookingPayPalApi.js` — finalize retries, trusts server `paymentCaptured` + `booking.id`
- `screens/BookingScreen.js` — guest email field, no false “payment failed” after capture

Backend must be live on commit **8a3a601d** or newer (verify: `GET /api/deploy-info`).

## Build & submit (run on a machine with EAS login)

```bash
cd mobile
npm install
npx eas-cli login
npx eas-cli build --platform ios --profile production --non-interactive
npx eas-cli submit --platform ios --profile production --latest
```

`app.json` iOS **buildNumber: 31**.

## Verify before live PayPal test

```bash
curl -sS https://ifcdc-barbers-backend696.onrender.com/api/deploy-info
# deployCommitMatch: true, features.paypalFinalizeAlreadyCapturedRecovery: true

curl -sS -X POST https://ifcdc-barbers-backend696.onrender.com/api/app-bookings/start \
  -H "Content-Type: application/json" \
  -d '{"barberName":"Test","dateLabel":"Today","timeLabel":"10:00 AM","redirectUri":"https://example.com/","serviceId":1}'
# error: customer_email_required
```

Install **build 31** from TestFlight (not 30) before testing.
