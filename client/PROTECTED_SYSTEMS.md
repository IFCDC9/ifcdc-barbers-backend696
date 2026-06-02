# Protected systems (do not regress during UI merges)

When merging **visual/layout only** from the Render baseline (`App.jsx` + `MainLayout` + `styles/global.css`), do **not** replace or simplify:

| System | Primary files |
|--------|----------------|
| PayPal payment flow | `pages/Booking.jsx`, `components/PayPalCheckout.jsx`, `components/PayPalReturnHandler.jsx`, `main.jsx` (PayPalScriptProvider) |
| Booking save flow | `pages/Booking.jsx`, `services/bookingCheckout.js`, `services/api.js` |
| Email confirmations | Server `routes/*`, Resend — not client layout |
| Platform fee logic | `lib/stylePricing.js`, `Booking.jsx` (`computeChargeBreakdown`) |
| Backend696 API | `config/api.js`, `lib/api.js`, `VITE_API_BASE` at build time |
| Login / auth | `pages/Login.jsx`, `services/api.js`, `lib/authSession.js`, `components/RequireRole.jsx` |
| Invite API | `pages/Invite.jsx`, `/api/invite/validate`, `/api/invite/accept` |
| Business phone (display) | `businesses.phone` (DB) → `GET /api/config`; optional `BUSINESS_PHONE` / `VITE_BUSINESS_PHONE` env fallback only |

Legacy hash UI (`MainRoutes.jsx`) is **reference only** — production entry is `main.jsx` → `App.jsx`.
