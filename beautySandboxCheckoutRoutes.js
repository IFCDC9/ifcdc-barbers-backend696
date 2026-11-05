import express from 'express';
import { getDbPool } from './db.js';
import { createBeautyPayPalProvider } from './beautySellerPayments.js';
import { createSandboxCheckout,assertSandboxCheckout,publicSandboxOrder } from './beautySandboxCheckout.js';
// Mounted only behind the existing Founder JWT + current DB-role middleware.
export function createSandboxCheckoutRouter({getPool=getDbPool,provider=createBeautyPayPalProvider(),env=process.env}={}){
  const router=express.Router();
  router.use(express.json({limit:'32kb'}));
  router.use((_req,res,next)=>{try{assertSandboxCheckout(provider,env);next();}catch{res.status(503).json({error:'sandbox_checkout_disabled'});}});
  const service=()=>createSandboxCheckout({pool:getPool(),provider,env});
  function error(res,e){
    const known=['seller_provider_request_failed','seller_provider_auth_failed','payment_verification_failed','invalid_approval_link','payment_status_unknown','invalid_request_key','Invalid basket','order_key_conflict','sandbox_limit_100_usd','sandbox_pickup_only','too_many_sellers','seller_not_authorized','sandbox_order_expired','paypal_approval_required','capture_must_be_reconciled','inventory_review_required','unexpected_capture_requires_review'];
    if(e.message==='sandbox_order_not_found')return res.status(404).json({error:e.message});
    if(known.includes(e.message))return res.status(409).json({error:e.message});
    return res.status(503).json({error:'sandbox_checkout_unavailable'});
  }
  router.get('/',async(req,res)=>{try{res.json({orders:(await service().list(req.beautyActorId)).map(publicSandboxOrder)});}catch(e){error(res,e);}});
  router.post('/',async(req,res)=>{try{res.json({order:publicSandboxOrder(await service().reserve(req.beautyActorId,req.body?.requestKey,req.body?.items))});}catch(e){error(res,e);}});
  router.post('/:id/:action',async(req,res)=>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)||!['prepare','capture','retryCapture','reconcile','cancel'].includes(req.params.action))return res.status(404).json({error:'sandbox_order_not_found'});
    try{res.json({order:publicSandboxOrder(await service()[req.params.action](req.beautyActorId,req.params.id))});}catch(e){error(res,e);}
  });
  return router;
}
