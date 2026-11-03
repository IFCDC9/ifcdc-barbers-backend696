# Beauty Supply inside IFCDC Barbers

This patch targets the Barbers client supplied in Barbers-Store-Source.txt and Barbers-Store-Connection.txt. It is not the earlier HQ patch.

New customer route: /beauty-supply, linked from the active AppNav on phone/tablet/desktop. Existing routes, role checks, PayPal bridge, booking fees and API origin logic are preserved. New CSS is scoped to .ifcdc-beauty. Localization keys use English defaults; translations still need adding to locale resources.

The page calls apiGet('/api/beauty/catalog'), using the existing backend696 resolver. That backend endpoint has NOT been installed in the Barbers server. Until it is implemented, the page displays a catalog unavailable state with retry, and accepts no orders. The earlier HQ catalog endpoint is separate and should not be treated as a supplier or Barbers backend connection.

Expected public JSON: { products: [{ id, name, brand, seller, category, priceCents, stock, fulfillment, pickupLocation, independentBrand }] }. Categories are defined in client/src/lib/beautyCatalog.js. USD integer cents, nonnegative integer stock, pickup address mandatory for pickup products. Do not return wholesale cost, internal commission agreements, private addresses or unpublished records. Only approved sellers and published listings should be returned. Checkout is disabled regardless of response fields. Bag exists only during this page visit and resets on navigation/reload or catalog reload. It is not an order or reservation.

Still required before sales: server-side supplier approvals, database migrations in existing Barbers Postgres/Supabase system, per-location inventory, seller onboarding/admin UI, product photography, atomic stock reservations, persisted orders and idempotency, separate product payment flow with verified webhooks, shipping/tax quotes, pickup checks, refunds, commission ledger/payout reconciliation and authorized distributor integrations. No chain, distributor or seller is connected by this patch.

Validation completed on supplied files: five unit tests; JSX compilation and store module bundling; git diff whitespace check; patch apply check against supplied snapshots. Full app build and browser/native-device verification require the complete project, and have not been performed here.

Mac commands after downloading the patch: git apply --check PATCH; git apply PATCH; node --test tests/beautyCatalog.test.mjs; npm run build --prefix client. Keep changes on a dedicated branch. Do not merge the old HQ beauty/store-foundation branch to install this customer UI.
