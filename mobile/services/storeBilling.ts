/**
 * StoreKit 2 / Google Play Billing client.
 * Uses expo-iap when present (EAS production builds). Never trusts local purchase status;
 * always POST /api/billing/confirm and GET /api/entitlements/me.
 *
 * Promo/win-back: confirm App Store Connect promotional offer IDs with Tessa — do not invent IDs.
 * Google access SKU: confirm with Tessa before production.
 */

import { Platform } from "react-native";
import { apiFetch } from "./api";

export const APPLE_BUNDLE_ID = "com.ifcdc.barbers";
export const GOOGLE_PACKAGE_NAME = "com.ifcdc.barbers";
export const APPLE_SUBSCRIPTION_GROUP = "IFCDC Barbers Pro Plans";

export const APPLE_PRODUCT_IDS = [
  "ifcdc.barbers.multilocation.monthly",
  "ifcdc.barbers.shop.monthly",
  "ifcdc.barbers.individual.monthly",
] as const;

export const GOOGLE_SUB_PRODUCT_IDS = [
  "ifcdc.barbers.multilocation.monthly",
  "ifcdc.barbers.shop.monthly",
  "ifcdc.barbers.individual.monthly",
] as const;

/** Configurable default — confirm with Tessa before production */
export const GOOGLE_ACCESS_PRODUCT_ID = "ifcdc.barbers.access";

export const PLAN_RANK: Record<string, number> = {
  "ifcdc.barbers.individual.monthly": 1,
  "ifcdc.barbers.shop.monthly": 2,
  "ifcdc.barbers.multilocation.monthly": 3,
};

export const LIST_PRICE_USD: Record<string, number> = {
  "ifcdc.barbers.individual.monthly": 9.99,
  "ifcdc.barbers.shop.monthly": 29.99,
  "ifcdc.barbers.multilocation.monthly": 59.99,
  [GOOGLE_ACCESS_PRODUCT_ID]: 0.99,
};

export const PROMO_PLACEHOLDERS = {
  individual: { productId: "ifcdc.barbers.individual.monthly", priceUsd: 4.99, months: 3, offerId: null as string | null },
  shop: { productId: "ifcdc.barbers.shop.monthly", priceUsd: 14.99, months: 3, offerId: null as string | null },
  multilocation: { productId: "ifcdc.barbers.multilocation.monthly", priceUsd: 29.99, months: 3, offerId: null as string | null },
};

type IapModule = {
  initConnection?: () => Promise<boolean>;
  endConnection?: () => Promise<void>;
  fetchProducts?: (args: { skus: string[]; type?: string }) => Promise<unknown[]>;
  getProducts?: (skus: string[]) => Promise<unknown[]>;
  getSubscriptions?: (skus: string[]) => Promise<unknown[]>;
  requestPurchase?: (args: unknown) => Promise<unknown>;
  getAvailablePurchases?: () => Promise<unknown[]>;
  restorePurchases?: () => Promise<unknown[]>;
  finishTransaction?: (args: unknown) => Promise<void>;
  getSubscriptionStatus?: (sku: string) => Promise<unknown>;
};

async function loadIap(): Promise<IapModule | null> {
  try {
    // Native StoreKit / Play Billing — available on EAS production binaries, not Expo Go.
    const mod = await import("expo-iap");
    return mod as unknown as IapModule;
  } catch {
    return null;
  }
}

function skuList(): string[] {
  if (Platform.OS === "ios") return [...APPLE_PRODUCT_IDS];
  return [...GOOGLE_SUB_PRODUCT_IDS, GOOGLE_ACCESS_PRODUCT_ID];
}

export async function fetchStoreProducts(): Promise<{
  products: Array<Record<string, unknown>>;
  native: boolean;
  error?: string;
}> {
  const iap = await loadIap();
  if (!iap) {
    return {
      products: skuList().map((id) => ({
        id,
        productId: id,
        displayPrice: `$${LIST_PRICE_USD[id]?.toFixed(2) || ""}`,
        price: LIST_PRICE_USD[id],
        title: id,
        native: false,
      })),
      native: false,
      error: "StoreKit/Play Billing native module requires an EAS production build (not Expo Go).",
    };
  }
  if (iap.initConnection) await iap.initConnection();
  const skus = skuList();
  let products: unknown[] = [];
  if (iap.fetchProducts) {
    products = await iap.fetchProducts({
      skus,
      type: Platform.OS === "ios" ? "subs" : undefined,
    });
  } else if (Platform.OS === "ios" && iap.getSubscriptions) {
    products = await iap.getSubscriptions(APPLE_PRODUCT_IDS as unknown as string[]);
  } else if (iap.getProducts) {
    products = await iap.getProducts(skus);
  }
  return { products: (products || []) as Array<Record<string, unknown>>, native: true };
}

export function introEligibilityFromProduct(product: Record<string, unknown>): {
  eligible: boolean | null;
  intro: string;
} {
  const intro = product.subscriptionOffering || product.introductoryPrice || product.introPrice;
  if (intro == null) return { eligible: null, intro: "free first month (StoreKit eligibility when native)" };
  return { eligible: true, intro: String(intro) };
}

/**
 * Promotional offer purchase stub.
 * confirm App Store Connect promotional offer IDs with Tessa
 */
export async function purchaseWithPromoOffer(_productId: string, offerId: string | null) {
  if (!offerId) {
    return {
      ok: false,
      error: "promo_offer_id_missing",
      message: "confirm App Store Connect promotional offer IDs with Tessa",
    };
  }
  return purchaseProduct(_productId, { offerId });
}

export async function purchaseProduct(
  productId: string,
  opts: { offerId?: string; upgradeFrom?: string } = {},
): Promise<{ ok: boolean; error?: string; confirm?: unknown }> {
  const iap = await loadIap();
  if (!iap?.requestPurchase) {
    return { ok: false, error: "native_iap_unavailable" };
  }
  const rankTo = PLAN_RANK[productId] || 0;
  const rankFrom = opts.upgradeFrom ? PLAN_RANK[opts.upgradeFrom] || 0 : 0;
  const purchase = await iap.requestPurchase({
    request: {
      ios: {
        sku: productId,
        andDangerouslyFinishTransactionAutomatically: false,
        appAccountToken: undefined,
        withOffer: opts.offerId
          ? { identifier: opts.offerId /* confirm App Store Connect promotional offer IDs with Tessa */ }
          : undefined,
      },
      android: {
        skus: [productId],
        replacementMode: rankTo && rankFrom ? (rankTo > rankFrom ? 1 : 2) : undefined,
      },
    },
    type: productId === GOOGLE_ACCESS_PRODUCT_ID ? "in-app" : "subs",
  });
  const confirm = await confirmPurchaseWithBackend(productId, purchase);
  if (iap.finishTransaction && purchase) {
    try {
      await iap.finishTransaction({ purchase, isConsumable: false });
    } catch {
      /* server is source of truth */
    }
  }
  return { ok: Boolean(confirm && (confirm as { ok?: boolean }).ok !== false), confirm };
}

export async function restorePurchases(): Promise<{ ok: boolean; confirmations: unknown[]; error?: string }> {
  const iap = await loadIap();
  const purchases = iap?.getAvailablePurchases
    ? await iap.getAvailablePurchases()
    : iap?.restorePurchases
      ? await iap.restorePurchases()
      : [];
  const confirmations = [];
  for (const p of purchases || []) {
    const rec = p as Record<string, unknown>;
    const productId = String(rec.productId || rec.productIdentifier || "");
    confirmations.push(await confirmPurchaseWithBackend(productId, rec, true));
  }
  return { ok: true, confirmations };
}

export async function confirmPurchaseWithBackend(
  productId: string,
  purchase: unknown,
  restored = false,
): Promise<unknown> {
  const rec = (purchase || {}) as Record<string, unknown>;
  const platform = Platform.OS === "ios" ? "apple" : "google";
  const body: Record<string, unknown> = {
    platform,
    productId,
    restored,
    // never send client status as authority
  };
  if (platform === "apple") {
    body.transactionJws = rec.transactionReceipt || rec.purchaseToken || rec.jwsRepresentation || rec.transactionId;
    body.signedTransactionInfo = rec.signedTransactionInfo || rec.jwsRepresentation;
  } else {
    body.purchaseToken = rec.purchaseToken || rec.purchaseTokenAndroid;
    body.packageName = GOOGLE_PACKAGE_NAME;
  }
  return apiFetch("/api/billing/confirm", { method: "POST", body: JSON.stringify(body) });
}

export async function fetchEntitlementsMe(): Promise<unknown> {
  return apiFetch("/api/entitlements/me", { method: "GET" });
}

export function displayPrice(product: Record<string, unknown>): string {
  const live = String(product.displayPrice || product.localizedPrice || product.priceString || "").trim();
  if (live) return live;
  const id = String(product.productId || product.id || "");
  const fallback = LIST_PRICE_USD[id];
  return fallback != null ? `$${fallback.toFixed(2)}` : "—";
}
