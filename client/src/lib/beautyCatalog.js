export const BEAUTY_CATEGORIES = [
  'Clippers & trimmers', 'Blades & accessories', 'Hair care',
  'Beard & shaving', 'Skin & beauty', 'Braids & locs', 'Salon essentials',
];

// Accept only the public contract. Never render wholesale costs or commission terms.
export function readBeautyCatalog(payload) {
  if (!payload || !Array.isArray(payload.products)) throw new Error('Invalid store catalog');
  const seen = new Set();
  return payload.products.map((p) => {
    if (!p || typeof p.id !== 'string' || !p.id || seen.has(p.id) ||
        !['name', 'brand', 'seller'].every(k => typeof p[k] === 'string' && p[k].trim()) ||
        !BEAUTY_CATEGORIES.includes(p.category) ||
        !Number.isSafeInteger(p.priceCents) || p.priceCents <= 0 ||
        !Number.isSafeInteger(p.stock) || p.stock < 0 ||
        !Array.isArray(p.fulfillment) || !p.fulfillment.length ||
        !p.fulfillment.every(f => f === 'pickup' || f === 'shipping') ||
        (p.fulfillment.includes('pickup') && (typeof p.pickupLocation !== 'string' || !p.pickupLocation.trim()))) {
      throw new Error('Invalid store product');
    }
    seen.add(p.id);
    return {
      id:p.id, name:p.name, brand:p.brand, seller:p.seller, category:p.category,
      priceCents:p.priceCents, stock:p.stock, fulfillment:[...new Set(p.fulfillment)],
      pickupLocation:p.pickupLocation || '', independentBrand:p.independentBrand === true,
    };
  });
}

export function filterBeautyProducts(products, { query = '', category = 'All', fulfillment = 'all', independentOnly = false }) {
  const text = query.trim().toLocaleLowerCase();
  return products.filter(p => (category === 'All' || p.category === category) &&
    (fulfillment === 'all' || p.fulfillment.includes(fulfillment)) &&
    (!independentOnly || p.independentBrand) &&
    `${p.name} ${p.brand} ${p.seller}`.toLocaleLowerCase().includes(text));
}

export function changeBeautyBag(bag, product, delta) {
  if (!Number.isInteger(delta)) return bag;
  const quantity = Math.min(product.stock, Math.max(0, (bag[product.id] || 0) + delta));
  const next = { ...bag };
  if (quantity) next[product.id] = quantity;
  else delete next[product.id];
  return next;
}
