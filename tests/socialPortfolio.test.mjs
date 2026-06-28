import test from "node:test";
import assert from "node:assert/strict";
import { HAIRCUT_CATEGORY_IDS, MAX_REVIEW_PHOTOS, BARBER_BADGE_DEFINITIONS } from "../socialPortfolioConstants.js";

test("haircut categories include core fade and specialty styles", () => {
  assert.ok(HAIRCUT_CATEGORY_IDS.has("skin_fade"));
  assert.ok(HAIRCUT_CATEGORY_IDS.has("burst_fade"));
  assert.ok(HAIRCUT_CATEGORY_IDS.has("hair_color"));
});

test("review photo limit is capped at five", () => {
  assert.equal(MAX_REVIEW_PHOTOS, 5);
});

test("badge definitions cover social proof milestones", () => {
  assert.ok(BARBER_BADGE_DEFINITIONS.top_rated);
  assert.ok(BARBER_BADGE_DEFINITIONS.hundred_five_star);
  assert.ok(BARBER_BADGE_DEFINITIONS.most_liked);
});
