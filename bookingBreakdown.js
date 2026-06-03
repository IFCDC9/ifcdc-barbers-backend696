import { dbQuery } from "./db.js";
import { roundMoney2, computeChargeBreakdown, enforcePlatformFeeOnBreakdown } from "./styleBookingPricing.js";
import { loadBarberDepositPricingOpts } from "./barberScope.js";

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

  const sr = await dbQuery(
    `SELECT id, barber_id, title, image_url, price::float8 AS price FROM styles WHERE id = $1::uuid LIMIT 1`,
    [sid],
  );
  const style = sr.rows?.[0];
  if (!style) {
    return { ok: false, status: 404, error: "style_not_found", message: "Style not found" };
  }
  if (String(style.barber_id) !== String(bidRaw)) {
    return {
      ok: false,
      status: 400,
      error: "barber_mismatch",
      message: "This style does not belong to the selected barber",
    };
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
