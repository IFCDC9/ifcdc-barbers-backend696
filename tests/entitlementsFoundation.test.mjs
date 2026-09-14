import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPLE_PRODUCTS,
  APPLE_SUBSCRIPTION_GROUP,
  BOOKING_PLATFORM_FEE,
  googleAccessProductId,
  higherPlan,
  planFromAppleProductId,
  planFromGoogleProductId,
  PROMO_OFFER_PLACEHOLDERS,
} from "../monetizationCatalog.js";
import { BARBER_PLATFORM_FEE_USD } from "../subscriptionTier.js";
import { entitlementsEnforceEnabled, entitlementsLockShopsEnabled, entitlementsMode } from "../entitlementFlags.js";
import { resolveEntitlementsSnapshot } from "../entitlementService.js";
import { SUPER_ADMIN_ONLY_CAPABILITIES } from "../managementPermissions.js";
import { effectiveShopAccess } from "../shopAccessPolicy.js";

test("Apple product IDs and prices are exact", () => {
  assert.equal(APPLE_PRODUCTS.multilocation.productId, "ifcdc.barbers.multilocation.monthly");
  assert.equal(APPLE_PRODUCTS.shop.productId, "ifcdc.barbers.shop.monthly");
  assert.equal(APPLE_PRODUCTS.individual.productId, "ifcdc.barbers.individual.monthly");
  assert.equal(APPLE_PRODUCTS.multilocation.listPriceUsd, 59.99);
  assert.equal(APPLE_PRODUCTS.shop.listPriceUsd, 29.99);
  assert.equal(APPLE_PRODUCTS.individual.listPriceUsd, 9.99);
  assert.equal(APPLE_SUBSCRIPTION_GROUP, "IFCDC Barbers Pro Plans");
  assert.equal(planFromAppleProductId("ifcdc.barbers.shop.monthly").rank, 2);
});

test("promo placeholders do not invent offer IDs", () => {
  assert.equal(PROMO_OFFER_PLACEHOLDERS.individual.priceUsd, 4.99);
  assert.equal(PROMO_OFFER_PLACEHOLDERS.shop.priceUsd, 14.99);
  assert.equal(PROMO_OFFER_PLACEHOLDERS.multilocation.priceUsd, 29.99);
  assert.equal(PROMO_OFFER_PLACEHOLDERS.individual.appleOfferId, null);
  assert.equal(PROMO_OFFER_PLACEHOLDERS.shop.appleOfferId, null);
  assert.equal(PROMO_OFFER_PLACEHOLDERS.multilocation.appleOfferId, null);
});

test("Google access product is configurable and flagged", () => {
  delete process.env.GOOGLE_ACCESS_PRODUCT_ID;
  assert.equal(googleAccessProductId(), "ifcdc.barbers.access");
  process.env.GOOGLE_ACCESS_PRODUCT_ID = "ifcdc.barbers.access.preview";
  assert.equal(googleAccessProductId(), "ifcdc.barbers.access.preview");
  delete process.env.GOOGLE_ACCESS_PRODUCT_ID;
  assert.equal(planFromGoogleProductId("ifcdc.barbers.access").productType, "app_access");
});

test("booking platform fee remains $0.99 and a separate field", () => {
  assert.equal(BARBER_PLATFORM_FEE_USD, 0.99);
  assert.equal(BOOKING_PLATFORM_FEE.usd, 0.99);
  assert.equal(BOOKING_PLATFORM_FEE.field, "platform_fee");
});

test("ENTITLEMENTS_ENFORCE defaults off and does not lock shops", () => {
  const prevE = process.env.ENTITLEMENTS_ENFORCE;
  const prevL = process.env.ENTITLEMENTS_LOCK_SHOPS;
  delete process.env.ENTITLEMENTS_ENFORCE;
  delete process.env.ENTITLEMENTS_LOCK_SHOPS;
  assert.equal(entitlementsEnforceEnabled(), false);
  assert.equal(entitlementsLockShopsEnabled(), false);
  assert.equal(entitlementsMode(), "observe_sandbox");
  if (prevE !== undefined) process.env.ENTITLEMENTS_ENFORCE = prevE;
  if (prevL !== undefined) process.env.ENTITLEMENTS_LOCK_SHOPS = prevL;
});

test("role is not a subscription; shop plan inherits by shop id permission", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  const staff = resolveEntitlementsSnapshot({
    userId: "u-staff",
    role: "barber",
    ownSubs: [],
    staffShopIds: [42],
    businessSubs: [
      {
        id: "s1",
        business_id: 42,
        plan_key: "shop",
        status: "active",
        source: "apple",
        current_period_end: "2026-10-14T12:00:00Z",
      },
    ],
    now,
  });
  assert.equal(staff.planKey, "shop");
  assert.equal(staff.role, "barber");
  assert.equal(staff.roleIsNotSubscription, true);
  assert.equal(staff.inheritedFromBusiness[0].businessId, 42);

  const outsider = resolveEntitlementsSnapshot({
    userId: "u-other",
    role: "shop_owner",
    ownSubs: [],
    staffShopIds: [99],
    businessSubs: [
      {
        id: "s1",
        business_id: 42,
        plan_key: "multilocation",
        status: "active",
        source: "apple",
        current_period_end: "2026-10-14T12:00:00Z",
      },
    ],
    now,
  });
  assert.equal(outsider.planKey, null);
  assert.equal(outsider.role, "shop_owner");
});

test("multilocation outranks shop and individual", () => {
  assert.equal(higherPlan("shop", "individual"), "shop");
  assert.equal(higherPlan("individual", "multilocation"), "multilocation");
});

test("cancel and expire keep rows conceptually live as status only", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  const cancelledStillInPeriod = resolveEntitlementsSnapshot({
    userId: "u1",
    role: "barber",
    ownSubs: [
      {
        id: "keep-me",
        plan_key: "individual",
        status: "active",
        cancel_at_period_end: true,
        current_period_end: "2026-10-01T00:00:00Z",
      },
    ],
    now,
  });
  assert.equal(cancelledStillInPeriod.planKey, "individual");
  const expired = resolveEntitlementsSnapshot({
    userId: "u1",
    role: "barber",
    ownSubs: [
      {
        id: "keep-me",
        plan_key: "individual",
        status: "expired",
        current_period_end: "2026-08-01T00:00:00Z",
      },
    ],
    now,
  });
  assert.equal(expired.planKey, null);
  assert.equal(expired.subscriptionStatus, "none");
});

test("managers never receive Super Admin subscription powers", () => {
  const snap = resolveEntitlementsSnapshot({ userId: "m1", role: "shop_manager" });
  for (const cap of SUPER_ADMIN_ONLY_CAPABILITIES) {
    assert.equal(snap.managersCannotReceive.includes(cap), true);
  }
  assert.equal(snap.managersCannotReceive.includes("complimentary_subscription"), true);
});

test("existing approved shop stays bookable under observe mode", () => {
  const access = effectiveShopAccess({
    approval_status: "approved",
    account_status: "active",
    access_plan: "free",
    subscription_status: "inactive",
    bookings_enabled: true,
    payment_processing_enabled: true,
    subscription_enabled: true,
    paid_subscription_required: false,
  });
  assert.equal(access.bookingsEnabled, true);
  assert.equal(access.limitedAccess, false);
});

test("app access is not mixed into planKey", () => {
  const snap = resolveEntitlementsSnapshot({
    userId: "u1",
    role: "user",
    appAccessRows: [{ status: "granted" }],
    ownSubs: [],
  });
  assert.equal(snap.planKey, null);
  assert.equal(snap.appAccess.granted, true);
  assert.equal(snap.fieldsAreSeparate, true);
});
