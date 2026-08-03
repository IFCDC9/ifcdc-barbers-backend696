# Multilingual QA Results — MULTI_LANGUAGE_DROPDOWN_V2

Generated: 2026-07-24T02:54:57.594Z

## Verdict: **PASS**

| Area | Pass | Fail |
|------|------|------|
| website_locales | 9 | 0 |
| arabic_rtl | 2 | 0 |
| mobile_locales | 9 | 0 |
| feature_flag | 4 | 0 |
| unit_tests | 1 | 0 |
| client_build | 2 | 0 |
| payment_protection | 3 | 0 |
| device_matrix | 1 | 0 |

## Detail
### website_locales
- PASS: en: 500 leaves, parity OK
- PASS: es: 500 leaves, parity OK
- PASS: fr: 500 leaves, parity OK
- PASS: ht: 500 leaves, parity OK
- PASS: pt: 500 leaves, parity OK
- PASS: ar: 500 leaves, parity OK
- PASS: zh-CN: 500 leaves, parity OK
- PASS: ko: 500 leaves, parity OK
- PASS: vi: 500 leaves, parity OK

### arabic_rtl
- PASS: ar web.nav.home = الرئيسية
- PASS: client languages.js marks ar as rtl

### mobile_locales
- PASS: en: 289 leaves OK
- PASS: es: 289 leaves OK
- PASS: fr: 289 leaves OK
- PASS: ht: 289 leaves OK
- PASS: pt: 289 leaves OK
- PASS: ar: 289 leaves OK
- PASS: zh-CN: 289 leaves OK
- PASS: ko: 289 leaves OK
- PASS: vi: 289 leaves OK

### feature_flag
- PASS: MULTI_LANGUAGE_DROPDOWN_V2=1 enables V2
- PASS: default OFF (production safe)
- PASS: flag OFF registry → en,es only
- PASS: flag ON → en, es, fr, ht, pt, ar, zh-CN, ko, vi

### unit_tests
- PASS: multiLanguageDropdownV2.test.mjs passed

### client_build
- PASS: vite build with VITE_MULTI_LANGUAGE_DROPDOWN_V2=1 OK
- PASS: all 9 native language labels present in bundle

### payment_protection
- PASS: appBookingCheckoutRoutes.cjs present (logic not removed)
- PASS: client/src/lib/bookingPaymentTotals.js present (logic not removed)
- PASS: client/src/lib/platformFee.js present (logic not removed)

### device_matrix
- PASS: Automated gate covers locales/flag/RTL metadata/build. Physical iPhone/Android/Windows/Safari matrix remains operator TestFlight + browser QA.

## Device / browser matrix (operator)
| Device / browser | Status |
|------------------|--------|
| Chrome (Mac desktop) | Covered by live/build smoke when --live used |
| Safari (Mac) | Operator |
| Windows Chrome | Operator |
| Mobile website (iPhone Safari) | Operator / TestFlight webview |
| Mobile website (Android Chrome) | Operator |
| iPhone app (TestFlight) | After next build |
| Android app | After next build |

## Pass conditions checked automatically
- No missing locale keys vs English
- No empty translation strings
- Arabic marked RTL + Arabic nav sample translated
- Feature flag OFF by default / ON expands to 9 languages
- Client production build with flag ON includes native language labels
- PayPal/booking support files still present
