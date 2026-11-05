import { createSandboxCheckoutRouter } from './beautySandboxCheckoutRoutes.js';
import { createBeautySellerPaymentStore, publicBeautyPaymentConfig } from './beautySellerPayments.js';
import { createBeautyOrderDraftStore, publicBeautyDraft } from './beautyOrderDrafts.js';
import { quoteBeautyOrder } from './beautyOrderService.js';
import express from 'express';
import { dbQuery } from './db.js';
import { resolveAuthPayload } from './authRoutes.js';
import { isJwtGlobalSuperScope } from './authPlatformJwt.js';
import { createBeautyCatalogStore, publicBeautyCatalog } from './beautyCatalogService.js';

export function createBeautyRouter({ query = dbQuery, resolveToken = resolveAuthPayload,
  isFounder = isJwtGlobalSuperScope, sellerPaymentProvider } = {}) {
  const router = express.Router();
  const store = createBeautyCatalogStore(query);
  router.use('/api/beauty', (_req, res, next) => {
    res.set('Cache-Control', 'no-store'); next();
  });
  router.get('/api/beauty/catalog', async (_req, res) => {
    try { res.json(publicBeautyCatalog(await store.read())); }
    catch { res.status(503).json({ error:'catalog_unavailable' }); }
  });
  router.post('/api/beauty/quote', express.json({ limit:'32kb' }), async (req, res) => {
    try {
      const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
      const user = match && await resolveToken(match[1]);
      if (!user?.id) return res.status(401).json({ error:'authentication_required' });
      const found = await query('SELECT id, account_status FROM app_users WHERE id = $1::uuid LIMIT 1', [user.id]);
      const account = found.rows?.[0];
      if (!account || (account.account_status && account.account_status !== 'active')) {
        return res.status(403).json({ error:'active_account_required' });
      }
      res.json({ buyerId:user.id, ...quoteBeautyOrder(await store.read(), req.body?.items) });
    } catch (e) {
      if (e.message === 'Invalid basket') return res.status(400).json({ error:'invalid_basket_or_stock_changed' });
      res.status(503).json({ error:'quote_unavailable' });
    }
  });
  const drafts = createBeautyOrderDraftStore(query);
  router.use('/api/beauty/orders', async (req,res,next) => {
    try {
      const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
      const user = token && await resolveToken(token[1]);
      if (!user?.id) return res.status(401).json({error:'authentication_required'});
      const r=await query('SELECT id, account_status FROM app_users WHERE id = $1::uuid LIMIT 1',[user.id]);
      const account=r.rows?.[0];
      if (!account || (account.account_status && account.account_status !== 'active')) return res.status(403).json({error:'active_account_required'});
      req.beautyBuyerId=user.id;next();
    } catch {res.status(503).json({error:'authorization_unavailable'});}
  });
  router.get('/api/beauty/orders', async (req,res) => {
    try {res.json({orders:(await drafts.list(req.beautyBuyerId)).map(publicBeautyDraft)});}
    catch {res.status(503).json({error:'orders_unavailable'});}
  });
  router.get('/api/beauty/orders/:id', async (req,res) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return res.status(404).json({error:'order_not_found'});
    try {
      const order=await drafts.read(req.beautyBuyerId,req.params.id);
      if (!order) return res.status(404).json({error:'order_not_found'});
      res.json({order:publicBeautyDraft(order)});
    } catch {res.status(503).json({error:'orders_unavailable'});}
  });
  router.post('/api/beauty/orders',express.json({limit:'32kb'}),async(req,res)=>{
    try {
      const order=await drafts.create(req.beautyBuyerId,req.body?.requestKey,await store.read(),req.body?.items);
      res.json({order:publicBeautyDraft(order),checkoutEnabled:false});
    } catch(e) {
      if(e.message==='Order key conflict') return res.status(409).json({error:'order_key_conflict'});
      if(e.message.startsWith('Invalid')) return res.status(400).json({error:'invalid_basket_or_stock_changed'});
      res.status(503).json({error:'order_draft_unavailable'});
    }
  });
  router.use('/api/beauty/admin', async (req, res, next) => {
    try {
      const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
      const user = match && await resolveToken(match[1]);
      if (!user?.id) return res.status(401).json({ error:'authentication_required' });
      if (!isFounder(user)) return res.status(403).json({ error:'founder_required' });
      // Recheck current DB role: a stale privileged JWT must not authorize catalog changes.
      const r = await query('SELECT role, account_status FROM app_users WHERE id = $1::uuid LIMIT 1', [user.id]);
      const row = r.rows?.[0];
      if (row?.role !== 'super_admin' || (row.account_status && row.account_status !== 'active')) {
        return res.status(403).json({ error:'founder_required' });
      }
      req.beautyActorId = user.id; next();
    } catch { res.status(503).json({ error:'authorization_unavailable' }); }
  });
  router.get('/api/beauty/admin/catalog', async (_req, res) => {
    try { res.json(await store.read()); }
    catch { res.status(503).json({ error:'catalog_unavailable' }); }
  });
  router.put('/api/beauty/admin/catalog', express.json({ limit:'2mb' }), async (req, res) => {
    try {
      const result = await store.save(req.body, req.body?.revision, req.beautyActorId);
      if (!result) return res.status(409).json({ error:'catalog_changed_reload_before_saving' });
      res.json(result);
    } catch (e) {
      if (/^Invalid/.test(e.message)) return res.status(400).json({ error:'invalid_catalog' });
      res.status(503).json({ error:'catalog_save_unavailable' });
    }
  });
  const sellerPayments = createBeautySellerPaymentStore(query,sellerPaymentProvider);
  router.get('/api/beauty/admin/seller-payments/config', (_req,res)=>res.json(publicBeautyPaymentConfig(sellerPayments.config)));
  router.all('/api/beauty/admin/seller-payments/:sellerId/:action', express.json({limit:'2kb'}), async(req,res)=>{
    const {sellerId,action}=req.params;
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(sellerId) || !['status','start','refresh'].includes(action)) return res.status(404).json({error:'seller_not_found'});
    if((action==='status' && req.method!=='GET') || (action!=='status' && req.method!=='POST')) return res.status(405).json({error:'method_not_allowed'});
    try {
      const catalog=await store.read();
      const seller=catalog.sellers.find(s=>s.id===sellerId);
      if(!seller)return res.status(404).json({error:'seller_not_found'});
      if(action!=='status' && seller.status!=='approved')return res.status(409).json({error:'approved_seller_required'});
      if(action==='status')return res.json({connection:await sellerPayments.status(sellerId)});
      if(action==='start')return res.json(await sellerPayments.start(sellerId,req.beautyActorId));
      return res.json({connection:await sellerPayments.refresh(sellerId,req.beautyActorId)});
    }catch(e){
      if(e.code==='seller_payments_not_configured')return res.status(503).json({error:e.code});
      if(e.code==='seller_connection_missing')return res.status(409).json({error:e.code});
      return res.status(503).json({error:'seller_connection_unavailable'});
    }
  });
  router.use('/api/beauty/admin/sandbox-checkout',createSandboxCheckoutRouter());
  return router;
}
