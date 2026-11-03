# Beauty catalog backend phase

Adds persistent catalog read/write endpoints to the existing Barbers server:
- GET /api/beauty/catalog returns only published products from approved sellers, matching the storefront contract. Checkout remains disabled.
- GET /api/beauty/admin/catalog returns the revision and private catalog for the Founder.
- PUT /api/beauty/admin/catalog replaces the catalog using its current integer revision. Send the existing Bearer session token. A stale revision returns 409; reload before saving.

Admin requests use the existing token resolver and Super Admin predicate, then recheck app_users.role and account_status. Regular platform admins, managers, sellers, and anonymous callers cannot change catalog data. Wholesale prices and commission basis points never appear in public responses. Each successful replacement and its actor are recorded atomically in beauty_catalog_audit.

Catalog shape: {revision, sellers: [{id, name, status}], products: [...]}. Seller status is pending/approved/suspended. Product fields follow client/src/lib/beautyCatalog.js plus sellerId, status (draft/published/archived), revenueModel (resale/commission), nullable wholesaleCostCents and nullable commissionBps (0–10000). 1500 basis points means 15 percent; no percentage is assigned by default. Commission products require an explicit percentage before publishing. Suspending a seller requires moving its published products to draft/archived in the same save. IDs use letters, digits, underscores and hyphens.

Before deployment, apply scripts/migrations/beauty-catalog.sql to a staging database using the server DB owner role. It only creates dedicated tables and enables RLS, with no browser policies. Verify the configured backend database role can read/write these tables; do not grant browser roles access. Missing schema yields 503 rather than pretending the catalog is empty. The migration is NOT run on server startup. Repeat in production only as part of an approved deployment after staging verification.

Validation: node --test tests/beautyCatalog.test.mjs tests/beautyBackend.test.mjs tests/beautyRoutes.test.mjs
Also run npm run build --prefix client in the full checkout. Router tests inject token/DB fixtures and do not contact a live database. Actual PostgreSQL migration execution, real signed-in Founder flow and deployment remain unverified in this partial source workspace.

This phase does not add a product-management screen, seller self-service, distributor connections, orders, stock reservations, shipping/tax calculations, checkout, payouts or refunds. The existing booking/payment flows are not changed. Native iOS/Android store navigation is a separate integration; this patch targets the Barbers web client and shared API.
