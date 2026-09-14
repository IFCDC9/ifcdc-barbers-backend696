/**
 * Production monetization catalog — source of truth for product IDs and list prices.
 * Apple product IDs are exact App Store Connect IDs (do not invent).
 * Google access product ID is configurable and must be confirmed with Tessa before production.
 */

import { BARBER_PLATFORM_FEE_USD } from "./subscriptionTier.js";

export const APPLE_BUNDLE_ID = "com.ifcdc.barbers";
export const GOOGLE_PACKAGE_NAME = "com.ifcdc.barbers";

export const APPLE_SUBSCRIPTION_GROUP = "IFCDC Barbers Pro Plans";

export const PLAN_KEYS = Object.freeze({
  INDIVIDUAL: "individual",
  SHOP: "shop",
  MULTILOCATION: "multilocation",
});

export const PRODUCT_TYPES = Object.freeze({
  SUBSCRIPTION: "subscription",
  APP_ACCESS: "app_access",
  BOOKING_PLATFORM_FEE: "booking_platform_fee",
});

/** Rank: Multi-Location > Shop > Individual */
export const PLAN_RANK = Object.freeze({
  [PLAN_KEYS.INDIVIDUAL]: 1,
  [PLAN_KEYS.SHOP]: 2,
  [PLAN_KEYS.MULTILOCATION]: 3,
});

export const APPLE_PRODUCTS = Object.freeze({
  [PLAN_KEYS.MULTILOCATION]: {
    productId: "ifcdc.barbers.multilocation.monthly",
    planKey: PLAN_KEYS.MULTILOCATION,
    listPriceUsd: 59.99,
    period: "P1M",
    rank: PLAN_RANK[PLAN_KEYS.MULTILOCATION],
    intro: "free_first_month",
  },
  [PLAN_KEYS.SHOP]: {
    productId: "ifcdc.barbers.shop.monthly",
    planKey: PLAN_KEYS.SHOP,
    listPriceUsd: 29.99,
    period: "P1M",
    rank: PLAN_RANK[PLAN_KEYS.SHOP],
    intro: "free_first_month",
  },
  [PLAN_KEYS.INDIVIDUAL]: {
    productId: "ifcdc.barbers.individual.monthly",
    planKey: PLAN_KEYS.INDIVIDUAL,
    listPriceUsd: 9.99,
    period: "P1M",
    rank: PLAN_RANK[PLAN_KEYS.INDIVIDUAL],
    intro: "free_first_month",
  },
});

export const GOOGLE_SUB_PRODUCTS = Object.freeze({
  [PLAN_KEYS.MULTILOCATION]: {
    productId: "ifcdc.barbers.multilocation.monthly",
    planKey: PLAN_KEYS.MULTILOCATION,
    listPriceUsd: 59.99,
    period: "P1M",
    rank: PLAN_RANK[PLAN_KEYS.MULTILOCATION],
    intro: "free_first_month",
  },
  [PLAN_KEYS.SHOP]: {
    productId: "ifcdc.barbers.shop.monthly",
    planKey: PLAN_KEYS.SHOP,
    listPriceUsd: 29.99,
    period: "P1M",
    rank: PLAN_RANK[PLAN_KEYS.SHOP],
    intro: "free_first_month",
  },
  [PLAN_KEYS.INDIVIDUAL]: {
    productId: "ifcdc.barbers.individual.monthly",
    planKey: PLAN_KEYS.INDIVIDUAL,
    listPriceUsd: 9.99,
    period: "P1M",
    rank: PLAN_RANK[PLAN_KEYS.INDIVIDUAL],
    intro: "free_first_month",
  },
});

/** Default Google one-time access SKU — confirm with Tessa before production. */
export const GOOGLE_ACCESS_PRODUCT_ID_DEFAULT = "ifcdc.barbers.access";

export function googleAccessProductId() {
  const fromEnv = String(process.env.GOOGLE_ACCESS_PRODUCT_ID || "").trim();
  return fromEnv || GOOGLE_ACCESS_PRODUCT_ID_DEFAULT;
}

export const GOOGLE_ACCESS_PRODUCT = Object.freeze({
  productId: GOOGLE_ACCESS_PRODUCT_ID_DEFAULT,
  productType: PRODUCT_TYPES.APP_ACCESS,
  listPriceUsd: 0.99,
  restorable: true,
  consumable: false,
  accountBound: true,
  confirmWithTessaBeforeProduction: true,
});

/**
 * Promotional / win-back offers — prices only.
 * Do NOT invent App Store Connect offer IDs.
 * confirm App Store Connect promotional offer IDs with Tessa
 */
export const PROMO_OFFER_PLACEHOLDERS = Object.freeze({
  [PLAN_KEYS.INDIVIDUAL]: {
    priceUsd: 4.99,
    durationMonths: 3,
    appleOfferId: null, // confirm App Store Connect promotional offer IDs with Tessa
    googleOfferId: null, // confirm with Tessa before production
  },
  [PLAN_KEYS.SHOP]: {
    priceUsd: 14.99,
    durationMonths: 3,
    appleOfferId: null, // confirm App Store Connect promotional offer IDs with Tessa
    googleOfferId: null, // confirm with Tessa before production
  },
  [PLAN_KEYS.MULTILOCATION]: {
    priceUsd: 29.99,
    durationMonths: 3,
    appleOfferId: null, // confirm App Store Connect promotional offer IDs with Tessa
    googleOfferId: null, // confirm with Tessa before production
  },
});

export const BOOKING_PLATFORM_FEE = Object.freeze({
  usd: BARBER_PLATFORM_FEE_USD,
  field: "platform_fee",
  note: "Per-booking customer checkout fee. Never combined with app access or SaaS subscription.",
});

const APPLE_BY_ID = new Map(Object.values(APPLE_PRODUCTS).map((p) => [p.productId, p]));
const GOOGLE_SUB_BY_ID = new Map(Object.values(GOOGLE_SUB_PRODUCTS).map((p) => [p.productId, p]));

export function planFromAppleProductId(productId) {
  return APPLE_BY_ID.get(String(productId || "").trim()) || null;
}

export function planFromGoogleProductId(productId) {
  const id = String(productId || "").trim();
  if (id && id === googleAccessProductId()) {
    return { productId: id, productType: PRODUCT_TYPES.APP_ACCESS, planKey: null };
  }
  const sub = GOOGLE_SUB_BY_ID.get(id);
  if (sub) return { ...sub, productType: PRODUCT_TYPES.SUBSCRIPTION };
  return null;
}

export function higherPlan(a, b) {
  const ra = PLAN_RANK[a] || 0;
  const rb = PLAN_RANK[b] || 0;
  return ra >= rb ? a : b;
}

export function catalogPublic() {
  return {
    apple: {
      bundleId: APPLE_BUNDLE_ID,
      subscriptionGroup: APPLE_SUBSCRIPTION_GROUP,
      rank: ["multilocation", "shop", "individual"],
      intro: "free first month",
      products: Object.values(APPLE_PRODUCTS),
      promoPlaceholders: PROMO_OFFER_PLACEHOLDERS,
      promoOfferIds: "confirm App Store Connect promotional offer IDs with Tessa",
    },
    google: {
      packageName: GOOGLE_PACKAGE_NAME,
      products: Object.values(GOOGLE_SUB_PRODUCTS),
      access: {
        ...GOOGLE_ACCESS_PRODUCT,
        productId: googleAccessProductId(),
        confirmWithTessaBeforeProduction: true,
      },
      promoPlaceholders: PROMO_OFFER_PLACEHOLDERS,
    },
    bookingPlatformFeeUsd: BOOKING_PLATFORM_FEE.usd,
    fieldsAreSeparate: {
      appAccess: "app_access_entitlements",
      subscription: "account_subscriptions.plan_key",
      bookingFee: "BARBER_PLATFORM_FEE_USD",
    },
  };
}
