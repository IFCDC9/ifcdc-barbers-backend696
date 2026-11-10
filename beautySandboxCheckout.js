import {beautyRefundTerms} from './client/src/lib/beautyOrderPricing.js';
import { randomUUID } from 'node:crypto';
import { basketFingerprint } from './beautyOrderDrafts.js';
import { quoteBeautyOrder } from './beautyOrderService.js';
import { sandboxPurchaseUnits,verifySandboxOrder,safeSandboxApprovalLink } from './beautySandboxPaymentContract.js';
export function assertSandboxCheckout(provider,env=process.env){
  if(env.BEAUTY_SANDBOX_CHECKOUT_ENABLED!=='1'||!provider.config.configured||provider.config.environment!=='sandbox')throw Error('sandbox_checkout_disabled');
}
export function publicSandboxOrder(row){
  return {...(row.quote?beautyRefundTerms(row.quote):{}),id:row.id,status:row.status,quote:row.quote,expiresAt:row.expires_at,createdAt:row.created_at,refundStatus:row.refund_status || 'none',refundIssue:row.refund_issue==='PLATFORM_FEE_NOT_ENABLED'?'PLATFORM_FEE_NOT_ENABLED':null,fulfillmentStatus:row.fulfillment_status || 'processing',paymentReview:row.payment_review === true,inventoryRestocked:row.inventory_restocked === true,
    approvalUrl:row.status==='paypal_created'?row.approval_url:null,sandbox:true};
}
export function createSandboxCheckout({pool,provider,env=process.env,customerReturn=false,maxActiveOrders=null}){
  const scope=[provider.config.clientId,provider.config.partnerId];
  const assertEnabled=()=>assertSandboxCheckout(provider,env);
  async function tx(fn){
    const client=await pool.connect();
    try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
    catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  async function event(c,id,name){await c.query('INSERT INTO beauty_sandbox_order_events(order_id,event) VALUES($1::uuid,$2)',[id,name]);}
  async function lock(c,buyer,id){
    const r=await c.query('SELECT * FROM beauty_sandbox_orders WHERE id=$1::uuid AND buyer_id=$2::uuid AND partner_client_id=$3 AND partner_id=$4 FOR UPDATE',[id,buyer,...scope]);
    if(!r.rows[0])throw Error('sandbox_order_not_found');return r.rows[0];
  }
  async function eligible(c,sellerId,expectedMerchant){
    const r=await c.query("SELECT * FROM beauty_seller_payment_accounts WHERE seller_id=$1 AND environment='sandbox' AND partner_client_id=$2 AND partner_id=$3",[sellerId,...scope]);
    const row=r.rows[0];if(!row)throw Error('seller_not_authorized');
    const s=await provider.verify(row.tracking_id);
    if(s?.status!=='account_authorized'||s.merchantId!==row.merchant_id||(expectedMerchant&&s.merchantId!==expectedMerchant))throw Error('seller_not_authorized');
    return s.merchantId;
  }
  async function catalog(c){
    const r=await c.query('SELECT catalog FROM beauty_catalog_state WHERE id=1 FOR UPDATE');
    if(!r.rows[0])throw Error('catalog_unavailable');return r.rows[0].catalog;
  }
  async function saveCatalog(c,value){await c.query('UPDATE beauty_catalog_state SET catalog=$1::jsonb,revision=revision+1 WHERE id=1',[JSON.stringify(value)]);}
  async function reconcile(c,row){
    let remote;try{remote=await provider.request('/v2/checkout/orders/'+encodeURIComponent(row.paypal_order_id));}
    catch{return row;}
    if(!remote)return row;
    let captures;
    try{captures=verifySandboxOrder(remote,row,provider.config.partnerId,{captured:true});}
    catch{
      // Completed/partial/unknown outcomes never free stock or pretend payment succeeded.
      const r=await c.query("UPDATE beauty_sandbox_orders SET status='review_required' WHERE id=$1::uuid RETURNING *",[row.id]);
      await event(c,row.id,'capture_needs_review');return r.rows[0];
    }
    for(const cap of captures)await c.query('INSERT INTO beauty_sandbox_captures(capture_id,order_id,seller_id,details) VALUES($1,$2::uuid,$3,$4::jsonb)',[cap.id,row.id,cap.sellerId,JSON.stringify(cap)]);
    const r=await c.query("UPDATE beauty_sandbox_orders SET status='paid',paid_at=now() WHERE id=$1::uuid RETURNING *",[row.id]);
    await event(c,row.id,'capture_verified');return r.rows[0];
  }
  return {
    async reserve(buyer,key,items){
      assertEnabled();if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key||''))throw Error('invalid_request_key');
      const hash=basketFingerprint(items);
      return tx(async c=>{
        // Serialize reservations against the catalog, including retries, before checking stock.
        const cat=await catalog(c);
        const old=await c.query('SELECT * FROM beauty_sandbox_orders WHERE buyer_id=$1::uuid AND request_key=$2::uuid',[buyer,key]);
        if(old.rows[0]){const row=old.rows[0];if(row.basket_hash!==hash||row.partner_client_id!==scope[0]||row.partner_id!==scope[1])throw Error('order_key_conflict');return row;}
        if(maxActiveOrders!==null){
          const active=await c.query("SELECT count(*)::int AS count FROM beauty_sandbox_orders WHERE buyer_id=$1::uuid AND partner_client_id=$2 AND partner_id=$3 AND status IN ('reserved','paypal_created','capture_pending','review_required')",[buyer,...scope]);
          if(active.rows[0].count>=maxActiveOrders)throw Error('sandbox_active_order_limit');
        }
        const quote=quoteBeautyOrder(cat,items);
        if(quote.totalBeforeTaxShippingCents>10000)throw Error('sandbox_limit_100_usd');
        const source=new Map(cat.products.map(p=>[p.id,p]));
        for(const line of quote.lines)if(!source.get(line.productId)?.fulfillment?.includes('pickup'))throw Error('sandbox_pickup_only');
        if(quote.sellerAllocations.length>10)throw Error('too_many_sellers');
        const bindings=[];
        for(const a of quote.sellerAllocations)bindings.push({sellerId:a.sellerId,merchantId:await eligible(c,a.sellerId)});
        quote.sandbox=true;quote.fulfillment='pickup';quote.taxCents=0;quote.shippingCents=0;quote.taxTreatment='simulated_zero_tax_sandbox_only';
        for(const line of quote.lines){const p=source.get(line.productId);line.pickupLocation=p.pickupLocation;p.stock-=line.quantity;}
        const r=await c.query(`INSERT INTO beauty_sandbox_orders(id,buyer_id,request_key,basket_hash,partner_client_id,partner_id,quote,bindings)
          VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb,$8::jsonb) RETURNING *`,[randomUUID(),buyer,key,hash,...scope,JSON.stringify(quote),JSON.stringify(bindings)]);
        await saveCatalog(c,cat);await event(c,r.rows[0].id,'stock_reserved');return r.rows[0];
      });
    },
    async list(buyer){assertEnabled();const r=await pool.query("SELECT o.*, (SELECT r.result->>'issue' FROM beauty_sandbox_refunds r WHERE r.order_id=o.id AND r.result->>'issue'='PLATFORM_FEE_NOT_ENABLED' LIMIT 1) AS refund_issue FROM beauty_sandbox_orders o WHERE buyer_id=$1::uuid AND partner_client_id=$2 AND partner_id=$3 ORDER BY created_at DESC LIMIT 20",[buyer,...scope]);return r.rows;},
    async read(buyer,id){assertEnabled();return tx(c=>lock(c,buyer,id));},
    async listForFounder(){assertEnabled();return (await pool.query("SELECT o.*, (SELECT r.result->>'issue' FROM beauty_sandbox_refunds r WHERE r.order_id=o.id AND r.result->>'issue'='PLATFORM_FEE_NOT_ENABLED' LIMIT 1) AS refund_issue FROM beauty_sandbox_orders o WHERE partner_client_id=$1 AND partner_id=$2 ORDER BY created_at DESC LIMIT 100",scope)).rows;},
    async ownerForFounder(id){assertEnabled();const r=await pool.query('SELECT buyer_id FROM beauty_sandbox_orders WHERE id=$1::uuid AND partner_client_id=$2 AND partner_id=$3',[id,...scope]);if(!r.rows[0])throw Error('sandbox_order_not_found');return r.rows[0].buyer_id;},
    async prepare(buyer,id){
      assertEnabled();return tx(async c=>{
        const row=await lock(c,buyer,id);
        if(row.status!=='reserved')return row;
        if(new Date(row.expires_at)<=new Date())throw Error('sandbox_order_expired');
        for(const b of row.bindings)await eligible(c,b.sellerId,b.merchantId);
        const units=sandboxPurchaseUnits(row,provider.config.partnerId);
        const remote=await provider.request('/v2/checkout/orders',{method:'POST',requestId:row.id+'-o',body:{intent:'CAPTURE',purchase_units:units,
          application_context:{brand_name:'IFCDC Sandbox Test',user_action:'PAY_NOW',shipping_preference:'NO_SHIPPING',return_url:'https://ifcdcbarbersapp.com'+(customerReturn?'/beauty-supply':'/admin/beauty-supply')+'?beautySandbox=return',cancel_url:'https://ifcdcbarbersapp.com'+(customerReturn?'/beauty-supply':'/admin/beauty-supply')+'?beautySandbox=cancel'}}});
        if(typeof remote?.id!=='string'||!/^[A-Z0-9]{5,40}$/.test(remote.id))throw Error('invalid_paypal_order');
        verifySandboxOrder(remote,{...row,paypal_order_id:remote.id},provider.config.partnerId);
        const url=safeSandboxApprovalLink(remote);
        const r=await c.query("UPDATE beauty_sandbox_orders SET paypal_order_id=$2,approval_url=$3,status='paypal_created' WHERE id=$1::uuid RETURNING *",[row.id,remote.id,url]);
        await event(c,row.id,'paypal_order_created');return r.rows[0];
      });
    },
    async capture(buyer,id,{retry=false}={}){
      assertEnabled();
      // Commit the attempt marker before contacting PayPal. An uncertain capture keeps its reservation.
      const row=await tx(async c=>{
        const row=await lock(c,buyer,id);
        if(row.status!=='paypal_created' && !(retry&&['capture_pending','review_required'].includes(row.status)))return row;
        if(new Date(row.expires_at)<=new Date())throw Error('sandbox_order_expired');
        const cat=await catalog(c);
        for(const l of row.quote.lines)if(!cat.products.some(p=>p.id===l.productId&&p.sellerId===l.sellerId&&p.status==='published'))throw Error('seller_not_authorized');
        for(const b of row.bindings){if(!cat.sellers.some(s=>s.id===b.sellerId&&s.status==='approved'))throw Error('seller_not_authorized');await eligible(c,b.sellerId,b.merchantId);}
        const remote=await provider.request('/v2/checkout/orders/'+encodeURIComponent(row.paypal_order_id));
        if(remote?.status==='COMPLETED'||remote?.purchase_units?.some(u=>(u.payments?.captures||[]).length)){
          const r=await c.query("UPDATE beauty_sandbox_orders SET status='capture_pending' WHERE id=$1::uuid RETURNING *",[row.id]);
          await event(c,row.id,'existing_capture_found');return r.rows[0];
        }
        verifySandboxOrder(remote,row,provider.config.partnerId);
        if(remote.status!=='APPROVED')throw Error('paypal_approval_required');
        if(remote.purchase_units.some(u=>(u.payments?.captures||[]).length))throw Error('unexpected_capture_requires_review');
        const r=await c.query("UPDATE beauty_sandbox_orders SET status='capture_pending' WHERE id=$1::uuid RETURNING *",[row.id]);
        await event(c,row.id,retry?'same_capture_retried':'capture_requested');return {...r.rows[0],submitCapture:true};
      });
      if(row.submitCapture){
        try{await provider.request('/v2/checkout/orders/'+encodeURIComponent(row.paypal_order_id)+'/capture',{method:'POST',requestId:row.id+'-c',body:{}});}catch{/* Reconcile after timeouts/errors; never assume money did not move. */}
      }
      return tx(async c=>{const current=await lock(c,buyer,id);return ['capture_pending','review_required'].includes(current.status)?reconcile(c,current):current;});
    },
    async retryCapture(buyer,id){return this.capture(buyer,id,{retry:true});},
    async reconcile(buyer,id){assertEnabled();return tx(async c=>{const row=await lock(c,buyer,id);return ['capture_pending','review_required'].includes(row.status)?reconcile(c,row):row;});},
    async cancel(buyer,id){
      assertEnabled();return tx(async c=>{
        const row=await lock(c,buyer,id);
        if(row.status==='cancelled')return row;
        if(!['reserved','paypal_created'].includes(row.status))throw Error('capture_must_be_reconciled');
        if(row.paypal_order_id){
          const remote=await provider.request('/v2/checkout/orders/'+encodeURIComponent(row.paypal_order_id));
          if(!remote)throw Error('payment_status_unknown');
          if(remote.status==='COMPLETED'||remote.purchase_units?.some(u=>(u.payments?.captures||[]).length)){
            const r=await c.query("UPDATE beauty_sandbox_orders SET status='capture_pending' WHERE id=$1::uuid RETURNING *",[row.id]);
            await event(c,row.id,'capture_found_during_release');return reconcile(c,r.rows[0]);
          }
          verifySandboxOrder(remote,row,provider.config.partnerId);
          if(!['CREATED','SAVED','APPROVED','VOIDED','PAYER_ACTION_REQUIRED'].includes(remote.status))throw Error('payment_status_unknown');
        }
        const cat=await catalog(c);
        for(const l of row.quote.lines){const p=cat.products.find(p=>p.id===l.productId&&p.sellerId===l.sellerId);if(!p||!Number.isSafeInteger(p.stock+l.quantity))throw Error('inventory_review_required');p.stock+=l.quantity;}
        await saveCatalog(c,cat);const r=await c.query("UPDATE beauty_sandbox_orders SET status='cancelled',approval_url=NULL WHERE id=$1::uuid RETURNING *",[row.id]);await event(c,row.id,'reservation_released');return r.rows[0];
      });
    }
  };
}
