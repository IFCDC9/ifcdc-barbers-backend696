// Historical quote fixture: deliberately frozen at the prior deployed policy.
// One platform fee per checkout, regardless of buyer role or seller count.
export const BEAUTY_PLATFORM_FEE_CENTS = 150;
export const BEAUTY_COMMISSION_BPS = 200;
export const BEAUTY_PRICING_POLICY = "seller_commission_v1";
export function beautyBagTotals(subtotalCents, itemCount) {
  if (!Number.isSafeInteger(subtotalCents) || subtotalCents < 0 ||
      !Number.isSafeInteger(itemCount) || itemCount < 0) throw new Error('Invalid basket');
  const platformFeeCents = itemCount > 0 ? BEAUTY_PLATFORM_FEE_CENTS : 0;
  // Round once per order to the nearest cent, with halves rounded up.
  const commissionCents = itemCount > 0
    ? Number((BigInt(subtotalCents) * BigInt(BEAUTY_COMMISSION_BPS) + 5000n) / 10000n) : 0;
  const totalBeforeTaxShippingCents = subtotalCents + platformFeeCents;
  if (!Number.isSafeInteger(totalBeforeTaxShippingCents)) throw new Error('Invalid basket');
  const sellerNetCents = subtotalCents - commissionCents;
  const platformRevenueCents = platformFeeCents + commissionCents;
  return { pricingPolicy: BEAUTY_PRICING_POLICY, commissionPayer: 'seller', subtotalCents,
    commissionCents, sellerNetCents, platformRevenueCents, platformFeeCents, totalBeforeTaxShippingCents };
}

import { publicBeautyCatalog } from '../beautyCatalogService.js';


// A quote does not reserve stock, create an order, or collect payment.
// Prices, sellers and fees supplied by a browser are deliberately ignored.
export function quoteBeautyOrder(catalog, items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('Invalid basket');
  const products = new Map(publicBeautyCatalog(catalog).products.map(p => [p.id, p]));
  const sourceProducts = new Map(catalog.products.map(p=>[p.id,p]));
  const seen = new Set();
  let subtotal = 0, count = 0;
  const lines = items.map(item => {
    const p = products.get(item?.productId);
    if (!p || seen.has(p.id) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > p.stock) {
      throw new Error('Invalid basket');
    }
    seen.add(p.id);
    subtotal += p.priceCents * item.quantity;
    count += item.quantity;
    if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(count)) throw new Error('Invalid basket');
    return { productId:p.id, sellerId:sourceProducts.get(p.id).sellerId, name:p.name, quantity:item.quantity, unitPriceCents:p.priceCents };
  });
  const totals = beautyBagTotals(subtotal,count);
  // Allocate the order-level commission by product proceeds. Largest remainders
  // distribute cents deterministically, so splitting a basket never increases fees.
  const grossBySeller = new Map();
  for (const line of lines) grossBySeller.set(line.sellerId,
    (grossBySeller.get(line.sellerId) || 0) + line.unitPriceCents * line.quantity);
  const allocations = [...grossBySeller].sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0).map(([sellerId,grossCents])=>{
    const weighted = BigInt(grossCents) * BigInt(totals.commissionCents);
    return {sellerId,grossCents,commissionCents:subtotal ? Number(weighted / BigInt(subtotal)) : 0,
      remainder:subtotal ? weighted % BigInt(subtotal) : 0n};
  });
  let remaining = totals.commissionCents - allocations.reduce((sum,a)=>sum+a.commissionCents,0);
  const ranked = [...allocations].sort((a,b)=>a.remainder === b.remainder
    ? (a.sellerId < b.sellerId ? -1 : a.sellerId > b.sellerId ? 1 : 0)
    : a.remainder > b.remainder ? -1 : 1);
  for (const a of ranked) { if (!remaining) break; a.commissionCents++; remaining--; }
  const sellerAllocations = allocations.map(({remainder,...a})=>({...a,netBeforeProcessingCents:a.grossCents-a.commissionCents}));
  return { currency:'USD', lines, ...totals, sellerAllocations, checkoutEnabled:false };
}
