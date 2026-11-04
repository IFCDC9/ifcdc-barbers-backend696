import { publicBeautyCatalog } from './beautyCatalogService.js';
import { beautyBagTotals } from './client/src/lib/beautyOrderPricing.js';

// A quote does not reserve stock, create an order, or collect payment.
// Prices, sellers and fees supplied by a browser are deliberately ignored.
export function quoteBeautyOrder(catalog, items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('Invalid basket');
  const products = new Map(publicBeautyCatalog(catalog).products.map(p => [p.id, p]));
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
    return { productId:p.id, name:p.name, quantity:item.quantity, unitPriceCents:p.priceCents };
  });
  return { currency:'USD', lines, ...beautyBagTotals(subtotal,count), checkoutEnabled:false };
}
