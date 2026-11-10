import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createSandboxCheckout} from '../beautySandboxCheckout.js';
import {createSandboxOperations} from '../beautySandboxOperations.js';
import {createSandboxWebhookStore} from '../beautySandboxWebhooks.js';
import {quoteBeautyOrder} from '../beautyOrderService.js';
import {sandboxPurchaseUnits,verifySandboxOrder,usd,cents} from '../beautySandboxPaymentContract.js';
const runDb=process.env.BEAUTY_CHECKOUT_DB_TESTS==='1';
test('sandbox refunds, pickup and webhook PostgreSQL integration',{skip:!runDb},async t=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();let tail=Promise.resolve();
 const pool={async connect(){const previous=tail;let unlock;tail=new Promise(r=>{unlock=r;});await previous;return {query:(...a)=>db.query(...a),release:unlock};},async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
 const buyer='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 const env={BEAUTY_SANDBOX_CHECKOUT_ENABLED:'1',BEAUTY_SANDBOX_REFUNDS_ENABLED:'1'};
 const cat={sellers:[{id:'seller',name:'Seller',status:'approved'}],products:[{id:'product',sellerId:'seller',name:'Test',brand:'IFCDC',category:'Hair care',priceCents:1000,stock:50,status:'published',fulfillment:['pickup'],pickupLocation:'Sandbox test location'}]};
 const remotes=new Map(),refunds=new Map(),keys=new Map();let seq=0,refundSeq=0,postCount=0,loseResponse=false,feeProof=true,providerAllowed=true,readFailures=0,rejectCapture=null,capabilityBlocked=false;
 const provider={config:{configured:true,environment:'sandbox',clientId:'partner-app',partnerId:'PARTNER1'},verify:async()=>({status:'account_authorized',merchantId:'SELLER1'}),request:async(path,o={})=>{
   if(path.startsWith('/v2/checkout/orders/')){if(readFailures){readFailures--;throw Error('temporary_network_failure');}return structuredClone(remotes.get(path.split('/').pop()) || null);}
   if(path.startsWith('/v2/payments/refunds/'))return structuredClone(refunds.get(path.split('/').pop()) || null);
   if(path.endsWith('/refund')&&o.method==='POST'){
    if(capabilityBlocked){const e=Error('seller_provider_request_failed');e.providerIssue='PLATFORM_FEE_NOT_ENABLED';throw e;}
    if(!providerAllowed||path.includes('/'+rejectCapture+'/'))throw Error('seller_provider_request_failed');
    postCount++;let refund=keys.get(o.requestId);
    if(!refund){
     const capture=path.split('/')[4],order=[...remotes.values()].find(r=>r.purchase_units.some(u=>u.payments.captures.some(c=>c.id===capture)));
     assert.ok(order);assert.equal(o.merchantId,order.purchase_units.find(u=>u.payments.captures.some(c=>c.id===capture)).payee.merchant_id);refund={id:'REFUND'+(++refundSeq),status:'COMPLETED',custom_id:o.body.custom_id,amount:o.body.amount,
       seller_payable_breakdown:feeProof?{platform_fees:o.body.payment_instruction.platform_fees}:{},links:[{rel:'up',method:'GET',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/'+capture}]};
     keys.set(o.requestId,refund);refunds.set(refund.id,refund);
     const unit=order.purchase_units.find(u=>u.payments.captures.some(c=>c.id===capture));unit.payments.captures[0].status='REFUNDED';unit.payments.refunds=[{id:refund.id}];
    }
    if(loseResponse){loseResponse=false;throw Error('response_lost');}return structuredClone(refund);
   }
   throw Error('unexpected_provider_request '+path);
 }};
 const operations=createSandboxOperations({pool,provider,env}),inbox=createSandboxWebhookStore({pool,provider,env});
 const stock=async()=>Number((await db.query('SELECT catalog FROM beauty_catalog_state')).rows[0].catalog.products[0].stock);
 async function seedPaid(multi=false){
  const source=structuredClone(cat);if(multi){source.sellers.push({id:'seller2',name:'Second seller',status:'approved'});source.products.push({...source.products[0],id:'product2',sellerId:'seller2',priceCents:500});}
  const id=randomUUID(),quote=quoteBeautyOrder(source,[{productId:'product',quantity:1},...(multi?[{productId:'product2',quantity:1}]:[])]),row={id,quote,bindings:[{sellerId:'seller',merchantId:'SELLER1'},...(multi?[{sellerId:'seller2',merchantId:'SELLER2'}]:[])],paypal_order_id:'ORDER'+(++seq)};
  const units=sandboxPurchaseUnits(row,'PARTNER1');for(const u of units)u.payments={captures:[{id:'CAPTURE'+seq+u.reference_id,status:'COMPLETED',final_capture:true,amount:usd(cents(u.amount)),seller_receivable_breakdown:{gross_amount:usd(cents(u.amount)),paypal_fee:usd(50),platform_fees:u.payment_instruction.platform_fees,net_amount:usd(cents(u.amount)-50-cents(u.payment_instruction.platform_fees[0].amount))}}]};
  const remote={id:row.paypal_order_id,intent:'CAPTURE',status:'COMPLETED',purchase_units:units};remotes.set(remote.id,remote);
  await db.query(`INSERT INTO beauty_sandbox_orders(id,buyer_id,request_key,basket_hash,partner_client_id,partner_id,status,quote,bindings,paypal_order_id,paid_at)
   VALUES($1::uuid,$2::uuid,$3::uuid,'hash','partner-app','PARTNER1','paid',$4::jsonb,$5::jsonb,$6,now())`,[id,buyer,randomUUID(),JSON.stringify(quote),JSON.stringify(row.bindings),row.paypal_order_id]);
  for(const cap of verifySandboxOrder(remote,row,'PARTNER1',{captured:true}))await db.query('INSERT INTO beauty_sandbox_captures(capture_id,order_id,seller_id,details) VALUES($1,$2::uuid,$3,$4::jsonb)',[cap.id,id,cap.sellerId,JSON.stringify(cap)]);
  const current=(await db.query('SELECT catalog FROM beauty_catalog_state')).rows[0].catalog;current.products[0].stock--;await db.query('UPDATE beauty_catalog_state SET catalog=$1::jsonb',[JSON.stringify(current)]);return row;
 }
 try{
  await db.exec('CREATE TABLE app_users(id uuid PRIMARY KEY);CREATE TABLE beauty_catalog_state(id integer PRIMARY KEY,revision integer NOT NULL DEFAULT 0,catalog jsonb NOT NULL);');
  await db.query('INSERT INTO app_users(id) VALUES($1::uuid),($2::uuid)',[buyer,other]);
  for(const f of ['beauty-sandbox-checkout.sql','beauty-seller-payment-accounts.sql','beauty-sandbox-operations.sql'])await db.exec(await readFile(new URL('../scripts/migrations/'+f,import.meta.url),'utf8'));
  await db.query('INSERT INTO beauty_catalog_state(id,catalog) VALUES(1,$1::jsonb)',[JSON.stringify(cat)]);
  await db.query(`INSERT INTO beauty_seller_payment_accounts(seller_id,environment,partner_client_id,partner_id,tracking_id,merchant_id,created_by) VALUES('seller','sandbox','partner-app','PARTNER1',$1::uuid,'SELLER1',$2::uuid)`,[randomUUID(),buyer]);
  await t.test('paid pickup moves through ready and collected with idempotent transitions',async()=>{
   const o=await seedPaid();assert.equal((await operations.fulfillment(buyer,o.id,'ready')).fulfillment_status,'ready');assert.equal((await operations.fulfillment(buyer,o.id,'ready')).fulfillment_status,'ready');
   assert.equal((await operations.fulfillment(buyer,o.id,'collected')).fulfillment_status,'collected');await assert.rejects(operations.fulfillment(buyer,o.id,'ready'),/invalid_fulfillment_transition/);
  });
  await t.test('concurrent full-refund requests issue one refund; restocking requires an explicit separate action',async()=>{
   const o=await seedPaid(),before=postCount,beforeStock=await stock();
   await assert.rejects(operations.requestRefund(other,o.id),/not_found/);
   const [a,b]=await Promise.all([operations.requestRefund(buyer,o.id),operations.requestRefund(buyer,o.id)]);assert.equal(a.refund_status,'completed');assert.equal(b.refund_status,'completed');assert.equal(postCount,before+1);assert.equal(await stock(),beforeStock);
   await assert.rejects(operations.fulfillment(buyer,o.id,'ready'),/verified_payment_required/);
   await operations.restock(buyer,o.id);await operations.restock(buyer,o.id);assert.equal(await stock(),beforeStock+1);
  });
  await t.test('a lost refund response is recovered by its immutable custom ID without another POST',async()=>{
   const o=await seedPaid(),before=postCount;loseResponse=true;
   assert.equal((await operations.requestRefund(buyer,o.id)).refund_status,'pending');
   assert.equal((await operations.processRefund(buyer,o.id,false)).refund_status,'completed');assert.equal(postCount,before+1);
  });
  await t.test('missing partner fee proof is visible review and never retried as a second refund',async()=>{
   const o=await seedPaid(),before=postCount;feeProof=false;
   assert.equal((await operations.requestRefund(buyer,o.id)).refund_status,'review_required');
   assert.equal((await operations.processRefund(buyer,o.id,true)).refund_status,'review_required');assert.equal(postCount,before+1);feeProof=true;
   await assert.rejects(operations.restock(buyer,o.id),/verified_full_refund_required/);
  });
  await t.test('provider rejection and expired retry window do not claim success or resubmit after expiry',async()=>{
   const o=await seedPaid();providerAllowed=false;assert.equal((await operations.requestRefund(buyer,o.id)).refund_status,'pending');providerAllowed=true,readFailures=0,rejectCapture=null;
   await db.query("UPDATE beauty_sandbox_refunds SET created_at=now()-interval '31 minutes' WHERE order_id=$1::uuid",[o.id]);
   const before=postCount;assert.equal((await operations.processRefund(buyer,o.id,true)).refund_status,'review_required');assert.equal(postCount,before);
  });
  await t.test('platform-fee rejection persists as review with a safe diagnostic across reloads',async()=>{
   const o=await seedPaid();capabilityBlocked=true;
   const result=await operations.requestRefund(buyer,o.id);
   assert.equal(result.refund_status,'review_required');assert.equal(result.refund_issue,'PLATFORM_FEE_NOT_ENABLED');assert.equal(result.fulfillment_status,'halted');
   const listed=await createSandboxCheckout({pool,provider,env}).list(buyer);
   assert.equal(listed.find(x=>x.id===o.id).refund_issue,'PLATFORM_FEE_NOT_ENABLED');
   assert.equal((await operations.processRefund(buyer,o.id,false)).refund_issue,'PLATFORM_FEE_NOT_ENABLED');
   capabilityBlocked=false;
  });
  await t.test('webhook deduplication and late completion do not reopen refunded orders',async()=>{
   const o=await seedPaid();await operations.requestRefund(buyer,o.id);
   const event={id:'WH-DUPLICATE',event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{id:'CAPTURE'+seq+'seller',supplementary_data:{related_ids:{order_id:o.paypal_order_id}}}};
   assert.equal((await inbox.receive(event)).status,'processed');assert.equal((await inbox.receive(event)).duplicate,true);
   const order=(await db.query('SELECT * FROM beauty_sandbox_orders WHERE id=$1::uuid',[o.id])).rows[0];assert.equal(order.refund_status,'completed');assert.equal(order.fulfillment_status,'halted');
   assert.equal((await db.query("SELECT attempts FROM beauty_sandbox_webhook_events WHERE event_id='WH-DUPLICATE'")).rows[0].attempts,1);
   await assert.rejects(inbox.receive({...event,event_type:'PAYMENT.CAPTURE.DENIED'}),/webhook_event_conflict/);
  });
  await t.test('verified external refunds and reversals halt fulfillment without blindly restoring stock',async()=>{
   const o=await seedPaid(),before=await stock();
   await inbox.receive({id:'WH-EXTERNAL',event_type:'PAYMENT.CAPTURE.REFUNDED',resource:{id:'EXTERNALREFUND',supplementary_data:{related_ids:{capture_id:'CAPTURE'+seq+'seller'}}}});
   const order=(await db.query('SELECT * FROM beauty_sandbox_orders WHERE id=$1::uuid',[o.id])).rows[0];assert.equal(order.refund_status,'external_review');assert.equal(order.payment_review,true);assert.equal(await stock(),before);
   await assert.rejects(operations.fulfillment(buyer,o.id,'ready'),/verified_payment_required/);
  });
  await t.test('verified revocation clears cached seller authorization and halts related orders',async()=>{
   const o=await seedPaid();await inbox.receive({id:'WH-REVOKED',event_type:'MERCHANT.PARTNER-CONSENT.REVOKED',resource:{merchant_id:'SELLER1'}});
   assert.equal((await db.query("SELECT permissions_granted FROM beauty_seller_payment_accounts WHERE seller_id='seller'")).rows[0].permissions_granted,false);
   assert.equal((await db.query('SELECT payment_review FROM beauty_sandbox_orders WHERE id=$1::uuid',[o.id])).rows[0].payment_review,true);
  });
  await t.test('unmatched signed events are retained for Founder review',async()=>{
   assert.equal((await inbox.receive({id:'WH-UNKNOWN',event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{id:'UNKNOWNCAPTURE'}})).status,'unmatched');
   assert.ok((await inbox.list()).some(e=>e.event_id==='WH-UNKNOWN'&&e.status==='unmatched'));
  });
  await t.test('multi-seller refunds remain pending until all captures are refunded exactly once',async()=>{
   const o=await seedPaid(true),remote=remotes.get(o.paypal_order_id),before=postCount;
   rejectCapture=remote.purchase_units[1].payments.captures[0].id;
   assert.equal((await operations.requestRefund(buyer,o.id)).refund_status,'pending');assert.equal(postCount,before+1);
   rejectCapture=null;assert.equal((await operations.processRefund(buyer,o.id,true)).refund_status,'completed');assert.equal(postCount,before+2);
   const rows=(await db.query('SELECT * FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[o.id])).rows;assert.equal(rows.length,2);assert.equal(rows.reduce((n,r)=>n+Number(r.platform_fee_cents),0),180);
  });
  await t.test('failed webhook reconciliation is durable and retryable without duplicate capture ledger rows',async()=>{
   const o=await seedPaid();await db.query('DELETE FROM beauty_sandbox_captures WHERE order_id=$1::uuid',[o.id]);await db.query("UPDATE beauty_sandbox_orders SET status='capture_pending',paid_at=NULL WHERE id=$1::uuid",[o.id]);
   const event={id:'WH-RECOVERY',event_type:'PAYMENT.CAPTURE.COMPLETED',resource:{id:'CAPTURE'+seq+'seller',supplementary_data:{related_ids:{order_id:o.paypal_order_id}}}};
   readFailures=1;await assert.rejects(inbox.receive(event),/payment_reconciliation_pending/);
   assert.equal((await db.query("SELECT status FROM beauty_sandbox_webhook_events WHERE event_id='WH-RECOVERY'")).rows[0].status,'failed');
   assert.equal((await inbox.retry(event.id)).status,'processed');assert.equal((await db.query('SELECT * FROM beauty_sandbox_captures WHERE order_id=$1::uuid',[o.id])).rows.length,1);
  });
 }finally{await db.close();}
});
