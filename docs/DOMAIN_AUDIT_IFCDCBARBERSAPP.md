# Domain audit: ifcdcbarbersapp.com

**Audit date:** 2026-06-01  
**Symptom:** `https://ifcdcbarbersapp.com` shows a GoDaddy parking/lander page, not the IFCDC Barbers React app.

---

## Executive summary

| Layer | Status | Finding |
|-------|--------|---------|
| **GoDaddy DNS** | ❌ Wrong | Apex + `www` point to GoDaddy parking IPs (`15.197.148.33`, `3.33.130.190`), not Render |
| **TLS certificate** | ❌ Wrong host | Issued by **GoDaddy** for parking — not Render/Let's Encrypt |
| **Render static site** | ❌ Not live | `https://ifcdc-barbers-frontend.onrender.com` → **404** (`x-render-routing: no-server`) |
| **Custom domain on Render** | ❌ Cannot verify | No Render API access from repo; live probes show domain never reaches Render |
| **Working production frontend** | ❌ None found | No `*.onrender.com` URL currently serves the React build |
| **Backend API** | ✅ Live | `https://ifcdc-barbers-backend696.onrender.com` (JSON API only) |

**Primary blocker:** The production frontend static site is **not deployed on Render**, and the custom domain DNS still points at **GoDaddy parking**. Invite links and SPA routes cannot work until both are fixed.

---

## 1. Intended Render frontend service (from repo)

Blueprint: `render.yaml`

| Field | Value |
|-------|--------|
| Service type | `static_site` |
| Service name | **`ifcdc-barbers-frontend`** |
| Root directory | `client` |
| Build | `npm install && npm run build` |
| Publish path | `dist` |
| SPA rewrite | `/*` → `/index.html` (rewrite) |
| Build env | `VITE_API_BASE=https://ifcdc-barbers-backend696.onrender.com` |

Expected default URL after deploy:

**`https://ifcdc-barbers-frontend.onrender.com`**

---

## 2. Render Dashboard — Custom Domains (you must verify)

I cannot open your Render account from this environment. On the **static site** service (not the backend web service):

**Render → `ifcdc-barbers-frontend` → Settings → Custom Domains**

Confirm both are listed:

- `ifcdcbarbersapp.com`
- `www.ifcdcbarbersapp.com`

For each domain, note:

- **Verification status** (verified / pending / failed)
- **Certificate status** (active / provisioning / failed)

If domains are attached to **`ifcdc-barbers-backend`** or **`ifcdc-barbers-backend696`** instead, that is wrong — those are API services and do not serve the React app.

---

## 3. DNS records Render expects (GoDaddy)

Per [Render DNS docs](https://render.com/docs/configure-other-dns) (GoDaddy uses standard A + CNAME):

### Apex: `ifcdcbarbersapp.com`

| Type | Host | Value | Notes |
|------|------|--------|--------|
| **A** | `@` | **`216.24.57.1`** | Render load balancer for apex / SSL provisioning |
| — | — | Remove parking A records | Delete `15.197.148.33`, `3.33.130.190` |
| — | — | Remove **AAAA** | Render does not support IPv6 for custom domains |

Do **not** use GoDaddy “Forwarding” or “Parked” for `@` while using Render.

### WWW: `www.ifcdcbarbersapp.com`

| Type | Host | Value |
|------|------|--------|
| **CNAME** | `www` | **`ifcdc-barbers-frontend.onrender.com`** |

(Use the exact hostname shown in Render **Custom Domains** after the static site exists — it may differ if you renamed the service.)

### Optional Render verification records

When you add a custom domain in Render, the dashboard may show extra records (e.g. `_acme-challenge`, `_cf-custom-hostname`). Add those exactly as shown for your service ID.

---

## 4. Current GoDaddy DNS (live lookup)

**Nameservers:** `ns21.domaincontrol.com`, `ns22.domaincontrol.com` (GoDaddy)

### `ifcdcbarbersapp.com` (apex)

| Type | Current value | Expected for Render |
|------|----------------|---------------------|
| **A** | `15.197.148.33` | ❌ → remove |
| **A** | `3.33.130.190` | ❌ → remove |
| **A** | — | ✅ add `216.24.57.1` |
| **CNAME** | (none to Render) | — |
| **AAAA** | (none observed) | keep none |

Reverse DNS on parking IPs → `awsglobalaccelerator.com` (GoDaddy parking CDN).

### `www.ifcdcbarbersapp.com`

| Type | Current value | Expected |
|------|----------------|----------|
| **A** | Same parking IPs as apex | ❌ |
| **CNAME** | (none to Render) | ✅ `www` → `ifcdc-barbers-frontend.onrender.com` |

### Other records (keep unless Render conflicts)

- **TXT:** Google site verification (OK to keep)
- **MX:** (none in quick lookup)

---

## 5. Root-cause analysis

| Hypothesis | Verdict | Evidence |
|------------|---------|----------|
| **A record wrong** | ✅ **Yes** | Apex uses GoDaddy parking IPs, not `216.24.57.1` |
| **CNAME wrong** | ✅ **Yes** | `www` has no CNAME to `*.onrender.com` |
| **Domain on wrong Render service** | ⚠️ **Likely N/A** | Frontend service does not exist yet (`no-server`) |
| **SSL provisioning failed** | ⚠️ **Secondary** | Cert is GoDaddy parking cert; Render SSL never engaged |
| **Domain verification incomplete** | ⚠️ **Likely** | DNS never pointed at Render |
| **GoDaddy parking / forwarding** | ✅ **Yes** | Body redirects to `/lander`; `window.LANDER_SYSTEM="PW"`; wsimg.com parking assets |

---

## 6. Which URL hosts the working frontend today?

**None identified.**

| URL | HTTP | Content |
|-----|------|---------|
| `https://ifcdcbarbersapp.com` | 200 | GoDaddy parking → `/lander` |
| `https://www.ifcdcbarbersapp.com` | 200 | Same parking |
| `https://ifcdc-barbers-frontend.onrender.com` | **404** | `x-render-routing: no-server` |
| `https://ifcdc-barbers-backend696.onrender.com` | 200 | JSON API only |
| `https://ifcdc-barbers-backend.onrender.com` | 200 | Older API (`IFCDC Barbers Platform`) |

The React app must be **created and deployed** as a Render static site before any URL can serve `/`, `/login`, or `/invite`.

---

## 7. Fix procedure (ordered)

### Step A — Create / deploy frontend on Render

1. Render Dashboard → **Blueprints** → sync repo `ifcdc-barbers-backend696` / `ifcdc-barbers-backend`, **or**
2. **New → Static Site** → connect repo → `rootDir: client`, build/publish per `render.yaml`.
3. Wait until **`https://ifcdc-barbers-frontend.onrender.com`** returns **200** and HTML contains `IFCDC` / React root (not `Not Found`).

### Step B — Add custom domains on that static site

1. Static site → **Settings → Custom Domains → Add**
2. Add `ifcdcbarbersapp.com` and `www.ifcdcbarbersapp.com`
3. Copy any verification hostnames Render shows

### Step C — Update GoDaddy DNS

1. GoDaddy → Domain → **DNS** (not Forwarding)
2. **Disable** domain forwarding / parking / “Coming Soon”
3. Replace apex **A** records with **`216.24.57.1`** only
4. Add **CNAME** `www` → `ifcdc-barbers-frontend.onrender.com`
5. Remove conflicting A records on `www`
6. Wait for propagation (often 5–30 min; up to 48h)

### Step D — Confirm Render SSL

In Custom Domains, both domains should show **Verified** and certificate **Active** (Let's Encrypt via Render).

### Step E — Post-fix verification

```bash
# DNS
dig +short ifcdcbarbersapp.com A          # expect 216.24.57.1
dig +short www.ifcdcbarbersapp.com CNAME  # expect ...onrender.com

# App
curl -sI https://ifcdcbarbersapp.com/ | head -5
curl -s https://ifcdcbarbersapp.com/ | head -c 200   # expect React index.html, not /lander redirect

curl -sI "https://ifcdcbarbersapp.com/login"
curl -sI "https://ifcdcbarbersapp.com/invite?token=test"   # 200 HTML, not 404 file

# Backend invite API (after backend redeploy)
curl -s "https://ifcdc-barbers-backend696.onrender.com/api/invite/validate?token=test"
# expect {"ok":false,...} not route not_found
```

| Check | Pass criteria |
|-------|----------------|
| Homepage | IFCDC Barbers UI, not GoDaddy lander |
| Login | `/login` loads React auth screen |
| Invite | `/invite?token=…` loads Accept invitation UI |
| SPA rewrite | Direct navigation to `/invite` returns `index.html` (not plain 404) |
| Invite email | Link uses `https://ifcdcbarbersapp.com/invite?token=…` |
| Backend | `FRONTEND_URL=https://ifcdcbarbersapp.com` on backend696 |

### Step F — Re-test invitation flow

1. Admin → Invite User → new email  
2. Open link in browser → invite page (not JSON, not parking)  
3. Accept → user created → visible in admin  
4. Repeat from iPhone Mail / TestFlight

---

## 8. Why invite repair was blocked

Invite code and `FRONTEND_URL` are correct in git, but:

1. **Domain never reaches Render** → emails open GoDaddy parking  
2. **Frontend static site not deployed** → no `*.onrender.com` target for DNS  
3. **Backend** may still need manual deploy for `/api/invite/validate` (separate issue)

Fix **domain + frontend deploy first**; then re-test invites.

---

## 9. Quick reference

| Role | URL |
|------|-----|
| Public web app (target) | `https://ifcdcbarbersapp.com` |
| Render static site (after deploy) | `https://ifcdc-barbers-frontend.onrender.com` |
| API (production) | `https://ifcdc-barbers-backend696.onrender.com` |
| DNS registrar | GoDaddy (`domaincontrol.com`) |
| Render apex A | `216.24.57.1` |
| Render www CNAME | `<your-static-service>.onrender.com` |
