# Beauty seller payment connections

This phase adds Founder-managed PayPal seller onboarding. It does not create/capture product payments, transfer funds, calculate tax/shipping, or open checkout. The $1.50 buyer fee and 2% seller commission remain in the pricing foundation.

## Install

1. Apply this patch and run `node --test tests/beautySellerPayments.test.mjs tests/beautyRoutes.test.mjs`.
2. Run `scripts/migrations/beauty-seller-payment-accounts.sql` using the database SQL editor. Use the same server database connection that owns the existing beauty tables. RLS is enabled; public browser access is revoked.
3. Deploy the code. No new npm packages are required.

## Marketplace setup

Use an approved PayPal marketplace/partner application, with Platform Fee enabled and PAYMENT, REFUND and PARTNER_FEE capabilities configured. Partner approval cannot be created by this code. Keep this account/application separate from booking payments; do not change PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET or PAYPAL_ENV.

Set these server-only Render variables for a sandbox trial:

- BEAUTY_PAYPAL_ENV=sandbox
- BEAUTY_PAYPAL_CLIENT_ID: dedicated sandbox partner application client ID
- BEAUTY_PAYPAL_CLIENT_SECRET: matching sandbox secret
- BEAUTY_PAYPAL_PARTNER_ID: sandbox partner merchant ID
- BEAUTY_PAYPAL_BN_CODE: attribution code assigned by PayPal
- BEAUTY_PAYPAL_ONBOARDING_ENABLED=1

Do not put secrets in VITE variables, source code, terminal screenshots or chat. With the flag absent or incomplete settings, link generation and verification remain disabled. The public config response lists missing variable names, never their values. Sandbox/live records and different partner applications are isolated in storage.

## Founder flow

In Manage Store, save the catalog and approve the seller. Each seller now has View payment status, Create seller setup link, and Verify with PayPal controls. Give the private setup link only to its intended seller. The seller signs in to their own PayPal account and grants permission there. The integration does not claim consent on their behalf or collect their PayPal password. A completed setup ends on PayPal; it does not automatically approve a catalog seller.

After completion, use Verify with PayPal. Identity comes from the server-generated tracking ID and authenticated PayPal API responses; browser merchant IDs and redirect status flags are not accepted. The server verifies confirmed email, payments receivable, and PAYMENT/REFUND scopes for the configured partner client. Existing merchant bindings cannot silently be replaced. Account authorized means this connection check succeeded, not that product checkout is ready or that PARTNER_FEE settlement has been demonstrated. Verification failures do not authorize any payment. A not-found response clears the last saved authorization. Last-checked timestamps identify stale results.

## Before product checkout

Verify sandbox onboarding and partner fee support with actual sandbox accounts. Payment creation must recheck seller permission and approval at checkout; saved connection status is not authorization to charge. The next phase needs durable orders, inventory reservation, tax/shipping totals, idempotent provider create/capture, exact amount/currency/payee validation, verified webhook processing (including revocation/refunds), and reconciliation before live checkout is enabled.

Docs: https://developer.paypal.com/platforms/seller-onboarding/before-payment/
https://developer.paypal.com/platforms/seller-onboarding/onboarding-checklist/
https://developer.paypal.com/platforms/overview
