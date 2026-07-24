# Multilingual QA Results — MULTI_LANGUAGE_DROPDOWN_V2

Generated: 2026-07-24T00:10:00.000Z

## Verdict: **PASS** (automated + live website smoke)

| Area | Result |
|------|--------|
| Website locales (9 langs, 500 keys) | PASS |
| Mobile locales (9 langs, 289 keys) | PASS |
| Feature flag default OFF / ON expands to 9 | PASS |
| Arabic RTL metadata | PASS |
| Unit tests | PASS |
| Client production build with flag ON | PASS |
| PayPal/booking support files present | PASS |
| Live website https://ifcdcbarbersapp.com | **PASS — VITE_MULTI_LANGUAGE_DROPDOWN_V2=1 baked into live JS** |
| Local Vite preview language labels | PASS |

## Live deploy evidence
- Live production JS includes `VITE_MULTI_LANGUAGE_DROPDOWN_V2:"1"`
- Native labels present for all 9 languages in the production bundle
- i18next present in production bundle
- GitHub `main` HEAD: `01146c7f` (bake buildCommand) / prior `329f3842` / website i18n `ce657c4e`

## Device / browser matrix
| Target | Status |
|--------|--------|
| Production website (live bundle) | PASS — flag ON |
| Local preview (Mac) | PASS |
| Safari / Windows / iPhone Safari / Android Chrome | Same production bundle — operator confirm UX |
| iPhone TestFlight Build 67 | Pending EAS auth |
| Android | Pending |

## Pass conditions
- No blank/missing locale keys vs English
- No empty translation strings
- Arabic marked RTL
- Feature flag ON in live website build
- PayPal/booking calculation files unchanged in this rollout

## Blockers for remaining steps
1. **TestFlight Build 67** — `eas whoami` returns HTTP 403 Forbidden (Expo session expired). Need fresh `EXPO_TOKEN` or `eas login`.
2. **Backend696** still reports `activeCommit` `6b37b5e1` (env-pinned). Website static deploy is live with V2; confirm `MULTI_LANGUAGE_DROPDOWN_V2=1` on backend696 in Render for email language expansion.
3. **Do not** submit App Store Review until you approve.
