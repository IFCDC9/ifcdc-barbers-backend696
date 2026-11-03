import { readBeautyCatalog } from './client/src/lib/beautyCatalog.js';

const fail = () => { throw new Error('Invalid beauty catalog'); };
const text = (v, max = 200) => typeof v === 'string' && v.trim() && v.length <= max;
const id = v => text(v, 100) && /^[a-zA-Z0-9_-]+$/.test(v);

// Normalize an entire Founder-managed catalog. No supplier imports or payments yet.
export function validateBeautyCatalog(input) {
  if (!input || !Array.isArray(input.sellers) || !Array.isArray(input.products) ||
      input.sellers.length > 500 || input.products.length > 2000) fail();
  const sellers = new Map();
  const normalizedSellers = input.sellers.map(s => {
    if (!s || !id(s.id) || sellers.has(s.id) || !text(s.name) ||
        !['pending', 'approved', 'suspended'].includes(s.status)) fail();
    const value = { id:s.id, name:s.name.trim(), status:s.status };
    sellers.set(value.id, value);
    return value;
  });
  const seen = new Set();
  const products = input.products.map(p => {
    if (!p || !id(p.id) || seen.has(p.id) || !sellers.has(p.sellerId) ||
        !['draft', 'published', 'archived'].includes(p.status) ||
        !['resale', 'commission'].includes(p.revenueModel) ||
        !text(p.name) || !text(p.brand) ||
        (p.pickupLocation != null && (typeof p.pickupLocation !== 'string' || p.pickupLocation.length > 500)) ||
        (p.wholesaleCostCents != null && (!Number.isSafeInteger(p.wholesaleCostCents) || p.wholesaleCostCents < 0)) ||
        (p.commissionBps != null && (!Number.isSafeInteger(p.commissionBps) || p.commissionBps < 0 || p.commissionBps > 10000)) ||
        (p.revenueModel === 'commission' && p.status === 'published' && p.commissionBps == null)) fail();
    const seller = sellers.get(p.sellerId);
    if (p.status === 'published' && seller.status !== 'approved') fail();
    const [pub] = readBeautyCatalog({ products:[{ ...p, seller:seller.name }] });
    seen.add(p.id);
    return { ...pub, sellerId:p.sellerId, status:p.status, revenueModel:p.revenueModel,
      wholesaleCostCents:p.wholesaleCostCents ?? null, commissionBps:p.commissionBps ?? null };
  });
  return { sellers:normalizedSellers, products };
}

export function publicBeautyCatalog(catalog) {
  const sellers = new Map(catalog.sellers.filter(s => s.status === 'approved').map(s => [s.id,s]));
  return { products:readBeautyCatalog({ products:catalog.products
    .filter(p => p.status === 'published' && sellers.has(p.sellerId))
    .map(p => ({ ...p, seller:sellers.get(p.sellerId).name })) }), checkoutEnabled:false };
}

export function createBeautyCatalogStore(query) {
  return {
    async read() {
      const r = await query('SELECT revision, catalog FROM beauty_catalog_state WHERE id = 1');
      if (!r.rows?.length) throw new Error('Beauty schema unavailable');
      return { revision:r.rows[0].revision, ...validateBeautyCatalog(r.rows[0].catalog) };
    },
    async save(input, revision, actorId) {
      if (!Number.isSafeInteger(revision) || revision < 0 || !text(actorId)) fail();
      const catalog = validateBeautyCatalog(input);
      // Compare-and-swap + audit in one statement: concurrent edits cannot overwrite silently.
      const r = await query(`WITH changed AS (
        UPDATE beauty_catalog_state SET catalog = $1::jsonb, revision = revision + 1, updated_at = now()
        WHERE id = 1 AND revision = $2 RETURNING revision
      ), audited AS (
        INSERT INTO beauty_catalog_audit (actor_id, revision, catalog)
        SELECT $3, revision, $1::jsonb FROM changed RETURNING revision
      ) SELECT revision FROM audited`, [JSON.stringify(catalog), revision, actorId]);
      return r.rows?.[0] ? { revision:r.rows[0].revision, ...catalog } : null;
    },
  };
}
