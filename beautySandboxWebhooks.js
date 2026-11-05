import express from 'express';
import {createHash,randomUUID} from 'node:crypto';
import {getDbPool} from './db.js';
import {createBeautyPayPalProvider} from './beautySellerPayments.js';
import {createSandboxCheckout} from './beautySandboxCheckout.js';
import {createSandboxOperations} from './beautySandboxOperations.js';
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v)?v:null;
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)?v:null;
export function sandboxWebhookSummary(event){
 const r=event?.resource || {},related=r.supplementary_data?.related_ids || {};
 let captureId=id(related.capture_id);
 if(!captureId)for(const link of r.links || []){
  try{const u=new URL(link.href);const match=/^\/v2\/payments\/captures\/([A-Z0-9]{5,64})$/.exec(u.pathname);
   if(link.rel==='up'&&u.protocol==='https:'&&['api-m.sandbox.paypal.com','api.sandbox.paypal.com'].includes(u.hostname)&&match)captureId=match[1];
  }catch{}
 }
 return {resourceId:id(r.id),orderId:id(related.order_id),captureId,customId:uuid(r.custom_id),merchantId:id(r.merchant_id)};
}
export async function verifySandboxWebhook(provider,env,headers,event){
 if(provider.config.environment!=='sandbox'||!provider.config.configured||!env.BEAUTY_PAYPAL_WEBHOOK_ID)throw Error('sandbox_webhooks_not_configured');
 if(!id(event?.id)||typeof event.event_type!=='string'||event.event_type.length>128||Buffer.byteLength(JSON.stringify(event))>262144)throw Error('invalid_webhook');
 const keys=['paypal-auth-algo','paypal-cert-url','paypal-transmission-id','paypal-transmission-sig','paypal-transmission-time'];
 for(const key of keys)if(typeof headers[key]!=='string'||!headers[key]||headers[key].length>8192)throw Error('invalid_webhook');
 let cert;try{cert=new URL(headers['paypal-cert-url']);}catch{throw Error('invalid_webhook');}
 if(cert.protocol!=='https:'||!['api.sandbox.paypal.com','api-m.sandbox.paypal.com','api.paypal.com','api-m.paypal.com'].includes(cert.hostname)||!/^\/v1\/notifications\/certs\/[A-Za-z0-9_-]+$/.test(cert.pathname)||cert.username||cert.password||cert.port)throw Error('invalid_webhook');
 const result=await provider.request('/v1/notifications/verify-webhook-signature',{method:'POST',body:{auth_algo:headers['paypal-auth-algo'],cert_url:headers['paypal-cert-url'],transmission_id:headers['paypal-transmission-id'],transmission_sig:headers['paypal-transmission-sig'],transmission_time:headers['paypal-transmission-time'],webhook_id:env.BEAUTY_PAYPAL_WEBHOOK_ID,webhook_event:event}});
 if(result?.verification_status!=='SUCCESS')throw Error('invalid_webhook_signature');
}
export function createSandboxWebhookStore({pool,provider,env=process.env}){
 const scope=[provider.config.clientId,provider.config.partnerId];
 // Verified events only reconcile existing records; they never create or capture payments.
 const readEnv={...env,BEAUTY_SANDBOX_CHECKOUT_ENABLED:'1'};
 const checkout=createSandboxCheckout({pool,provider,env:readEnv}),operations=createSandboxOperations({pool,provider,env:readEnv});
 async function process(event){
  const s=event.resource_summary,type=event.event_type;
  if(type==='MERCHANT.PARTNER-CONSENT.REVOKED'){
   if(!s.merchantId)return false;
   const changed=await pool.query("UPDATE beauty_seller_payment_accounts SET status='pending',permissions_granted=false,checked_at=now() WHERE environment='sandbox' AND partner_client_id=$1 AND partner_id=$2 AND merchant_id=$3 RETURNING seller_id",[...scope,s.merchantId]);
   await pool.query("UPDATE beauty_sandbox_orders SET payment_review=true,fulfillment_status='halted' WHERE partner_client_id=$1 AND partner_id=$2 AND bindings @> $3::jsonb",[...scope,JSON.stringify([{merchantId:s.merchantId}])]);
   return changed.rows.length>0;
  }
  const refund=(await pool.query(`SELECT r.order_id FROM beauty_sandbox_refunds r JOIN beauty_sandbox_orders o ON o.id=r.order_id
    WHERE o.partner_client_id=$1 AND o.partner_id=$2 AND (r.provider_refund_id=$3 OR r.request_id=$4::uuid) LIMIT 1`,[...scope,s.resourceId,s.customId])).rows[0];
  const found=await pool.query(`SELECT o.* FROM beauty_sandbox_orders o WHERE o.partner_client_id=$1 AND o.partner_id=$2 AND
    (o.paypal_order_id=$3 OR o.id=$4::uuid OR o.id=$5::uuid OR EXISTS(SELECT 1 FROM beauty_sandbox_captures c WHERE c.order_id=o.id AND c.capture_id=$6)) LIMIT 1`,
    [...scope,s.orderId,refund?.order_id || null,s.customId,s.captureId || s.resourceId]);
  const order=found.rows[0];if(!order)return false;
  if(type==='PAYMENT.CAPTURE.REFUNDED'){
   if(refund){await operations.processRefund(order.buyer_id,order.id,false);return true;}
   await pool.query("UPDATE beauty_sandbox_orders SET refund_status=CASE WHEN refund_status='completed' THEN refund_status ELSE 'external_review' END,payment_review=true,fulfillment_status='halted' WHERE id=$1::uuid",[order.id]);return true;
  }
  if(['PAYMENT.CAPTURE.REVERSED','PAYMENT.CAPTURE.DENIED'].includes(type)){
   await pool.query("UPDATE beauty_sandbox_orders SET payment_review=true,fulfillment_status='halted' WHERE id=$1::uuid",[order.id]);return true;
  }
  if(type==='PAYMENT.CAPTURE.COMPLETED'){
   if(order.status==='paid'||order.refund_status!=='none')return true;
   if(order.status==='cancelled'){await pool.query("UPDATE beauty_sandbox_orders SET payment_review=true,fulfillment_status='halted' WHERE id=$1::uuid",[order.id]);return true;}
   await pool.query("UPDATE beauty_sandbox_orders SET status='capture_pending' WHERE id=$1::uuid AND status='paypal_created'",[order.id]);
   const result=await checkout.reconcile(order.buyer_id,order.id);
   // A temporary PayPal failure must be retried rather than acknowledged as fully processed.
   if(result.status!=='paid')throw Error('payment_reconciliation_pending');return true;
  }
  return true;
 }
 return {
  async receive(event){
   const hash=createHash('sha256').update(JSON.stringify(event)).digest('hex');
   const r=await pool.query(`INSERT INTO beauty_sandbox_webhook_events(partner_client_id,partner_id,event_id,event_type,event_hash,resource_summary)
    VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(partner_client_id,partner_id,event_id) DO NOTHING RETURNING event_id`,[...scope,event.id,event.event_type,hash,JSON.stringify(sandboxWebhookSummary(event))]);
   if(!r.rows.length){const old=(await pool.query('SELECT event_hash FROM beauty_sandbox_webhook_events WHERE partner_client_id=$1 AND partner_id=$2 AND event_id=$3',[...scope,event.id])).rows[0];if(old?.event_hash!==hash)throw Error('webhook_event_conflict');}
   return this.retry(event.id);
  },
  async retry(eventId){
   const token=randomUUID();
   const r=await pool.query(`UPDATE beauty_sandbox_webhook_events SET status='processing',lease_token=$4::uuid,lease_until=now()+interval '2 minutes',attempts=attempts+1
     WHERE partner_client_id=$1 AND partner_id=$2 AND event_id=$3 AND (status IN ('received','failed','unmatched') OR(status='processing' AND lease_until<now())) RETURNING *`,[...scope,eventId,token]);
   if(!r.rows[0]){const old=(await pool.query('SELECT status FROM beauty_sandbox_webhook_events WHERE partner_client_id=$1 AND partner_id=$2 AND event_id=$3',[...scope,eventId])).rows[0];if(old?.status==='processed')return {duplicate:true};throw Error('webhook_busy_or_missing');}
   let status;
   try{status=await process(r.rows[0])?'processed':'unmatched';}
   catch(e){await pool.query("UPDATE beauty_sandbox_webhook_events SET status='failed',lease_until=NULL WHERE partner_client_id=$1 AND partner_id=$2 AND event_id=$3 AND lease_token=$4::uuid",[...scope,eventId,token]);throw e;}
   await pool.query('UPDATE beauty_sandbox_webhook_events SET status=$5,processed_at=now(),lease_until=NULL WHERE partner_client_id=$1 AND partner_id=$2 AND event_id=$3 AND lease_token=$4::uuid',[...scope,eventId,token,status]);return {status};
  },
  async list(){const r=await pool.query('SELECT event_id,event_type,status,attempts,verified_at,processed_at FROM beauty_sandbox_webhook_events WHERE partner_client_id=$1 AND partner_id=$2 ORDER BY verified_at DESC LIMIT 30',scope);return r.rows;}
 };
}
export function createSandboxWebhookRouter({getPool=getDbPool,provider=createBeautyPayPalProvider(),env=process.env}={}){
 const router=express.Router();
 router.post('/api/beauty/paypal/sandbox-webhook',express.json({limit:'256kb'}),async(req,res)=>{
  try{await verifySandboxWebhook(provider,env,req.headers,req.body);}
  catch(e){return res.status(e.message==='sandbox_webhooks_not_configured'?503:e.message.startsWith('invalid_webhook')?400:503).json({error:'webhook_not_verified'});}
  try{const result=await createSandboxWebhookStore({pool:getPool(),provider,env}).receive(req.body);return res.json({received:true,...result});}
  catch{return res.status(503).json({error:'webhook_processing_retry_required'});}
 });return router;
}
