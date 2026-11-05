# Sandbox refunds, verified webhooks and pickup tracking

This patch extends the Founder sandbox trial only. Live credentials and public product checkout remain blocked. It does not send IFCDC email/SMS messages, create shipments or automate physical fulfillment.

## Install and enable

1. Apply the patch and run `node --test tests/beautySandboxOperations.test.mjs tests/beautySandboxCheckout.test.mjs tests/beautyRoutes.test.mjs tests/beautySellerPayments.test.mjs`.
2. Run `scripts/migrations/beauty-sandbox-operations.sql` in the existing Barbers Supabase database SQL editor. It adds order refund/pickup/review fields and private refund/webhook tables. Existing payment/capture history is preserved.
3. Commit the 13 files, merge, and deploy backend/frontend.
4. Keep BEAUTY_PAYPAL_ENV=sandbox and BEAUTY_SANDBOX_CHECKOUT_ENABLED=1. Enable the refund trial with BEAUTY_SANDBOX_REFUNDS_ENABLED=1. Refund submission is disabled by default; no refunds are automatically issued by deployment.
5. In PayPal Developer > Sandbox > Apps & Credentials > the Beauty Marketplace app > Sandbox Webhooks, register this URL:

   https://ifcdc-barbers-backend696.onrender.com/api/beauty/paypal/sandbox-webhook

   Subscribe to PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.REFUNDED, PAYMENT.CAPTURE.REVERSED, PAYMENT.CAPTURE.DENIED, and MERCHANT.PARTNER-CONSENT.REVOKED. Copy the assigned webhook ID into the backend-only variable BEAUTY_PAYPAL_WEBHOOK_ID and redeploy. Use the ID assigned to this app's sandbox webhook, not a client ID or BN code.

## Test with the paid sandbox order

Open Manage Store, Reload test orders, and use the already paid $11.50 order. Mark sandbox pickup ready, then collected. These are tracked Founder actions only: no customer messages or physical pickups are created.

Choose Refund full sandbox payment. The confirmation identifies the amount before the request. The intended full refund is $11.50 to the buyer, with the original $1.70 IFCDC fee contributed back by the platform. PayPal processing fees are provider-controlled and are not represented as refunded without proof. PayPal must enable partner-fee refund support; enabling a Render flag cannot grant that capability. The code does not fall back to making the seller absorb IFCDC's fees when that capability is unavailable.

Refund status becomes completed only when every original capture has a verified completed refund for the expected amount and platform fee. Missing fee evidence, partial seller results and uncertain outcomes remain pending/review. Recheck refund only reads provider state. Retry same refund request uses the original saved request ID after checking for an existing refund; it never creates a replacement request key. New refund submissions stop after the 30-minute retry window; reconciliation can still recover a later result. A known provider refund ID is only read, never refunded again.

A completed refund does not restock products. Once the test items are available, Restock returned test items explicitly restores inventory once and increments the catalog revision. Reload the catalog before making further stock edits.

## Webhook verification and recovery

Incoming requests are posted back to PayPal's sandbox signature-verification API with this app's webhook ID. Only an exact SUCCESS response permits inbox insertion. Missing/invalid verification never touches payment records. Customer names, addresses and email payloads are not retained: the inbox stores a signed-payload digest and minimum resource identifiers, along with event ID/type/status/attempts.

The durable inbox deduplicates events per partner application. Processing failures return non-2xx so PayPal can redeliver; expired processing leases can be retried. The Founder delivery log can retry an already verified failed/unmatched event. Reconciliation reads the existing PayPal order; a webhook never creates/captures a payment or sends a refund. Checkout can be paused without preventing verified webhook read reconciliation.

Completed capture events recover existing pending local captures. Reversal/denial and consent-revocation events halt fulfillment for review. External or unmatched refunds do not silently become complete and do not restore stock. Old completion events cannot clear a refund/review hold. Review flags are intentionally conservative; disputed, external-refund and revoked-consent orders require investigation before any manual database correction or future release. There is no automatic override of these holds.

Use actual sandbox transactions to verify signed deliveries. The PayPal Webhook Simulator cannot prove the real postback-verification path. Load webhook delivery log to inspect processed, failed and unmatched events; use PayPal's Event Logs for provider delivery details. Lost responses should be reconciled using the existing order, not a new payment.

## Validation and limits

Local validation includes 20 portable tests and 22 optional embedded PostgreSQL checks. Optional database tests require @electric-sql/pglite and BEAUTY_CHECKOUT_DB_TESTS=1; it is not a production dependency. Embedded tests serialize connections and do not replace production multi-connection/load testing. PayPal calls are simulated in local tests. Actual signature verification, partner-fee refund capability and a full sandbox refund must be demonstrated after deployment.

Only full-order refunds are supported here. Multi-seller partial completion stays on hold until all seller refunds can be verified. Partial-amount refunds, shipping, taxes, disputes, customer/seller order portals, customer notifications, automatic stock cleanup and live settlement/reporting remain outside this sandbox phase. Public/live release remains closed.

References:
https://developer.paypal.com/platforms/overview
https://developer.paypal.com/api/payments/v2/captures-refund
https://developer.paypal.com/api/rest/webhooks/rest/
https://developer.paypal.com/api/rest/webhooks/simulator/
