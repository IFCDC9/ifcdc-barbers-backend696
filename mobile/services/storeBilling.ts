/**
 * StoreKit 2 / Google Play Billing client.
 * Uses expo-iap on EAS production binaries. Never trusts local purchase status;
 * always POST /api/billing/confirm and GET /api/entitlements/me.
 *
 * Promo/win-back: confirm App Store Connect promotional offer IDs with Tessa — do not invent IDs.
 * Google access SKU: confirm with Tessa before production.
 */

import { NativeModules, Platform } from "react-native";
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

/** Last-resort copy for Expo Go only — never the TestFlight purchase path. */
export const EXPO_GO_IAP_HINT =
  "In-app purchases run on a TestFlight / Play production build, then the server verifies the receipt.";

export type PurchaseOutcome = {
  ok: boolean;
  error?: string;
  message?: string;
  confirm?: unknown;
  entitlements?: unknown;
};

type IapModule = {
  initConnection: () => Promise<boolean>;
  fetchProducts: (args: { skus: string[]; type?: string }) => Promise<unknown[]>;
  requestPurchase: (args: unknown) => Promise<unknown>;
  getAvailablePurchases: (opts?: unknown) => Promise<unknown[]>;
  restorePurchases: () => Promise<unknown>;
  finishTransaction: (args: unknown) => Promise<void>;
  purchaseUpdatedListener: (listener: (purchase: unknown) => void) => { remove: () => void };
  purchaseErrorListener: (listener: (error: unknown) => void) => { remove: () => void };
  isEligibleForIntroOfferIOS?: (groupId: string) => Promise<boolean>;
};

let iapModule: IapModule | null | undefined;
let connectionReady = false;

export function isExpoGoRuntime(): boolean {
  try {
    const Constants = require("expo-constants")?.default || require("expo-constants");
    const ownership = String(Constants?.appOwnership || "");
    const env = String(Constants?.executionEnvironment || "");
    return ownership === "expo" || env === "storeClient";
  } catch {
    return false;
  }
}

function nativeIapPresent(): boolean {
  const mods = NativeModules as Record<string, unknown>;
  return Boolean(mods.ExpoIap || mods.ExpoIapModule);
}

async function loadIap(): Promise<IapModule | null> {
  if (iapModule !== undefined) return iapModule;
  if (!nativeIapPresent() && isExpoGoRuntime()) {
    iapModule = null;
    return null;
  }
  try {
    const mod = (await import("expo-iap")) as unknown as IapModule;
    if (typeof mod.requestPurchase !== "function" || typeof mod.initConnection !== "function") {
      iapModule = null;
      return null;
    }
    iapModule = mod;
    return mod;
  } catch {
    iapModule = null;
    return null;
  }
}

async function ensureConnection(): Promise<IapModule> {
  const iap = await loadIap();
  if (!iap) {
    const error = new Error(isExpoGoRuntime() ? EXPO_GO_IAP_HINT : "expo_iap_native_missing");
    (error as Error & { code?: string }).code = "native_iap_unavailable";
    throw error;
  }
  if (!connectionReady) {
    try {
      await iap.initConnection();
      connectionReady = true;
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (msg.includes("Cannot find native module") || msg.includes("Unavailability")) {
        iapModule = null;
        const error = new Error(isExpoGoRuntime() ? EXPO_GO_IAP_HINT : "expo_iap_native_missing");
        (error as Error & { code?: string }).code = "native_iap_unavailable";
        throw error;
      }
      throw e;
    }
  }
  return iap;
}

function skuList(): string[] {
  if (Platform.OS === "ios") return [...APPLE_PRODUCT_IDS];
  return [...GOOGLE_SUB_PRODUCT_IDS, GOOGLE_ACCESS_PRODUCT_ID];
}

function productIdOf(product: Record<string, unknown>): string {
  return String(product.productId || product.id || "");
}

export async function fetchStoreProducts(): Promise<{
  products: Array<Record<string, unknown>>;
  native: boolean;
  error?: string;
}> {
  try {
    const iap = await ensureConnection();
    const skus = skuList();
    const products = (await iap.fetchProducts({
      skus,
      type: "subs",
    })) as Array<Record<string, unknown>>;
    return { products: (products || []).map((p) => ({ ...p, native: true })), native: true };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "native_iap_unavailable" || isExpoGoRuntime()) {
      return {
        products: skuList().map((id) => ({
          id,
          productId: id,
          title: id,
          native: false,
        })),
        native: false,
        error: isExpoGoRuntime() ? EXPO_GO_IAP_HINT : "StoreKit native module is missing from this binary.",
      };
    }
    return {
      products: [],
      native: false,
      error: e instanceof Error ? e.message : "Failed to load StoreKit products",
    };
  }
}

function offerDisplay(offer: Record<string, unknown> | null | undefined): string {
  if (!offer) return "";
  const price = String(offer.displayPrice || offer.localizedPriceIOS || offer.localizedPrice || "").trim();
  const mode = String(offer.paymentMode || offer.type || "").trim();
  const periods = offer.numberOfPeriodsIOS ?? offer.periodCount;
  const bits = [price, mode, periods != null ? `${periods} period(s)` : ""].filter(Boolean);
  return bits.join(" · ");
}

/**
 * Intro copy/eligibility come only from StoreKit product fields (or StoreKit intro API).
 * Do not assume a free first month.
 */
export function introEligibilityFromProduct(product: Record<string, unknown>): {
  eligible: boolean | null;
  intro: string;
} {
  if (product.native === false) {
    return { eligible: null, intro: "" };
  }
  const info = (product.subscriptionInfoIOS || product.subscriptionInfo) as Record<string, unknown> | undefined;
  const offers = (Array.isArray(product.subscriptionOffers) ? product.subscriptionOffers : []) as Array<
    Record<string, unknown>
  >;
  const introOffer =
    (info?.introductoryOffer as Record<string, unknown> | null | undefined) ||
    offers.find((o) => {
      const mode = String(o.paymentMode || o.type || "").toLowerCase();
      return mode.includes("intro") || mode.includes("free") || mode.includes("pay-as-you-go") || mode === "free-trial";
    }) ||
    null;
  if (introOffer) {
    return { eligible: true, intro: offerDisplay(introOffer) || "introductory offer" };
  }
  if (offers.length > 0 || info) {
    return { eligible: false, intro: "" };
  }
  if (product.displayPrice || product.id) {
    return { eligible: false, intro: "" };
  }
  return { eligible: null, intro: "" };
}

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

function isCancelledError(error: unknown): boolean {
  const rec = (error || {}) as Record<string, unknown>;
  const code = String(rec.code || "").toLowerCase();
  const message = String(rec.message || error || "").toLowerCase();
  return (
    code === "user-cancelled" ||
    code === "user_cancelled" ||
    code === "e_user_cancelled" ||
    message.includes("user cancelled") ||
    message.includes("user canceled") ||
    message.includes("cancelled the payment") ||
    message.includes("canceled the payment")
  );
}

function isPendingError(error: unknown, purchase?: Record<string, unknown> | null): boolean {
  if (purchase && String(purchase.purchaseState || "").toLowerCase() === "pending") return true;
  const rec = (error || {}) as Record<string, unknown>;
  const code = String(rec.code || "").toLowerCase();
  return code === "pending" || code === "deferred-payment" || code === "deferred";
}

function firstPurchase(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const hit = value.find((item) => item && typeof item === "object");
    return (hit as Record<string, unknown>) || null;
  }
  if (typeof value === "object") return value as Record<string, unknown>;
  return null;
}

function waitForNativePurchase(iap: IapModule): {
  promise: Promise<{ purchase?: unknown; error?: unknown }>;
  cancel: () => void;
} {
  let settled = false;
  let updated: { remove: () => void } | undefined;
  let failed: { remove: () => void } | undefined;
  const cleanup = () => {
    updated?.remove();
    failed?.remove();
  };
  const promise = new Promise<{ purchase?: unknown; error?: unknown }>((resolve) => {
    const finish = (result: { purchase?: unknown; error?: unknown }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    updated = iap.purchaseUpdatedListener((purchase) => finish({ purchase }));
    failed = iap.purchaseErrorListener((error) => finish({ error }));
  });
  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanup();
    },
  };
}

export async function purchaseProduct(
  productId: string,
  opts: { offerId?: string; upgradeFrom?: string } = {},
): Promise<PurchaseOutcome> {
  let iap: IapModule;
  try {
    iap = await ensureConnection();
  } catch (e) {
    const expoGo = isExpoGoRuntime();
    return {
      ok: false,
      error: "native_iap_unavailable",
      message: expoGo ? EXPO_GO_IAP_HINT : e instanceof Error ? e.message : "StoreKit is unavailable.",
    };
  }

  const rankTo = PLAN_RANK[productId] || 0;
  const rankFrom = opts.upgradeFrom ? PLAN_RANK[opts.upgradeFrom] || 0 : 0;
  const type = productId === GOOGLE_ACCESS_PRODUCT_ID ? "in-app" : "subs";
  const waiter = waitForNativePurchase(iap);

  try {
    const requested = await iap.requestPurchase({
      request: {
        apple: {
          sku: productId,
          andDangerouslyFinishTransactionAutomatically: false,
          withOffer: opts.offerId
            ? { identifier: opts.offerId /* confirm App Store Connect promotional offer IDs with Tessa */ }
            : undefined,
        },
        google: {
          skus: [productId],
          replacementMode: rankTo && rankFrom ? (rankTo > rankFrom ? 1 : 2) : undefined,
        },
      },
      type,
    });
    const fromReturn = firstPurchase(requested);
    const event = fromReturn ? (waiter.cancel(), { purchase: fromReturn }) : await waiter.promise;
    if (event.error) {
      if (isCancelledError(event.error)) {
        return { ok: false, error: "user_cancelled", message: "Purchase cancelled." };
      }
      if (isPendingError(event.error)) {
        return { ok: false, error: "pending", message: "Purchase is pending store approval." };
      }
      const rec = event.error as Record<string, unknown>;
      return {
        ok: false,
        error: String(rec.code || "purchase_failed"),
        message: String(rec.message || "Purchase failed."),
      };
    }
    const purchase = firstPurchase(event.purchase);
    if (!purchase) {
      return { ok: false, error: "purchase_failed", message: "StoreKit returned no transaction." };
    }
    if (isPendingError(null, purchase)) {
      return { ok: false, error: "pending", message: "Purchase is pending store approval." };
    }
    const confirm = (await confirmPurchaseWithBackend(productId, purchase)) as {
      ok?: boolean;
      entitlements?: unknown;
      error?: string;
      message?: string;
    };
    if (confirm && confirm.ok !== false) {
      try {
        await iap.finishTransaction({ purchase, isConsumable: false });
      } catch {
        /* server is source of truth */
      }
      return { ok: true, confirm, entitlements: confirm.entitlements };
    }
    return {
      ok: false,
      error: String(confirm?.error || "confirm_failed"),
      message: String(confirm?.message || "Server could not verify this receipt."),
      confirm,
    };
  } catch (e) {
    waiter.cancel();
    if (isCancelledError(e)) {
      return { ok: false, error: "user_cancelled", message: "Purchase cancelled." };
    }
    if (isPendingError(e)) {
      return { ok: false, error: "pending", message: "Purchase is pending store approval." };
    }
    return {
      ok: false,
      error: String((e as { code?: string })?.code || "purchase_failed"),
      message: e instanceof Error ? e.message : "Purchase failed.",
    };
  }
}

export async function restorePurchases(): Promise<{ ok: boolean; confirmations: unknown[]; error?: string }> {
  let iap: IapModule;
  try {
    iap = await ensureConnection();
  } catch {
    return {
      ok: false,
      confirmations: [],
      error: isExpoGoRuntime() ? EXPO_GO_IAP_HINT : "StoreKit history is unavailable.",
    };
  }
  try {
    await iap.restorePurchases();
  } catch {
    /* getAvailablePurchases still reads StoreKit history */
  }
  const purchases = await iap.getAvailablePurchases({
    onlyIncludeActiveItemsIOS: false,
  });
  const confirmations = [];
  for (const p of purchases || []) {
    const rec = p as Record<string, unknown>;
    const productId = productIdOf(rec);
    if (!productId) continue;
    confirmations.push(await confirmPurchaseWithBackend(productId, rec, true));
  }
  return { ok: true, confirmations };
}

function appleJwsFromPurchase(rec: Record<string, unknown>): string {
  return String(
    rec.purchaseToken ||
      rec.jwsRepresentationIOS ||
      rec.jwsRepresentation ||
      rec.signedTransactionInfo ||
      rec.transactionJws ||
      "",
  ).trim();
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
    const jws = appleJwsFromPurchase(rec);
    body.transactionJws = jws;
    body.signedTransactionInfo = jws;
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
  if (product.native === false) return "—";
  return "—";
}
