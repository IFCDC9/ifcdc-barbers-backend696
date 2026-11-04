// One platform fee per checkout, regardless of buyer role or seller count.
export const BEAUTY_PLATFORM_FEE_CENTS = 150;
export function beautyBagTotals(subtotalCents, itemCount) {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0 ||
      !Number.isSafeInteger(itemCount) || itemCount < 0) throw new Error('Invalid basket');
  const platformFeeCents = itemCount > 0 ? BEAUTY_PLATFORM_FEE_CENTS : 0;
  const totalBeforeTaxShippingCents = subtotalCents + platformFeeCents;
  if (!Number.isSafeInteger(totalBeforeTaxShippingCents)) throw new Error('Invalid basket');
  return { subtotalCents, platformFeeCents, totalBeforeTaxShippingCents };
}
