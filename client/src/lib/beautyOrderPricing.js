// One platform fee per checkout, regardless of buyer role or seller count.
export const BEAUTY_PLATFORM_FEE_CENTS = 150;
export const BEAUTY_COMMISSION_BPS = 200;
export function beautyBagTotals(subtotalCents, itemCount) {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0 ||
      !Number.isSafeInteger(itemCount) || itemCount < 0) throw new Error('Invalid basket');
  const platformFeeCents = itemCount > 0 ? BEAUTY_PLATFORM_FEE_CENTS : 0;
  // Round once per order to the nearest cent, with halves rounded up.
  const commissionCents = itemCount > 0
    ? Number((BigInt(subtotalCents) * BigInt(BEAUTY_COMMISSION_BPS) + 5000n) / 10000n) : 0;
  const totalBeforeTaxShippingCents = subtotalCents + platformFeeCents + commissionCents;
  if (!Number.isSafeInteger(totalBeforeTaxShippingCents)) throw new Error('Invalid basket');
  return { subtotalCents, commissionCents, platformFeeCents, totalBeforeTaxShippingCents };
}
