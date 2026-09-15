import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyPlayHttpStatus,
  googleEnvironmentFromPurchase,
  googlePlayCredentialsConfigured,
  mapSubscriptionV2ToPurchase,
  verifyGoogleOneTimePurchase,
  verifyGoogleSubscriptionPurchase,
} from "../googlePlayClient.js";
import { defaultGoogleVerifySubscription } from "../storeVerifyAdapters.js";

test("Play verifier is closed without credentials", async () => {
  const prevJ = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  const prevT = process.env.GOOGLE_PLAY_ACCESS_TOKEN;
  delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_PLAY_ACCESS_TOKEN;
  assert.equal(googlePlayCredentialsConfigured(), false);
  const closed = await defaultGoogleVerifySubscription({
    productId: "ifcdc.barbers.individual.monthly",
    purchaseToken: "tok",
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.error, "google_credentials_not_configured");
  if (prevJ !== undefined) process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = prevJ;
  if (prevT !== undefined) process.env.GOOGLE_PLAY_ACCESS_TOKEN = prevT;
});

test("testPurchase maps to sandbox; live maps to production", () => {
  assert.equal(googleEnvironmentFromPurchase({ testPurchase: {} }), "sandbox");
  assert.equal(googleEnvironmentFromPurchase({ purchaseType: 0 }), "sandbox");
  assert.equal(googleEnvironmentFromPurchase({}), "production");
});

test("subscriptionsv2 maps line item product and active state", () => {
  const purchase = mapSubscriptionV2ToPurchase(
    {
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      latestOrderId: "GPA.1",
      startTime: "2026-09-01T00:00:00Z",
      lineItems: [
        {
          productId: "ifcdc.barbers.shop.monthly",
          expiryTime: "2026-10-01T00:00:00Z",
          autoRenewingPlan: { autoRenewEnabled: true },
        },
      ],
    },
    { purchaseToken: "tok" },
  );
  assert.equal(purchase.productId, "ifcdc.barbers.shop.monthly");
  assert.equal(purchase.subscriptionState, 1);
  assert.equal(purchase.orderId, "GPA.1");
});

test("Play subscription verify uses Developer API with injected fetch", async () => {
  const prevT = process.env.GOOGLE_PLAY_ACCESS_TOKEN;
  const prevJ = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  process.env.GOOGLE_PLAY_ACCESS_TOKEN = "test-access-token";
  delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  const urls = [];
  const out = await verifyGoogleSubscriptionPurchase({
    productId: "ifcdc.barbers.individual.monthly",
    purchaseToken: "play-token",
    packageName: "com.ifcdc.barbers",
    fetchImpl: async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
            latestOrderId: "GPA.live",
            lineItems: [
              {
                productId: "ifcdc.barbers.individual.monthly",
                expiryTime: "2099-01-01T00:00:00Z",
              },
            ],
          }),
      };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.environment, "production");
  assert.equal(out.purchase.productId, "ifcdc.barbers.individual.monthly");
  assert.equal(urls.some((u) => u.includes("subscriptionsv2")), true);
  assert.equal(classifyPlayHttpStatus(401), "unauthorized");
  if (prevT === undefined) delete process.env.GOOGLE_PLAY_ACCESS_TOKEN;
  else process.env.GOOGLE_PLAY_ACCESS_TOKEN = prevT;
  if (prevJ === undefined) delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  else process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = prevJ;
});

test("Play one-time verify uses products endpoint", async () => {
  const prevT = process.env.GOOGLE_PLAY_ACCESS_TOKEN;
  process.env.GOOGLE_PLAY_ACCESS_TOKEN = "test-access-token";
  const out = await verifyGoogleOneTimePurchase({
    productId: "ifcdc.barbers.access",
    purchaseToken: "otp",
    packageName: "com.ifcdc.barbers",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ purchaseState: 0, orderId: "order-1" }),
    }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.purchase.productId, "ifcdc.barbers.access");
  if (prevT === undefined) delete process.env.GOOGLE_PLAY_ACCESS_TOKEN;
  else process.env.GOOGLE_PLAY_ACCESS_TOKEN = prevT;
});
