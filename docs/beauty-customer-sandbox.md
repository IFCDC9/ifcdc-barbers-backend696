# Customer checkout and tracking: selected-account sandbox trial

This change adds an authenticated customer checkout and order-status view to /beauty-supply. It is a sandbox trial, not live sales. Existing booking routes, credentials and payment handling are unchanged. The existing product return path is already excluded from the global booking token handler.

## Deployment

Apply after the refunds/webhooks and refund-diagnostic patches. No new production dependencies or database migration are required: the existing beauty sandbox checkout and operations migrations must already be installed.

Run:

    node --test tests/beautyCustomerSandbox.test.mjs tests/beautyRoutes.test.mjs tests/beautySandboxCheckout.test.mjs tests/beautySandboxOperations.test.mjs tests/beautySellerPayments.test.mjs

Merge and deploy backend and frontend. The customer trial is disabled by default. Keep dedicated marketplace credentials in sandbox. Existing live booking credentials must remain untouched.

To enable selected app accounts for sandbox checkout, set these backend variables:

    BEAUTY_CUSTOMER_SANDBOX_ENABLED=1
    BEAUTY_CUSTOMER_SANDBOX_BUYER_IDS=<comma-separated app_users UUIDs>

The existing BEAUTY_SANDBOX_CHECKOUT_ENABLED=1 and configured sandbox marketplace credentials are also required. Wildcards are not accepted. Start with the Founder's existing app account as the first test account. These are application-user IDs, not PayPal merchant IDs or sandbox email addresses. This does not connect real seller accounts or open real payments.

Pausing BEAUTY_CUSTOMER_SANDBOX_ENABLED blocks new reservations and payment submissions but leaves signed-in buyers able to read their existing orders, reconcile payment outcomes and cancel eligible unpaid reservations while the underlying sandbox service remains enabled.

## Customer test

1. Sign in to the app using an allowed active app account. Open /beauty-supply.
2. Add a stocked pickup product from an authorized sandbox seller. The trial is pickup only; tax and shipping are simulated as zero. Total must be at most $100 including the $1.50 buyer fee.
3. Reserve a test order. Stock is reserved once. Continue to test payment, approve using a separate PayPal Personal sandbox account, and return to the same storefront.
4. Click Verify and complete test payment. The URL return alone is never treated as payment proof. Server capture verification determines paid status.
5. Refresh my test orders to track payment and pickup. Confirm an unrelated app account cannot read the order even with its UUID.
6. In Founder Manage Store, Reload test orders. The Founder list now includes up to 100 orders across buyers within the configured sandbox partner application. Use the new customer's paid order to mark ready and collected. Reload the customer view to verify both transitions.
7. Check the already verified webhook log for the completed capture. No refund is automatically requested.

Uncertain outcomes retain the existing order and request keys. The browser retains the reservation key in sessionStorage per app user and bag; do not clear it after a timeout. The explicit Start a separate test order control lets the tester deliberately start a second order after checking the first is paid or cancelled. Each buyer can have at most three unresolved reservations/capture reviews. Expired stock reservations are explicitly cancelled; they are not silently released.

## Privacy and ownership

The server takes buyer identity exclusively from a validated bearer token and checks the current active app account. Browser-supplied buyer IDs, prices, totals and seller bindings do not authorize anything. Each service operation locks and reads orders by buyer plus partner scope. Customers cannot refund, change pickup status, restock or read webhook administration through this route. Customer projections omit merchant bindings, provider order identifiers and seller accounting allocations. Founder operations stay behind existing current-role middleware, and resolve an order's buyer server-side within the configured partner scope.

## Validation and remaining work

Local HTTP and embedded PostgreSQL tests cover default-off and live-credential rejection, current active account checks, customer action restrictions, account isolation, immutable reservation keys, reservation limits, fixed customer return URLs and Founder scope. Existing capture/refund/webhook recovery suites are included. Provider calls in these tests are mocked. A customer-facing sandbox transaction and actual browser flow must be verified after deployment. This environment could compile the component but could not launch its local Chromium runtime for visual interaction tests.

This change does not enable live marketplace payments, configure real tax/shipping, send pickup SMS/email, create a seller self-service portal, change the refund policy, or resolve PayPal case #18856750. Those remain release work. Do not switch BEAUTY_PAYPAL_ENV to live: the trial rejects live credentials by design.
