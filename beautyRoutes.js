import { quoteBeautyOrder } from './beautyOrderService.js';
import express from 'express';
import { dbQuery } from './db.js';
import { resolveAuthPayload } from './authRoutes.js';
import { isJwtGlobalSuperScope } from './authPlatformJwt.js';
import { createBeautyCatalogStore, publicBeautyCatalog } from './beautyCatalogService.js';

export function createBeautyRouter({ query = dbQuery, resolveToken = resolveAuthPayload,
  isFounder = isJwtGlobalSuperScope } = {}) {
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
  return router;
}
