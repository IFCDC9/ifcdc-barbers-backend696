import {randomUUID} from 'node:crypto';
import {assertSandboxCheckout} from './beautySandboxCheckout.js';
import {verifySandboxOrder} from './beautySandboxPaymentContract.js';
import {refundRequestBody,verifySandboxRefund} from './beautySandboxRefundContract.js';
export function createSandboxOperations({pool,provider,env=process.env}){
 const scope=[provider.config.clientId,provider.config.partnerId];
 const assertEnabled=()=>assertSandboxCheckout(provider,env);
 async function tx(fn){const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async function lock(c,buyer,id){const r=await c.query('SELECT * FROM beauty_sandbox_orders WHERE id=$1::uuid AND buyer_id=$2::uuid AND partner_client_id=$3 AND partner_id=$4 FOR UPDATE',[id,buyer,...scope]);if(!r.rows[0])throw Error('sandbox_order_not_found');return r.rows[0];}
 const event=(c,id,name)=>c.query('INSERT INTO beauty_sandbox_order_events(order_id,event) VALUES($1::uuid,$2)',[id,name]);
 async function checkRefund(c,row,remote){
   let result;try{result=verifySandboxRefund(remote,row);}catch{result={status:'review_required'};}
   // Even a malformed refund response with a returned ID is never blindly retried as a new refund.
   const refundId=row.provider_refund_id || (typeof remote?.id==='string'&&/^[A-Z0-9]{5,64}$/.test(remote.id)?remote.id:null);
   await c.query('UPDATE beauty_sandbox_refunds SET provider_refund_id=COALESCE(provider_refund_id,$2),status=$3,result=$4::jsonb,checked_at=now() WHERE capture_id=$1',[row.capture_id,refundId,result.status,JSON.stringify(result)]);
 }
 async function refundSummary(c,order){
   const rows=(await c.query('SELECT * FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[order.id])).rows;
   const caps=(await c.query('SELECT * FROM beauty_sandbox_captures WHERE order_id=$1::uuid',[order.id])).rows;
   const total=rows.reduce((n,r)=>n+Number(r.amount_cents),0);
   const status=rows.length===caps.length&&rows.length>0&&total===order.quote.totalBeforeTaxShippingCents&&rows.every(r=>r.status==='completed')?'completed':rows.some(r=>r.status==='review_required')?'review_required':'pending';
   const r=await c.query("UPDATE beauty_sandbox_orders SET refund_status=$2,fulfillment_status='halted' WHERE id=$1::uuid RETURNING *",[order.id,status]);
   await event(c,order.id,'refund_'+status);return {...r.rows[0],refund_issue:rows.some(x=>x.result?.issue==='PLATFORM_FEE_NOT_ENABLED')?'PLATFORM_FEE_NOT_ENABLED':null};
 }
 return {
  async requestRefund(buyer,id){
   assertEnabled();if(env.BEAUTY_SANDBOX_REFUNDS_ENABLED!=='1')throw Error('sandbox_refunds_disabled');
   await tx(async c=>{
    const order=await lock(c,buyer,id);if(order.refund_status!=='none')return;
    if(order.status!=='paid'||order.payment_review)throw Error('verified_payment_required');
    const caps=(await c.query('SELECT * FROM beauty_sandbox_captures WHERE order_id=$1::uuid',[id])).rows;
    if(!caps.length||caps.reduce((n,c)=>n+c.details.grossCents,0)!==order.quote.totalBeforeTaxShippingCents)throw Error('verified_payment_required');
    for(const cap of caps)await c.query('INSERT INTO beauty_sandbox_refunds(capture_id,order_id,request_id,merchant_id,amount_cents,platform_fee_cents) VALUES($1,$2::uuid,$3::uuid,$4,$5,$6)',[cap.capture_id,id,randomUUID(),cap.details.merchantId,cap.details.grossCents,cap.details.platformFeeCents]);
    await c.query("UPDATE beauty_sandbox_orders SET refund_status='requested',fulfillment_status='halted' WHERE id=$1::uuid",[id]);await event(c,id,'full_refund_requested');
   });
   return this.processRefund(buyer,id,true);
  },
  async processRefund(buyer,id,submit=false){
   assertEnabled();if(submit&&env.BEAUTY_SANDBOX_REFUNDS_ENABLED!=='1')throw Error('sandbox_refunds_disabled');
   return tx(async c=>{
    const order=await lock(c,buyer,id);if(order.refund_status==='none')throw Error('refund_not_requested');
    if(['completed','external_review'].includes(order.refund_status))return order;
    const refunds=(await c.query('SELECT * FROM beauty_sandbox_refunds WHERE order_id=$1::uuid ORDER BY capture_id',[id])).rows;
    for(const row of refunds){
      if(row.status==='completed')continue;
      let remote;
      try{
       if(row.provider_refund_id)remote=await provider.request('/v2/payments/refunds/'+encodeURIComponent(row.provider_refund_id),{merchantId:row.merchant_id});
       else{
        // Recover a response lost after PayPal created the refund using this immutable custom ID.
        const paypal=await provider.request('/v2/checkout/orders/'+encodeURIComponent(order.paypal_order_id));
        const unit=paypal?.purchase_units?.find(u=>u.payee?.merchant_id===row.merchant_id&&u.payments?.captures?.some(x=>x.id===row.capture_id));
        for(const ref of unit?.payments?.refunds || []){
         if(typeof ref.id!=='string'||!/^[A-Z0-9]{5,64}$/.test(ref.id))continue;
         const detail=await provider.request('/v2/payments/refunds/'+ref.id,{merchantId:row.merchant_id});
         if(detail?.custom_id===row.request_id){remote=detail;break;}
        }
        if(!remote&&submit){
         if(Date.now()-new Date(row.created_at).getTime()>30*60*1000)throw Error('refund_retry_window_expired');
         // Refuse to refund again if the capture already has another refund or a non-completed state.
         const cap=unit?.payments?.captures?.find(x=>x.id===row.capture_id);
         if(!cap||cap.status!=='COMPLETED'||(unit.payments?.refunds||[]).length)throw Error('existing_refund_requires_review');
         remote=await provider.request('/v2/payments/captures/'+encodeURIComponent(row.capture_id)+'/refund',{method:'POST',requestId:row.request_id,merchantId:row.merchant_id,body:refundRequestBody(row)});
        }
       }
       if(remote)await checkRefund(c,row,remote);
      }catch(e){
       if(e.providerIssue==='PLATFORM_FEE_NOT_ENABLED'){
        await c.query("UPDATE beauty_sandbox_refunds SET status='review_required',result=$2::jsonb,checked_at=now() WHERE capture_id=$1",[row.capture_id,JSON.stringify({issue:'PLATFORM_FEE_NOT_ENABLED'})]);
       }
       // A timeout is an unknown outcome. Retain the same key and reconcile before any retry.
       if(['refund_retry_window_expired','existing_refund_requires_review'].includes(e.message))await c.query("UPDATE beauty_sandbox_refunds SET status='review_required' WHERE capture_id=$1",[row.capture_id]);
       await event(c,id,'refund_attempt_unresolved');
      }
    }
    return refundSummary(c,order);
   });
  },
  async fulfillment(buyer,id,target){
   assertEnabled();if(!['ready','collected'].includes(target))throw Error('invalid_fulfillment_state');
   return tx(async c=>{
    const order=await lock(c,buyer,id);
    if(order.status!=='paid'||order.refund_status!=='none'||order.payment_review)throw Error('verified_payment_required');
    if(order.fulfillment_status===target)return order;
    if((target==='ready'&&order.fulfillment_status!=='processing')||(target==='collected'&&order.fulfillment_status!=='ready'))throw Error('invalid_fulfillment_transition');
    const paypal=await provider.request('/v2/checkout/orders/'+encodeURIComponent(order.paypal_order_id));verifySandboxOrder(paypal,order,provider.config.partnerId,{captured:true});
    const catalog=(await c.query('SELECT catalog FROM beauty_catalog_state WHERE id=1')).rows[0]?.catalog;
    for(const b of order.bindings){
     if(!catalog?.sellers.some(s=>s.id===b.sellerId&&s.status==='approved'))throw Error('seller_not_authorized');
     const account=(await c.query("SELECT * FROM beauty_seller_payment_accounts WHERE seller_id=$1 AND environment='sandbox' AND partner_client_id=$2 AND partner_id=$3",[b.sellerId,...scope])).rows[0];
     const current=account&&await provider.verify(account.tracking_id);if(current?.status!=='account_authorized'||current.merchantId!==b.merchantId)throw Error('seller_not_authorized');
    }
    const r=await c.query('UPDATE beauty_sandbox_orders SET fulfillment_status=$2 WHERE id=$1::uuid RETURNING *',[id,target]);await event(c,id,'pickup_'+target);return r.rows[0];
   });
  },
  async restock(buyer,id){
   assertEnabled();return tx(async c=>{
    const order=await lock(c,buyer,id);if(order.refund_status!=='completed')throw Error('verified_full_refund_required');
    if(order.inventory_restocked)return order;
    const result=await c.query('SELECT catalog FROM beauty_catalog_state WHERE id=1 FOR UPDATE'),cat=result.rows[0]?.catalog;if(!cat)throw Error('inventory_review_required');
    for(const l of order.quote.lines){const p=cat.products.find(p=>p.id===l.productId&&p.sellerId===l.sellerId);if(!p||!Number.isSafeInteger(p.stock+l.quantity))throw Error('inventory_review_required');p.stock+=l.quantity;}
    await c.query('UPDATE beauty_catalog_state SET catalog=$1::jsonb,revision=revision+1 WHERE id=1',[JSON.stringify(cat)]);
    const r=await c.query('UPDATE beauty_sandbox_orders SET inventory_restocked=true WHERE id=$1::uuid RETURNING *',[id]);await event(c,id,'returned_items_restocked');return r.rows[0];
   });
  }
 };
}
