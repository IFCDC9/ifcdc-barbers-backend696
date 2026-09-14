import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEGACY_WRITE_FROZEN,
  assertLegacyWriteNotUsed,
  legacyWriteFrozenPayload,
} from "../legacySubscriptionFreeze.js";
import { startTrial, activateMonthly } from "../src/services/subscriptionService.js";

test("legacy write catalog documents frozen paths", () => {
  assert.equal(LEGACY_WRITE_FROZEN.barberSelfServeTierPatch.frozen, true);
  assert.equal(LEGACY_WRITE_FROZEN.paypalProAsSaas.frozen, true);
  assert.equal(LEGACY_WRITE_FROZEN.sevenDayStartTrial.frozen, true);
  assert.equal(LEGACY_WRITE_FROZEN.fourteenDayShopTrialAsStore.frozen, true);
});

test("startTrial and activateMonthly throw frozen", async () => {
  await assert.rejects(() => startTrial(1, 7), /store replacement|frozen|Legacy/i);
  await assert.rejects(() => activateMonthly(1, 1), /store billing|frozen|Legacy/i);
});

test("assertLegacyWriteNotUsed raises code", () => {
  try {
    assertLegacyWriteNotUsed("sevenDayStartTrial");
    assert.fail("expected throw");
  } catch (e) {
    assert.equal(e.code, "legacy_write_frozen");
  }
  const payload = legacyWriteFrozenPayload("fourteenDayShopTrialAsStore");
  assert.equal(payload.ok, false);
  assert.match(payload.message, /14-day/);
});
