import { randomUUID, createHash } from 'node:crypto';
import { quoteBeautyOrder } from './beautyOrderService.js';

export function basketFingerprint(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('Invalid basket');
  const normalized = items.map(i => {
    if (typeof i?.productId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(i.productId) ||
        !Number.isSafeInteger(i.quantity) || i.quantity < 1) throw new Error('Invalid basket');
    return {productId:i.productId,quantity:i.quantity};
  }).sort((a,b)=>a.productId.localeCompare(b.productId));
  if (new Set(normalized.map(i=>i.productId)).size !== normalized.length) throw new Error('Invalid basket');
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export function createBeautyOrderDraftStore(query) {
  return {
    async create(buyerId, key, catalog, items) {
      if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new Error('Invalid request key');
      const fingerprint = basketFingerprint(items);
      const previous = await query('SELECT * FROM beauty_order_drafts WHERE buyer_id = $1::uuid AND request_key = $2', [buyerId,key]);
      if (previous.rows?.[0]) {
        if (previous.rows[0].basket_hash !== fingerprint) throw new Error('Order key conflict');
        return previous.rows[0];
      }
      const quote = quoteBeautyOrder(catalog,items);
      // Retain seller allocation for future fulfillment without exposing private catalog costs.
      const products = new Map(catalog.products.map(p=>[p.id,p]));
      quote.lines = quote.lines.map(line=>({...line,sellerId:products.get(line.productId).sellerId}));
      const result = await query(`INSERT INTO beauty_order_drafts (id,buyer_id,request_key,basket_hash,quote)
        VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb)
        ON CONFLICT (buyer_id,request_key) DO UPDATE SET request_key = beauty_order_drafts.request_key
        RETURNING *`,[randomUUID(),buyerId,key,fingerprint,JSON.stringify(quote)]);
      const row=result.rows?.[0];
      if (!row || row.basket_hash !== fingerprint) throw new Error('Order key conflict');
      return row;
    },
    async list(buyerId) {
      const r=await query('SELECT id, status, quote, created_at, expires_at FROM beauty_order_drafts WHERE buyer_id = $1::uuid ORDER BY created_at DESC LIMIT 50',[buyerId]);
      return r.rows || [];
    },
    async read(buyerId,id) {
      const r=await query('SELECT id, status, quote, created_at, expires_at FROM beauty_order_drafts WHERE buyer_id = $1::uuid AND id = $2::uuid',[buyerId,id]);
      return r.rows?.[0] || null;
    }
  };
}
export function publicBeautyDraft(row) {
  return {id:row.id,status:row.status,quote:row.quote,created_at:row.created_at,expires_at:row.expires_at};
}
