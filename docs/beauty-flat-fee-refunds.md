# $2.50 buyer fee, no commission, and product-only refunds

New product quotes use flat_buyer_fee_v2: one $2.50 buyer platform fee per order, zero seller commission, seller proceeds equal the product subtotal before PayPal processing fees. The new refund policy is product_subtotal_only_v1. On a $10 product, buyer total is $12.50, intended product refund is $10, and IFCDC retains $2.50. PayPal processing charges remain provider-controlled.

The fee retention policy is disclosed in the bag, customer checkout, saved quote, and Founder refund preview. Customer reservation requires explicit acceptance of the current policy; a stale frontend is rejected before stock reservation. Founder reservation asks for confirmation. Existing commercial metadata remains in private catalog records for reference but does not determine new checkout fees; new commission controls are removed from the seller form.

## Install

Apply after the selected-account customer checkout patch (8a233fc). No new database migration, production dependency or environment variable is required. Keep all marketplace payment flags and credentials in sandbox.

Portable validation:

    node --test tests/beautyFlatFee.test.mjs tests/beautyOrder.test.mjs tests/beautyOrderDrafts.test.mjs tests/beautyCustomerSandbox.test.mjs tests/beautyRoutes.test.mjs tests/beautySandboxCheckout.test.mjs tests/beautySandboxOperations.test.mjs tests/beautyRefundDiagnostics.test.mjs tests/beautySellerPayments.test.mjs

Optional embedded PostgreSQL checks require the existing optional @electric-sql/pglite installation. They are not production dependencies:

    BEAUTY_CHECKOUT_DB_TESTS=1 node --test --test-concurrency=1 tests/beautyFlatFee.test.mjs tests/beautyFlatFeeDb.test.mjs tests/beautyOrder.test.mjs tests/beautyOrderDrafts.test.mjs tests/beautyCustomerSandbox.test.mjs tests/beautyRoutes.test.mjs tests/beautySandboxCheckout.test.mjs tests/beautySandboxCheckoutDb.test.mjs tests/beautySandboxOperations.test.mjs tests/beautySandboxOperationsDb.test.mjs tests/beautyRefundDiagnostics.test.mjs tests/beautySellerPayments.test.mjs

Local result: 70 passing checks (41 portable plus 29 database checks, including parent suites). All five changed React components compile. PayPal calls in tests are simulated; this is not proof of provider acceptance or live approval. Local browser execution remains unavailable in this environment.

## Fresh sandbox test after deployment

1. Refresh both Founder and customer pages to load current policy. Use a fresh stocked pickup test product if necessary; do not alter or restore stock held by an unresolved old order.
2. On /beauty-supply, sign in using the already enabled app account. Add a $10 test product, confirm a $2.50 buyer fee and a $12.50 total, accept the retained-fee disclosure, reserve, approve with the separate Personal sandbox PayPal buyer, and verify/capture the payment.
3. On Manage Store, reload orders and confirm seller commission $0.00, IFCDC fees $2.50, refund amount $10.00, retained fee $2.50.
4. Choose Refund sandbox products and confirm the $10 amount. It refunds every product in this order; arbitrary partial product returns are not introduced here.
5. Recheck the refund if its response is uncertain. The immutable refund request ID is reused, and the original captured order is queried before any retry. No new request body is substituted on an old key.
6. Verify completed refund in both the app and sandbox PayPal Activity. The request body includes amount $10 and omits payment_instruction/platform_fees. Check the verified refund webhook delivery log.
7. Only explicitly restock if the test items are available. Repeating restock must not restore stock twice.

The previous PLATFORM_FEE_NOT_ENABLED error identified a missing permission for returning platform fees, not a limit on the number of fees. Omitting the fee-return instruction avoids asking for that permission. Other provider restrictions or account funding issues can still reject a product-only refund; a real sandbox transaction must establish success before claiming resolution.

## Historical orders and recovery

All stored seller_commission_v1 orders retain their original prices and full-payment/fee-return refund policy. Existing blocked refund requests retain their amounts, identifiers and review holds. The $11.50 orders already tested are not converted to $12.50 orders or $10 retained-fee refunds. New drafts use current pricing; existing draft retry keys return the original saved snapshot. Old fee-return requests may remain blocked under PayPal case #18856750.

The historical quote helper under tests is intentionally frozen at the previous deployed policy to test backward compatibility; it is not production pricing. Current and legacy refunds verify expected amounts per capture and per saved policy. A completed product refund means all product proceeds for that order were verified, not that the retained buyer fee was returned. Unexpected positive platform-fee refund amounts remain in review. External refunds still require review and never blindly restock items.

Notifications, seller self-service, actual tax/shipping, chargeback handling, and live-marketplace onboarding remain separate release work. This patch does not open live customer payments or send messages.

Reference: https://developer.paypal.com/api/payments/v2/captures-refund
