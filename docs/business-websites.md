# IFCDC business websites and publishing

## Included

- New IFCDC marketing homepage at `/`, separate discovery directory at `/find-a-barber`.
- Tenant websites at `/sites/shop-{businessId}` and `/sites/barber-{barberId}`.
- `/website-studio`: edit name, headline, story, layout, typography, accent, public contact details, hero, logo, photo gallery, videos, captions, scheduled promotions.
- Three layouts: Editorial, Midnight, Studio. Draft preview, save, publish, unpublish, conflict protection.
- Draft sites provisioned after shop and barber signup. Existing owners receive drafts when opening the studio. Signup provisioning failure is logged and recovered on studio entry; it does not undo a registration.
- Website studio link in the existing provider dashboard; successful shop and premium barber onboarding opens the studio.
- Teams, active services and prices use existing business records. Booking links preselect a matching barber from the existing live roster. Booking prices, slots, payments, and checkout authorization stay in their existing endpoints.
- Founder can edit the platform homepage and tenant websites and suspend/restore public sites. Ordinary admins receive no global website bypass. Fresh database account and role checks apply to every write.
- Pending accounts can design drafts; public sites remain gated by current business approval and website access. Suspensions immediately hide the public page and discovery entry.

## Data and storage

The backend lazily applies `scripts/migrations/business-websites.sql` on first website use. It creates only two new tables, enables RLS and revokes browser/public table privileges. No existing records or payment tables are modified by that migration. The server database role must own its tables or have the existing privileged migration access.

Uses the existing `SUPABASE_URL` and server-side `SUPABASE_SECRET_KEY` / `SUPABASE_SERVICE_ROLE_KEY`. No new secret is sent to browsers. First upload creates a **private**, dedicated `business-website-media` bucket. Existing image buckets are not changed. Creation requires the server's existing Storage administration permission. If the bucket already exists as public, the upload fails rather than changing its exposure silently.

Uploads go through an authenticated, tenant-checked binary endpoint directly into persistent Supabase Storage. Supported: JPEG/PNG/WebP (8 MB), MP4/WebM (50 MB), WebVTT (1 MB). File signatures are checked. Storage quota is 100 files / 500 MB per website; concurrent uploads can race the application quota check, so use provider-side quotas as an additional bound. No transcoding or video billing service is included. Export MOV/HEVC videos to browser-compatible MP4 before uploading. Removed gallery/video placements stay in the upload library and count toward quota.

Drafts and public snapshots are separate JSON records referencing media IDs. The API issues time-limited signed media links after authorization/publication checks; draft media does not use permanent public URLs. Links last one hour. Already-issued links can remain valid until expiry after suspension or unpublishing. No browser Supabase credentials are needed. Video controls are on-demand with no audible autoplay; optional caption tracks and poster images are supported.

Promotions have optional inclusive start / exclusive end timestamps saved as UTC. Editor inputs use the user's local time zone. Scheduling affects promotional display, not booking price discounts. No coupon/payment logic is added.

## Deploy and verify

1. Apply the patch to the current `beauty/storefront-redesign` branch, then review `git diff --check`.
2. `node --test tests/businessWebsites.test.mjs tests/businessWebsiteRoutes.test.mjs` runs portable checks. PostgreSQL integration additionally uses `WEBSITE_DB_TESTS=1` when `@electric-sql/pglite` is available as a local development dependency. It never connects to production.
3. Run the existing client build: `npm run build --prefix client`.
4. Commit the explicit patch paths, push, merge to the deployment branch, and deploy **both backend and frontend**.
5. As Founder, open `/website-studio`, select IFCDC Barbers, edit the homepage headline/intro, upload a real hero image or promo clip, save, preview and publish.
6. Use an approved shop account to edit and publish its website; inspect its public address signed out. Verify logo/cover/video playback and an available booking through the existing checkout.
7. Verify another shop cannot save that site or reuse its media IDs. Suspend it as Founder and confirm public discovery/page disappear. Restore it after checking.
8. Review desktop and phone layouts in real browsers before announcing the feature. This workspace compiled the frontend and tested the API/SQL flows, but the attached browser could not reach the workspace preview server. No full production frontend build or real Supabase upload has been executed here.

The default homepage uses a remote Unsplash barbershop image; replace it with IFCDC-owned imagery in the studio. No real promo video is preloaded or fabricated. Existing barbers remain discoverable through the booking directory while their own websites are still drafts.

Custom domains, automatic subdomain DNS, drag-and-drop arbitrary blocks, video transcoding, and payment discounts are not included. The first version provides independent branded pages on the existing domain, theme/content controls, and persistent uploads. Marketplace sandbox refund reconciliation remains unresolved and is not changed by this patch.

## Rollback

Revert this application commit and redeploy backend/frontend. Keep the two new tables and private bucket to preserve drafts and uploads. This feature does not require restoring an old database backup.
