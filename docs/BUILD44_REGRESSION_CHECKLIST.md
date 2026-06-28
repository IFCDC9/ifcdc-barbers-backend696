# Build 44 Regression Checklist

**Official stable baseline** — do not ship new app changes until this checklist is fully green and signed off.

| Field | Value |
|-------|--------|
| **Baseline commit** | `6a48ed56` (revert of Build 45; identical to `f76e1f2b`) |
| **Git tag** | `build-44-baseline` |
| **Production API** | https://ifcdc-barbers-backend696.onrender.com |
| **Web** | https://ifcdcbarbersapp.com |
| **iOS TestFlight** | **Build 44** only — **skip Build 45** |
| **Next TestFlight after sign-off** | **Build 46** |
| **Sign-off status** | **NOT SIGNED OFF** — pending 22 manual device tests |

---

## Priorities (in order)

1. Stability  
2. Reliability  
3. Regression-free releases  
4. New features only after the platform is fully stable  

---

## How to run automated checks

```bash
node scripts/verify-build44-automated.mjs
```

Signup + admin approval (uses dedicated QA admin — **not** `service@ifcdc.org`):

```bash
# One-time: provision QA admin (role: admin)
QA_ADMIN_PASSWORD='YourStr0ng!Secret' node scripts/provision-qa-admin.mjs

# Validation (creates rv-* test accounts)
QA_ADMIN_EMAIL=qa-validation@ifcdcbarbersapp.com \
QA_ADMIN_PASSWORD='…' \
node scripts/release-validation.mjs --base=https://ifcdc-barbers-backend696.onrender.com

# Cleanup temp accounts after QA
node scripts/cleanup-production-qa-accounts.mjs
```

---

## Automated layer (last run: all PASS)

| Check | Status |
|-------|--------|
| Phase 2 / V2 quality / Phase 1 portfolio scripts | ✅ PASS |
| Service photo workflow (7/7 HTTPS covers) | ✅ PASS |
| Password reset flow (13/13) | ✅ PASS |
| Supabase storage health | ✅ PASS |
| Booking email gate | ✅ PASS |
| Payment flow audits | ✅ PASS |
| Deploy commit `6a48ed56` | ✅ PASS |
| Discover API, AURA, email/storage health | ✅ PASS |

**Production signup (release-validation, partial):** barber + shop owner registration, pending state, admin notification emails — ✅ PASS.  
**Admin approve/reject flows:** ⏳ pending `QA_ADMIN_PASSWORD` for full run.

---

## Manual device regression — TestFlight Build 44

**Device:** Physical iPhone or iPad  
**Build:** TestFlight **Build 44** (not 45)  
**Backend:** Production (default app config)

Mark each row after testing on device. Record failures in the **Notes / failure** column.

| # | Feature | Test steps | Auto | Device | Notes / failure |
|---|---------|------------|------|--------|-----------------|
| 1 | **Login** | Open app → Log in with email/password → confirm home/profile loads | API ✅ | ☐ | |
| 2 | **Logout** | Profile → Sign out → confirm protected screens require login again | — | ☐ | Client-side JWT clear (no server logout) |
| 3 | **Registration** | Register new customer → confirm account works | API ✅ | ☐ | |
| 4 | **Password reset** | Forgot password → email link → set new password → login | API ✅ | ☐ | |
| 5 | **Profile edit & save** | Profile → Edit Profile → change name + phone → Save → kill app → reopen → values persist | API ✅ | ☐ | Avatar from library is **local-only** on Build 44 |
| 6 | **Portfolio — view** | Open barber portfolio → services, gallery, prices load | API ✅ | ☐ | |
| 7 | **Portfolio — edit/upload** | Barber account → edit headline / upload gallery photo → save | API ✅ | ☐ | |
| 8 | **Service photos aligned** | Each service card shows correct cover (not wrong/missing) | API ✅ | ☐ | |
| 9 | **Services CRUD** | Barber: add service → edit price/duration → delete test service | API ✅ | ☐ | |
| 10 | **Booking flow** | Book → barber/service/slot → PayPal → confirmation | API ✅ | ☐ | |
| 11 | **Calendar** | Barber calendar shows bookings; customer slot picker matches availability | API ✅ | ☐ | |
| 12 | **Admin dashboard** | Super admin or admin: stats/users/bookings load | API ✅ | ☐ | |
| 13 | **Barber approval** | Admin approves pending barber → barber can operate | Partial | ☐ | Complete via release-validation + device |
| 14 | **Shop approval** | Admin approves pending shop owner | Partial | ☐ | Complete via release-validation + device |
| 15 | **AURA** | AURA tab → send message → sensible reply; book/styles hints work | API ✅ | ☐ | |
| 16 | **Discover Haircuts** | Home → “Discover haircuts” **or** Profile → Discover → photos → tap opens portfolio | API ✅ | ☐ | |
| 17 | **Reviews** | After completed booking: leave review (+ photo optional) → visible on portfolio | API ✅ | ☐ | |
| 18 | **Follow-ups** | Profile → “30-day haircut updates” → opt in/out works | API ✅ | ☐ | |
| 19 | **Notifications** | Allow push → receive test/booking notification on device | API ✅ | ☐ | Requires physical device |
| 20 | **Image uploads** | Upload service photo + portfolio photo from camera roll | API ✅ | ☐ | |
| 21 | **Payment flow** | Full PayPal payment completes; booking shows paid status | Audit ✅ | ☐ | |
| 22 | **Email confirmations** | Booking confirmation email arrives in inbox | Infra ✅ | ☐ | |

---

## Failure log (fix one at a time → Build 46+)

| Date | Item # | Failure description | Fix branch | Build | Device verified | Resolved |
|------|--------|---------------------|------------|-------|-----------------|----------|
| — | — | *No failures recorded yet* | — | — | — | — |

**Process per failure:**

1. Log the failing checklist item # above  
2. One fix on a dedicated branch  
3. Deploy backend/web if needed  
4. TestFlight **Build 46** (then 47, 48, …)  
5. Verify on physical device  
6. Re-run full checklist row + adjacent smoke tests  
7. Only then start the next fix  

---

## Sign-off

**Build 44 signed off:** ☐ **NO** (pending all 22 manual device tests)

When every row above is checked and the failure log is empty:

- [ ] All 22 manual device tests passed on Build 44  
- [ ] Automated suite re-run: `node scripts/verify-build44-automated.mjs` → PASS  
- [ ] QA temp accounts cleaned: `node scripts/cleanup-production-qa-accounts.mjs` → 0 accounts  
- [ ] Official sign-off recorded below  

**Signed off by:** _______________  
**Date:** _______________  
**Device(s) tested:** _______________  

After sign-off, the first improvement ships as **TestFlight Build 46**, one verified change at a time.
