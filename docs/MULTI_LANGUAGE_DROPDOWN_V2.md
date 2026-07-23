# MULTI_LANGUAGE_DROPDOWN_V2 — Translation coverage report

Generated from locale leaf-key parity checks. See also `docs/TRANSLATION_COVERAGE_REPORT_V2.md`.

## Feature flag
- Name: `MULTI_LANGUAGE_DROPDOWN_V2`
- Default: **OFF** (production safe)
- Enable locally / staging:
  - API: `MULTI_LANGUAGE_DROPDOWN_V2=1`
  - Mobile: `EXPO_PUBLIC_MULTI_LANGUAGE_DROPDOWN_V2=1`
  - Web: `VITE_MULTI_LANGUAGE_DROPDOWN_V2=1`

Do **not** enable on production Render until manual QA passes and you approve.

## Website (client/src/i18n)
- Bootstrapped via `client/src/main.jsx` → `import "./i18n/index.js"`
- Dictionaries: `client/src/i18n/locales/{en,es,fr,ht,pt,ar,zh-CN,ko,vi}.json`
- Public chrome under `web.*` (nav, footer, home, auth, booking wizard UI, rewards, reviews, etc.)
- Immediate language switch via `setAppLanguage` + `localStorage` key `ifcdc_preferred_language`
- Logged-in users: `preferred_language` on profile (PATCH `/api/auth/profile`)
- Arabic: `document.documentElement.dir=rtl` + `.ifcdc-rtl` CSS (LTR langs unaffected)
- Missing keys: English fallback + console warn (`[i18n] missing key`)

## Locale files (mobile/i18n/locales + client locales)
| Code | Mobile leaves | Client leaves (incl. web) | Parity vs en |
|------|---------------|---------------------------|--------------|
| en | 289 | 487+ | OK |
| es | 289 | match | OK |
| fr | 289 | match | OK |
| ht | 289 | match | OK |
| pt | 289 | match | OK |
| ar | 289 | match | OK (RTL) |
| zh-CN | 289 | match | OK |
| ko | 289 | match | OK |
| vi | 289 | match | OK |

Namespaces covered: common, errors, auth, tabs, home, booking, services, payment, profile, notifications, language, aura, legal, share, **web**.

## Fallback
- i18next `fallbackLng=en`
- Missing keys never render blank: English resource then last key segment
- Email labels fall back to English when a language template is unavailable

## Intentionally not translated
- Barber names, shop names, custom service titles
- User-written bios / reviews / admin notes
- Prices, dates, times, booking IDs (values preserved)

## Admin / Super Admin
- Dashboards remain English by default
- Language only changes if an admin manually selects it in Profile → Language
- Manual Booking / Bypass Mode logic unchanged

## Payments / booking
- No PayPal order/capture/fee logic changes in this feature
- No calendar availability / rewards calculation changes
- Only customer-facing UI chrome and communication templates are translated

## Database
- Column: `app_users.preferred_language` (additive migration)
- Default existing users to `en` unless already `es`
- Does not overwrite existing preferences
- Production backup before migration: `backups/supabase-vtkxuagevtiwtoheomjt-2026-07-23T23-41-54.sql`

## Deployment sequence
1. DB backup (done)
2. Website i18n migration (this change)
3. Enable flag in development (`VITE_MULTI_LANGUAGE_DROPDOWN_V2=1`)
4. Automated tests (`tests/multiLanguageDropdownV2.test.mjs`)
5. Enable in staging + full manual QA
6. Deploy website only after QA passes
7. Next TestFlight build
8. **Do not** submit App Store Review until explicit approval
