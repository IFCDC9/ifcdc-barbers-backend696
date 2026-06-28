# Build 46 — Stability fixes (post Build 44 baseline)

**Branch:** `build-46` (from `6a48ed56` / `build-44-baseline`)  
**TestFlight:** Build **46** (Build 45 skipped)  
**Baseline:** Build 44 remains the pre-fix reference; Build 46 is the first stability release.

---

## Targeted fixes in this build

| Area | Change |
|------|--------|
| **Profile save** | Explicit `PATCH /api/auth/profile` on web service; upload local avatars before save; do not clear server photo when saving name/phone only; clearer API errors |
| **Discover Haircuts** | Resolve gallery/review photo URLs via `resolvePublishedImageUrl` so tiles load HTTPS images on device |
| **Portfolio gallery (barber)** | Gallery manager uses `getServiceCardImageUrl` for consistent display |
| **Service photos** | No resolver logic change — existing `servicePhotoResolver` alignment preserved |

---

## Deploy order

1. **Backend** — deploy `server.js` + `socialPortfolioService.js` (API + discover URLs)  
2. **Run automated regression:** `node scripts/verify-build44-automated.mjs`  
3. **TestFlight Build 46:** `cd mobile && eas build --platform ios --profile production`  
4. **Device verify** — re-run checklist items 5, 6, 7, 8, 16 on physical iPhone/iPad  

---

## Device verification (required before sign-off)

- [ ] Profile → Edit Profile → change name/phone → Save → kill app → values persist  
- [ ] Profile photo upload from library persists after reopen  
- [ ] Discover Haircuts → photos load → tap opens portfolio  
- [ ] Barber portfolio → edit headline / upload gallery photo  
- [ ] Service cards show correct cover photos on portfolio + booking  

---

## Regression command

```bash
node scripts/verify-build44-automated.mjs
node scripts/verify-profile-patch.mjs
```

After all checklist items pass on Build 46, update sign-off in `docs/BUILD44_REGRESSION_CHECKLIST.md`.
