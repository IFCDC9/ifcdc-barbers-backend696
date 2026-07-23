# MULTI_LANGUAGE_DROPDOWN_V2 — Translation coverage report
Generated from locale leaf-key parity checks.

## Feature flag
- Name: `MULTI_LANGUAGE_DROPDOWN_V2`
- Default: **OFF** (production safe)
- Enable locally:
  - API: `MULTI_LANGUAGE_DROPDOWN_V2=1`
  - Mobile: `EXPO_PUBLIC_MULTI_LANGUAGE_DROPDOWN_V2=1`
  - Web: `VITE_MULTI_LANGUAGE_DROPDOWN_V2=1`

## Locale files (mobile/i18n/locales)
| Code | File | Leaf keys | Parity vs en |
|------|------|-----------|--------------|
| en | en.json | 289 | source |
| es | es.json | 289 | OK |
| fr | fr.json | 289 | OK |
| ht | ht.json | 289 | OK |
| pt | pt.json | 289 | OK |
| ar | ar.json | 289 | OK (RTL) |
| zh-CN | zh-CN.json | 289 | OK |
| ko | ko.json | 289 | OK |
| vi | vi.json | 289 | OK |

Namespaces covered: common, errors, auth, tabs, home, booking, services, payment, profile, notifications, language, aura, legal, share.

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

## Payments
- No PayPal order/capture/fee logic changes in this feature
