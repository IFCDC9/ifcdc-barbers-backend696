import {createSandboxOperations} from './beautySandboxOperations.js';
import {createSandboxWebhookStore} from './beautySandboxWebhooks.js';
import express from 'express';
import { getDbPool } from './db.js';
import { createBeautyPayPalProvider } from './beautySellerPayments.js';
import { createSandboxCheckout,assertSandboxCheckout,publicSandboxOrder } from './beautySandboxCheckout.js';
// Mounted only behind the existing Founder JWT + current DB-role middleware.
export function createSandboxCheckoutRouter({getPool=getDbPool,provider=createBeautyPayPalProvider(),env=process.env}={}){
  const router=express.Router();
  router.use(express.json({limit:'32kb'}));
  router.use((_req,res,next)=>{try{assertSandboxCheckout(provider,env);next();}catch{res.status(503).json({error:'sandbox_checkout_disabled'});}});
  const operations=()=>createSandboxOperations({pool:getPool(),provider,env});
  const webhooks=()=>createSandboxWebhookStore({pool:getPool(),provider,env});
  const service=()=>createSandboxCheckout({pool:getPool(),provider,env});
  function error(res,e){
    const known=['sandbox_refunds_disabled','verified_payment_required','verified_full_refund_required','invalid_fulfillment_state','invalid_fulfillment_transition','refund_not_requested','refund_verification_failed','seller_provider_request_failed','seller_provider_auth_failed','payment_verification_failed','invalid_approval_link','payment_status_unknown','invalid_request_key','Invalid basket','order_key_conflict','sandbox_limit_100_usd','sandbox_pickup_only','too_many_sellers','seller_not_authorized','sandbox_order_expired','paypal_approval_required','capture_must_be_reconciled','inventory_review_required','unexpected_capture_requires_review'];
    if(e.message==='sandbox_order_not_found')return res.status(404).json({error:e.message});
    if(known.includes(e.message))return res.status(409).json({error:e.message});
    return res.status(503).json({error:'sandbox_checkout_unavailable'});
  }
  router.get('/',async(req,res)=>{try{res.json({orders:(await service().list(req.beautyActorId)).map(publicSandboxOrder)});}catch(e){error(res,e);}});
  router.post('/',async(req,res)=>{try{res.json({order:publicSandboxOrder(await service().reserve(req.beautyActorId,req.body?.requestKey,req.body?.items))});}catch(e){error(res,e);}});
  router.get('/webhooks',async(_req,res)=>{try{res.json({webhooks:await webhooks().list()});}catch(e){error(res,e);}});
  router.post('/webhooks/:eventId/retry',async(req,res)=>{
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.eventId))return res.status(404).json({error:'webhook_not_found'});
    try{res.json(await webhooks().retry(req.params.eventId));}catch(e){error(res,e);}
  });
  router.post('/:id/:action',async(req,res)=>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)||!['prepare','capture','retryCapture','reconcile','cancel','refund','refundCheck','refundRetry','ready','collected','restock'].includes(req.params.action))return res.status(404).json({error:'sandbox_order_not_found'});
    try{
      const a=req.params.action,buyer=req.beautyActorId,id=req.params.id;
      const order=a==='refund'?await operations().requestRefund(buyer,id):a==='refundCheck'?await operations().processRefund(buyer,id,false):a==='refundRetry'?await operations().processRefund(buyer,id,true):['ready','collected'].includes(a)?await operations().fulfillment(buyer,id,a):a==='restock'?await operations().restock(buyer,id):await service()[a](buyer,id);
      res.json({order:publicSandboxOrder(order)});
    }catch(e){error(res,e);}
  });
  return router;
}
