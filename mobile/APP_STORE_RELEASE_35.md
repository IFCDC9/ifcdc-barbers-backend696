# IFCDC Barbers — App Store Release Package (Version 1.0, Build 35)

## Build

| Field | Value |
|-------|--------|
| Version | 1.0.0 |
| Build | 35 |
| Bundle ID | `com.ifcdc.barbers` |
| EAS Build ID | `f146102a-edd9-448b-b15a-c92a94f5de6b` |
| ASC App ID | `6766149605` |

## Screenshots (required — captured)

**Location:** `mobile/fastlane/screenshots/en-US/`

| Device slot (App Store Connect) | Files | Size |
|----------------------------------|-------|------|
| **iPhone 6.5-inch Display** | `iPhone 16 Plus-01_Home.png` … `06_AURA.png` | 1284×2778 |
| **iPad 13-inch Display** | `iPad Pro 13-inch (M4)-01_Home.png` … `06_AURA.png` | 2064×2752 |

Screens show production UI synced with Build 35 API (`ifcdcbarbersapp.com`):

1. Home  
2. Barbers (booking step)  
3. Booking (date/time step)  
4. Services/Styles (`/styles`)  
5. Profile  
6. AURA  

**Regenerate:** `npm run capture:asc-screenshots`

**Upload via API** (if you have App Store Connect API key `.p8`):

```bash
export APP_STORE_CONNECT_ISSUER_ID="your-issuer-uuid"
export APP_STORE_CONNECT_KEY_ID="AT957SKG93"
export APP_STORE_CONNECT_PRIVATE_KEY_PATH="/path/to/AuthKey_AT957SKG93.p8"
npm run upload:asc-screenshots
```

**Upload manually:** App Store Connect → App Store → Version 1.0 → Screenshots → drag files into **6.5-inch iPhone** and **13-inch iPad** slots.

## Metadata (synced)

`eas metadata:push` completed:

- **Support URL:** https://ifcdcbarbersapp.com  
- **Privacy Policy:** https://ifcdcbarbersapp.com/privacy  
- **Marketing URL:** https://ifcdcbarbersapp.com  
- **Review contact:** ifcdcbarbersapp@gmail.com  
- **Categories:** Lifestyle, Business  
- **Release:** automatic after approval  

## Pre-submission checklist

- [ ] Upload 6 iPhone + 6 iPad screenshots (above)  
- [ ] Select **Build 35** on version 1.0  
- [ ] App Privacy questionnaire complete in ASC  
- [ ] No blocking errors on version page  
- [ ] **Add for Review** enabled  
- [ ] Submit for Review (or `fastlane submit_app_store_review` with API key / 2FA)

## Production verification

```bash
node scripts/test-production-readiness.mjs   # 16/16
npm run verify:password-reset              # 13/13
npm run verify:storage
npm run verify:domains
```

## App Store Connect

https://appstoreconnect.apple.com/apps/6766149605/appstore
