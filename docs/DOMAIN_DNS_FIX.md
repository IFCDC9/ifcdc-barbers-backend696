# Fix GoDaddy parking → IFCDC Barbers (Render)

**Updated:** 2026-06-05

## Which domain shows GoDaddy?

| Domain | Current behavior | Use for |
|--------|------------------|---------|
| **ifcdcbarbersapp.com** | GoDaddy parking → redirects to `/lander` | **Primary marketing + invites** (after DNS fix) |
| **www.ifcdcbarbersapp.com** | Same GoDaddy parking | Redirect to apex or CNAME to Render |
| **ifcdc.org** | GoDaddy parking (same 114-byte HTML) | **Do not use** for app/invites until repointed |
| **ifcdcbarbersapp.org** | HTTP 404 (not configured) | Not in use |

**Working today (official SPA):** https://ifcdc-barbers-frontend.onrender.com

Invite emails use `FRONTEND_URL` or fallback `https://ifcdc-barbers-frontend.onrender.com` until DNS is fixed (`publicSiteConfig.cjs`).

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
| **Until DNS propagates** | `https://ifcdc-barbers-frontend.onrender.com` |
| **After DNS live** | `https://ifcdcbarbersapp.com` |

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
