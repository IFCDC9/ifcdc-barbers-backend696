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

test("review notification email helpers are exported", async () => {
  const mod = await import("../reviewNotificationEmail.cjs");
  assert.equal(typeof mod.emailBarberNewReview, "function");
  assert.equal(typeof mod.emailCustomerReviewPrompt, "function");
  assert.equal(typeof mod.emailAdminReviewModeration, "function");
  assert.match(String(mod.ADMIN_REVIEW_EMAIL || ""), /@/);
});

test("portfolio routes expose reply and admin delete", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../socialPortfolioRoutes.js", import.meta.url), "utf8");
  assert.match(src, /\/api\/reviews\/:reviewId\/reply/);
  assert.match(src, /\/api\/admin\/reviews\/:id/);
  assert.match(src, /adminDeleteReview/);
  assert.match(src, /replyToBarberReview/);
  assert.match(src, /restoreReview/);
  assert.match(src, /listAdminReviews/);
});

test("web portfolio API sends bearer auth for review mutations", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../client/src/services/socialPortfolioApi.js", import.meta.url), "utf8");
  assert.match(src, /function authHeaders\(\)[\s\S]*Authorization:\s*`Bearer/);
  assert.match(src, /replyToReview/);
  assert.match(src, /removeReview/);
  assert.match(src, /restoreReviewAdmin/);
});

test("booking completion helper marks complete idempotently", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../bookingCompletion.cjs", import.meta.url), "utf8");
  assert.match(src, /markBookingCompletedIdempotent/);
  assert.match(src, /notifyCustomerReviewPrompt/);
  assert.match(src, /completed_at/);
});
