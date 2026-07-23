# Translation Coverage Report — MULTI_LANGUAGE_DROPDOWN_V2

Generated: 2026-07-23T23:55:11.064Z

## Overall (website + shared dictionaries in `client/src/i18n/locales`)

| Language | Leaf keys | Missing vs EN | Coverage |
|----------|-----------|---------------|----------|
| en | 500 | 0 | 100% |
| es | 500 | 0 | 100% |
| fr | 500 | 0 | 100% |
| ht | 500 | 0 | 100% |
| pt | 500 | 0 | 100% |
| ar | 500 | 0 | 100% |
| zh-CN | 500 | 0 | 100% |
| ko | 500 | 0 | 100% |
| vi | 500 | 0 | 100% |

English leaf keys: **500** (web namespace: **211**)

## By major area
| Area | Status |
|------|--------|
| Website (nav/footer/home/public pages) | Wired to `web.*` — 100% key parity all langs |
| Registration and login | Wired — 100% |
| Booking (UI chrome) | Wired — 100% (PayPal/booking math unchanged) |
| Payments (UI labels) | Wired — 100% |
| Rewards | Wired — 100% |
| Reviews | Wired — 100% |
| Emails | Backend multilingual labels (prior commit) — admin ops stay EN |
| Notifications | Customer-facing dictionaries present |
| Mobile navigation | Prior mobile i18n + flag |
| Arabic RTL | `dir=rtl` + `.ifcdc-rtl` CSS — implemented |

## Remaining English-by-design
- Admin / Super Admin operational screens
- Barber/shop/customer names, bios, reviews, booking notes
- Some edge marketing / onboarding business pages (SignupBusiness legacy shell)
- Legal document bodies (policy text may remain English pending legal review)

## Feature flag
`MULTI_LANGUAGE_DROPDOWN_V2` / `VITE_MULTI_LANGUAGE_DROPDOWN_V2` — **OFF by default in production**
