# Founder sandbox checkout trial

This phase adds a Founder-only product payment trial. Public and mobile checkout remain closed. Live PayPal credentials are always rejected, even if the feature flag is enabled. There is no automatic fulfillment and no real goods should be supplied for these sandbox orders.

## Deployment

1. Apply the patch. Run `node --test tests/beautySandboxCheckout.test.mjs tests/beautyRoutes.test.mjs tests/beautySellerPayments.test.mjs`.
2. Run `scripts/migrations/beauty-sandbox-checkout.sql` in the same Supabase SQL editor/database used for seller payment connections. This creates separate sandbox orders, captures and event tables. It enables RLS and revokes public access.
3. Commit the listed new and changed files, merge and deploy backend and frontend.
4. Keep BEAUTY_PAYPAL_ENV=sandbox and the existing dedicated marketplace sandbox credentials. Set BEAUTY_SANDBOX_CHECKOUT_ENABLED=1 in the Barbers backend environment and deploy. The onboarding feature/credentials must already be configured. Do not alter booking PayPal variables.

## First test

Use the already authorized sandbox seller. In Manage Store add a test product with stock 3, price $10.00, category Hair care, local pickup selected and a clearly simulated pickup address, shipping deselected, publication Published. If using the Seller commission revenue model, enter 2 in its legacy agreed-commission field; checkout uses the universal 2% policy. Save the catalog.

In Founder sandbox checkout trial, choose quantity 1 and Reserve sandbox order. The server recomputes prices, checks current seller authorization and reserves stock. The buyer test total is $11.50: $10 products + one $1.50 fee. IFCDC's platform fee is $1.70: $1.50 buyer fee + $0.20 seller commission. The seller's proceeds before PayPal processing fees are $9.80. Actual processing fees and net receipts are verified and saved in beauty_sandbox_captures.details.

Choose Create PayPal test payment. Open the approval link and sign in with a separate sandbox Personal buyer account from PayPal Developer > Testing Tools > Sandbox Accounts. Do not use the sandbox Partner or receiving seller account as the buyer. Approve, return to Manage Store, and choose Capture approved test payment. The order should show paid only after the server verifies every capture, seller, amount, currency, commission and processing/net arithmetic.

If returning from PayPal reloads the page, use Reload test orders to recover the saved order. Browser redirect flags and client-provided prices never mark an order paid. No additional browser-generated provider order is accepted.

## Stock and recovery

Reservations last 30 minutes for starting a new create/capture attempt. Stock is not automatically released at expiration because a payment may still be uncertain. Use Release unpaid reservation for reserved/paypal_created orders you will not complete. Release checks PayPal for any existing capture first. Paid or uncertain captures cannot free stock. Reload the catalog after a stock action before editing its available stock; reservations increment the catalog revision to prevent stale catalog writes from overwriting inventory.

If a response is lost, use Reload test orders, then Recheck payment. If PayPal confirms the existing order is still approved and uncaptured, Retry same PayPal capture may retry that same provider order with the same persisted idempotency key within the reservation deadline. It never creates another provider order. Partial/pending captures, fee mismatches or unverified responses remain review_required and retain stock. Do not create a replacement payment to fix an uncertain result. Review the saved sandbox order/capture/event records and PayPal sandbox transactions first. Expired uncertain orders require manual reconciliation, not blind inventory resets.

The order total is capped at $100 inclusive of the buyer fee. This is a pickup-only sandbox trial with simulated zero tax/shipping, not live tax handling. Multi-seller orders retain one fixed fee and allocate the order-level 2% commission deterministically; each purchase unit names its seller merchant. PayPal may settle multiple sellers separately and may produce partial capture results; the application does not treat these as a completed order.

## Validation and remaining work

Local tests include contract/auth tests and optional embedded PostgreSQL integration tests covering transactions, stock, retry/recovery and cancellation. The optional DB test uses @electric-sql/pglite only when BEAUTY_CHECKOUT_DB_TESTS=1; it is not a production dependency. Embedded tests serialize connections; production multi-connection load testing and actual PayPal sandbox create/capture remain required.

This trial uses authenticated PayPal GET reconciliation. It does not yet implement payment/refund/consent-revocation webhooks, automated refunds, automated reservation cleanup, live taxes/shipping, customer checkout, seller order access or fulfillment. Refunds after paid are not automatically reflected. These must be addressed before any live product-payment release. Existing booking payments are unchanged.

PayPal references:
https://developer.paypal.com/platforms/checkout/standard/customize/multiseller-payments
https://developer.paypal.com/platforms/checkout/immediate-capture
https://developer.paypal.com/api/rest/reference/idempotency/
