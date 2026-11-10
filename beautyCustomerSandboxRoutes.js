import {BEAUTY_PRICING_POLICY,beautyRefundTerms} from './client/src/lib/beautyOrderPricing.js';
import express from 'express';
import {getDbPool} from './db.js';
import {createBeautyPayPalProvider} from './beautySellerPayments.js';
import {createSandboxCheckout,assertSandboxCheckout} from './beautySandboxCheckout.js';
const uuid=v=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v||'');
export function customerSandboxEligible(buyer,provider,env){
 const ids=String(env.BEAUTY_CUSTOMER_SANDBOX_BUYER_IDS||'').split(',').map(x=>x.trim().toLowerCase()).filter(uuid);
 return env.BEAUTY_CUSTOMER_SANDBOX_ENABLED==='1'&&env.BEAUTY_SANDBOX_CHECKOUT_ENABLED==='1'&&provider.config.configured===true&&provider.config.environment==='sandbox'&&ids.includes(String(buyer).toLowerCase());
}
export function customerSandboxOrder(row){
 const q=row.quote;
 return {...beautyRefundTerms(q),id:row.id,status:row.status,sandbox:true,createdAt:row.created_at,expiresAt:row.expires_at,
  pickupStatus:row.fulfillment_status||'processing',refundStatus:row.refund_status||'none',reviewRequired:row.payment_review===true||row.status==='review_required',
  approvalUrl:row.status==='paypal_created'?row.approval_url:null,
  quote:{lines:q.lines.map(l=>({productId:l.productId,name:l.name,quantity:l.quantity,unitPriceCents:l.unitPriceCents,pickupLocation:l.pickupLocation})),subtotalCents:q.subtotalCents,platformFeeCents:q.platformFeeCents,totalCents:q.totalBeforeTaxShippingCents}};
}
export function createBeautyCustomerSandboxRouter({query,resolveToken,getPool=getDbPool,provider=createBeautyPayPalProvider(),env=process.env,createService=createSandboxCheckout}={}){
 const router=express.Router();
 const service=()=>createService({pool:getPool(),provider,env,customerReturn:true,maxActiveOrders:3});
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 router.use(async(req,res,next)=>{
  try{
   const match=/^Bearer\s+(.+)$/i.exec(req.get('authorization')||'');
   const user=match&&await resolveToken(match[1]);
   if(!uuid(user?.id))return res.status(401).json({error:'authentication_required'});
   const row=(await query('SELECT id, account_status FROM app_users WHERE id=$1::uuid LIMIT 1',[user.id])).rows?.[0];
   if(!row||(row.account_status&&row.account_status!=='active'))return res.status(403).json({error:'active_account_required'});
   req.beautyBuyerId=user.id;next();
  }catch{res.status(503).json({error:'authorization_unavailable'});}
 });
 router.get('/config',(req,res)=>res.json({sandbox:true,liveCheckoutEnabled:false,eligible:customerSandboxEligible(req.beautyBuyerId,provider,env),pickupOnly:true,maxTotalCents:10000}));
 router.use((_req,res,next)=>{try{assertSandboxCheckout(provider,env);next();}catch{res.status(503).json({error:'sandbox_checkout_disabled'});}});
 router.use(express.json({limit:'32kb'}));
 function error(res,e){
  if(e.message==='sandbox_order_not_found')return res.status(404).json({error:'order_not_found'});
  const allowed=['Invalid basket','invalid_request_key','order_key_conflict','sandbox_limit_100_usd','sandbox_pickup_only','too_many_sellers','seller_not_authorized','sandbox_order_expired','paypal_approval_required','capture_must_be_reconciled','sandbox_active_order_limit'];
  res.status(allowed.includes(e.message)?409:503).json({error:allowed.includes(e.message)?e.message:'checkout_unavailable'});
 }
 router.get('/orders',async(req,res)=>{try{res.json({orders:(await service().list(req.beautyBuyerId)).map(customerSandboxOrder)});}catch(e){error(res,e);}});
 router.get('/orders/:id',async(req,res)=>{
  if(!uuid(req.params.id))return res.status(404).json({error:'order_not_found'});
  try{res.json({order:customerSandboxOrder(await service().read(req.beautyBuyerId,req.params.id))});}catch(e){error(res,e);}
 });
 // Refunds, pickup changes, seller bindings and provider tokens are never customer actions.
 router.post('/orders',async(req,res)=>{
  if(!customerSandboxEligible(req.beautyBuyerId,provider,env))return res.status(403).json({error:'customer_trial_not_enabled'});
  if(req.body?.pricingPolicy!==BEAUTY_PRICING_POLICY||req.body?.acceptFeePolicy!==true)return res.status(409).json({error:'fee_policy_acceptance_required'});
  try{res.json({order:customerSandboxOrder(await service().reserve(req.beautyBuyerId,req.body?.requestKey,req.body?.items))});}catch(e){error(res,e);}
 });
 router.post('/orders/:id/:action',async(req,res)=>{
  const {id,action}=req.params;
  if(!uuid(id)||!['prepare','capture','retryCapture','reconcile','cancel'].includes(action))return res.status(404).json({error:'order_not_found'});
  if(['prepare','capture','retryCapture'].includes(action)&&!customerSandboxEligible(req.beautyBuyerId,provider,env))return res.status(403).json({error:'customer_trial_not_enabled'});
  try{res.json({order:customerSandboxOrder(await service()[action](req.beautyBuyerId,id))});}catch(e){error(res,e);}
 });
 return router;
}
