# Founder store management

Route: /admin/beauty-supply. Sign in with the existing Founder account and open Beauty → Manage store. The link uses existing public session flags; the API remains the authority and rejects unauthorized access. The route uses the existing admin route guard. No auth, booking or payment configuration is changed.

Add a seller (pending), select Approved, add products with stock, price, shipping/pickup and public pickup address, then Save catalog. Product edits must first be added to the catalog and then saved. Wholesale costs and commission rates are private. No commission is prefilled. Publishing a commission item requires explicit agreed terms. Seller suspension drafts its published products in the same save. Archived products remain editable privately.

Reload asks before discarding catalog changes. Browser refresh warns about unsaved catalog changes. Incomplete form input that has not been added to the catalog is not persisted. Save conflicts preserve the unsaved catalog and show an error; reload and reapply rather than overwrite another session. Cart reservations, checkout, orders, payouts, supplier feeds, product photography and native mobile screen integration remain future work. UI text in this phase is English.

Live preflight: GET https://ifcdc-barbers-backend696.onrender.com/api/beauty/catalog returned HTTP 200 with {"products":[],"checkoutEnabled":false}. This verifies public API/database access, not a real Founder login or write.

Validation: 17 tests passed (all four beauty test files); changed JSX transpiled with esbuild. Full app production build and signed-in browser/mobile layout QA must run in the actual checkout; this workspace contains only supplied source snapshots. No production catalog writes were performed.
