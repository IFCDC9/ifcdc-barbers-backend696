import { createRequire } from "node:module";
import { roundMoney2, computeChargeBreakdown, enforcePlatformFeeOnBreakdown } from "./styleBookingPricing.js";
import { loadBarberDepositPricingOpts } from "./barberScope.js";

const requireCjs = createRequire(import.meta.url);
const { resolveBookingStyleRow } = requireCjs("./publicBookingStyles.cjs");

/**
 * Server-only booking charge math for a style + barber (PayPal + persistence).
 * @param {object} p
 * @param {string} p.styleId - UUID
 * @param {number} p.barberId
 * @param {"deposit"|"full"} p.paymentType
 * @param {object} p.body - tipPercent / tipAmount / customTip
 */
export async function computeStyleBookingBreakdown({ styleId, barberId, paymentType, body = {} }) {
  const sid = String(styleId || "").trim();
  const bidRaw = barberId;
  if (!sid || bidRaw == null || String(bidRaw).trim() === "") {
    return { ok: false, status: 400, error: "invalid_input", message: "styleId and barberId required" };
  }

  const { dbQuery } = await import("./db.js");
  const style = await resolveBookingStyleRow(dbQuery, sid, bidRaw);
  if (!style) {
    return { ok: false, status: 404, error: "style_not_found", message: "Style not found" };
  }

  const stylePrice = roundMoney2(Number(style.price));
  if (!Number.isFinite(stylePrice) || stylePrice <= 0) {
    return { ok: false, status: 400, error: "invalid_style_price", message: "Style has no valid price" };
  }

  const depositOpts = await loadBarberDepositPricingOpts(bidRaw);

  const breakdown = enforcePlatformFeeOnBreakdown(
    computeChargeBreakdown(stylePrice, "full", body, depositOpts),
    body,
    depositOpts.subscriptionTier,
  );

  return {
    ok: true,
    styleId: String(style.id),
    styleTitle: String(style.title || "").trim() || "Style",
    styleImageUrl: style.image_url ? String(style.image_url) : null,
    barberId: bidRaw,
    subscription_tier: depositOpts.subscriptionTier,
    breakdown,
  };
}
