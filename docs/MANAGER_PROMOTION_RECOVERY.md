# Manager promotion session recovery

Reported behavior: a promoted person signs in on iPhone but continues to see customer access.

## Confirmed source defects

- The mobile login screen discarded the authenticated login user. AuthProvider applied a token with a null user and required a second `/api/auth/me` request to expose manager access. A transient failure of that request left an otherwise valid manager session without its dashboard.
- Mobile sessions refreshed at startup or explicitly, with no foreground listener or active-app polling. A promotion made while signed in could remain invisible.
- The website refreshed on focus/visibility but not while an active tab stayed open. Persisting a revoked manager/customer did not remove old `ifcdc_user` or platform-admin display flags.

These are reproducible client defects, not proof that the affected production account has a correct assignment or that its installed binary includes the management screens.

## Changes

- Pass the server-authenticated user from password, Google, Apple, and registration responses into mobile AuthProvider. No manager role is inferred from a JWT or a cached profile.
- Preserve that user during a transient `/me` failure; successful `/me` responses replace it, including revocation. A definitive 401/403 clears a newly signed-in session.
- Refresh mobile access on foreground and every 60 seconds while active. Refresh the website every 60 seconds while visible. Avoid overlapping refresh requests.
- Invalidate stale mobile session responses after sign-out or a new sign-in. Ignore website `/me` responses if the bearer token changed while waiting.
- Clear obsolete website display flags when the authoritative user loses access.

Server-side assignment, shop/location scopes, permission enforcement, and Founder-only powers are unchanged. This does not introduce shop-owner delegation of manager assignments. Promotion does not change a person's existing password or merge Apple relay-email accounts with different email accounts.

## Local validation

After `npm ci` at repository root:

```
npm run test:management-authz
npm run test:manager-promotion
```

28 tests pass in total. Eight new tests mount the production React provider with native/network adapters substituted, exercise web hydration and cache persistence, and verify promotion, suspension, foreground/polling updates, transient failure, definitive rejection, and stale response isolation. React test renderer emits a deprecation notice.

The Vite website production build passes (`npm ci --prefix client`, `npm run build --prefix client`). Eight changed JS/TS modules transpile without syntax diagnostics. These checks do not constitute a complete mobile TypeScript check, native iOS/Android build, physical-device test, or live account/database verification.

## Release and acceptance

1. Check the affected person's actual signed-in account email against the assigned account. For Apple Hide My Email, inspect the app account's relay address; do not automatically transfer authority between different accounts.
2. Confirm the Management Team record is active, targets that account, includes the intended shop/location IDs, and has the intended operational permissions.
3. Review/merge the patch and deploy the website service for the website changes.
4. Build an updated iOS app from the merged commit. The source base has iOS build 85; choose a new unused build number above both that value and the latest App Store Connect build. Verify the build through TestFlight before App Store release. A backend/Render deployment alone cannot update the installed iPhone code. Android changes likewise need an updated Android build.
5. On the updated app, sign in as an ordinary account. Promote that same account while it stays signed in. Return to the app: Manage should appear after a successful refresh. If it remains active, polling should pick up the change after about 60 seconds plus request latency.
6. Verify the manager can use an assigned-shop operation, is refused an unassigned shop, and cannot open Founder-only controls.
7. Suspend/remove the assignment. On refresh the dashboard disappears, and protected API operations remain denied. Restore only if authorized.
8. Repeat with an affected real account, password sign-in and the actual Apple/Google method in use. Confirm the installed build, assignment, and live API results before calling the customer-facing issue resolved.

The patch performs no production database writes, sends no invitations, and does not publish a mobile build.
