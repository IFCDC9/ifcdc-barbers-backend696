# Fix GoDaddy parking → IFCDC Barbers (Render)

**Updated:** 2026-06-05

## Domain status

| Domain | Status | Use for |
|--------|--------|---------|
| **ifcdcbarbersapp.com** | **Live** — IFCDC Barbers React SPA | **Primary marketing, invites, legal** |
| **www.ifcdcbarbersapp.com** | **Live** — same SPA | Redirect/CNAME to Render static site |
| **ifcdc-barbers-frontend.onrender.com** | **Live** — same SPA | Fallback if custom domain is down |
| **ifcdc.org** | Separate org site (may still show GoDaddy parking) | Contact email only — **not** the barbers app |
| **ifcdcbarbersapp.org** | Not configured | Not in use |

Invite emails use `FRONTEND_URL` (set to `https://ifcdcbarbersapp.com` on Render) with fallback `PUBLIC_WEB_FALLBACK_URL` → Render SPA (`publicSiteConfig.cjs`).

---

## GoDaddy DNS changes (required)

In **GoDaddy → DNS** for `ifcdcbarbersapp.com`:

### Apex `@`

| Action | Type | Host | Value |
|--------|------|------|--------|
| **Delete** | A | `@` | `15.197.148.33` |
| **Delete** | A | `@` | `3.33.130.190` |
| **Add** | A | `@` | **`216.24.57.1`** (Render) |

Remove **Forwarding** / **Parked** on `@`.

### `www`

| Action | Type | Host | Value |
|--------|------|------|--------|
| **Delete** | A | `www` | parking IPs |
| **Add** | CNAME | `www` | **`ifcdc-barbers-frontend.onrender.com`** |

(Use the exact hostname Render shows under **Custom Domains** for your static site.)

---

## Render Dashboard

1. **Static site** `ifcdc-barbers-frontend` → **Custom Domains** → add `ifcdcbarbersapp.com` and `www.ifcdcbarbersapp.com`.
2. Wait for TLS **Active**.
3. **Redeploy** frontend after merging landing/legal changes.

## Backend env (invite links)

On **ifcdc-barbers-backend696**:

| Phase | `FRONTEND_URL` |
|-------|----------------|
| **Production (DNS live)** | `https://ifcdcbarbersapp.com` |
| **Emergency fallback** | `PUBLIC_WEB_FALLBACK_URL=https://ifcdc-barbers-frontend.onrender.com` |

Optional: `PUBLIC_WEB_FALLBACK_URL=https://ifcdc-barbers-frontend.onrender.com`

---

## Verify

```bash
# Should NOT contain "lander" or GoDaddy
curl -sS https://ifcdcbarbersapp.com | head -3

# Should show IFCDC Barbers React app
curl -sS https://ifcdc-barbers-frontend.onrender.com | head -5

node scripts/verify-public-domains.mjs
```

---

## Canonical URLs (use everywhere)

| Purpose | URL |
|---------|-----|
| Public website / landing | `https://ifcdcbarbersapp.com` |
| Invites | `https://ifcdcbarbersapp.com/invite?token=…` |
| Privacy | `https://ifcdcbarbersapp.com/privacy` |
| Terms | `https://ifcdcbarbersapp.com/terms` |
| Web booking | `https://ifcdcbarbersapp.com/booking` |
| API (not for browsers) | `https://ifcdc-barbers-backend696.onrender.com` |
| Contact | `service@ifcdc.org` |
| Transactional email | `notifications@ifcdcbarbersapp.com` |
