import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER = "In-app purchases run on a TestFlight / Play production build, then the server verifies the receipt.";

test("placeholder string is gone from SubscriptionScreen purchase tap path", () => {
  const src = readFileSync(join(root, "mobile/screens/profile/SubscriptionScreen.tsx"), "utf8");
  assert.doesNotMatch(src, /In-app purchases run on a TestFlight/);
  assert.match(src, /const onBuy = async/);
  assert.match(src, /purchaseProduct\(/);
  assert.match(src, /user_cancelled/);
  assert.match(src, /pending/);
  assert.match(src, /await refresh\(\)/);
});

test("storeBilling uses expo-iap StoreKit APIs and server confirm", () => {
  const src = readFileSync(join(root, "mobile/services/storeBilling.ts"), "utf8");
  assert.match(src, /import\("expo-iap"\)/);
  assert.match(src, /requestPurchase/);
  assert.match(src, /apple:\s*\{/);
  assert.match(src, /sku:\s*productId/);
  assert.match(src, /purchaseUpdatedListener/);
  assert.match(src, /\/api\/billing\/confirm/);
  assert.match(src, /\/api\/entitlements\/me/);
  assert.match(src, /signedTransactionInfo/);
  assert.match(src, /purchaseToken/);
  assert.match(src, /getAvailablePurchases/);
  assert.match(src, /restorePurchases/);
  assert.match(src, /finishTransaction/);
  assert.match(src, /isExpoGoRuntime/);
  assert.match(src, new RegExp(PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(src, /subscriptionOffers|introductoryOffer/);
  assert.doesNotMatch(src, /transactionId\s*\|\|/);
});

test("EAS production app.json includes expo-iap plugin and iOS build 84", () => {
  const app = JSON.parse(readFileSync(join(root, "mobile/app.json"), "utf8"));
  assert.equal(app.expo.version, "1.1.12");
  assert.equal(app.expo.ios.buildNumber, "84");
  assert.ok(app.expo.plugins.includes("expo-iap") || app.expo.plugins.some((p) => p === "expo-iap" || p?.[0] === "expo-iap"));
});

test("expo-iap is a production mobile dependency", () => {
  const pkg = JSON.parse(readFileSync(join(root, "mobile/package.json"), "utf8"));
  assert.ok(pkg.dependencies["expo-iap"]);
});
