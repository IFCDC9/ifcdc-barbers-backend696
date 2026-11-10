import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createSandboxCheckout} from '../beautySandboxCheckout.js';
import {createSandboxOperations} from '../beautySandboxOperations.js';
import {createSandboxWebhookStore} from '../beautySandboxWebhooks.js';
import {quoteBeautyOrder} from '../beautyOrderService.js';
import {quoteBeautyOrder as legacyQuote} from './beautyLegacyQuote.mjs';
import {sandboxPurchaseUnits,verifySandboxOrder,usd,cents} from '../beautySandboxPaymentContract.js';
test('flat fee refund PostgreSQL verification and recovery',{skip:process.env.BEAUTY_CHECKOUT_DB_TESTS!=='1'},async t=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();let tail=Promise.resolve();
 const pool={async connect(){const prior=tail;let release;tail=new Promise(r=>release=r);await prior;return {query:(...args)=>db.query(...args),release};},async query(...args){const c=await this.connect();try{return await c.query(...args);}finally{c.release();}}};
 const buyer='11111111-1111-4111-8111-111111111111';const env={BEAUTY_SANDBOX_CHECKOUT_ENABLED:'1',BEAUTY_SANDBOX_REFUNDS_ENABLED:'1'};
 const cat={sellers:['a','b'].map(id=>({id,name:id,status:'approved'})),products:['a','b'].map((id,i)=>({id,sellerId:id,name:'Test '+id,brand:'Test',status:'published',category:'Hair care',priceCents:i?500:1000,stock:30,fulfillment:['pickup'],pickupLocation:'Test location'}))};
 const orders=new Map(),refunds=new Map(),merchantByTracking=new Map();let seq=0,posts=0,lost=false,rejectSeller=null,denyZero=false,returnedFee=0;
 const provider={config:{configured:true,environment:'sandbox',clientId:'APP1',partnerId:'PARTNER1'},verify:async tracking=>({status:'account_authorized',merchantId:merchantByTracking.get(tracking)}),request:async(path,opt={})=>{
  if(path==='/v2/checkout/orders'){
   const old=[...orders.values()].find(o=>o.customKey===opt.requestId);if(old)return structuredClone(old);
   const o={...structuredClone(opt.body),id:'ORDER'+(++seq),status:'CREATED',customKey:opt.requestId,links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token=ORDER'+seq}]};orders.set(o.id,o);return structuredClone(o);
  }
  if(path.startsWith('/v2/checkout/orders/')){
   const o=orders.get(path.split('/')[4]);if(!o)return null;
   if(path.endsWith('/capture')){o.status='COMPLETED';for(const [i,u] of o.purchase_units.entries()){const fees=u.payment_instruction.platform_fees||[];u.payments={captures:[{id:'CAPTURE'+o.id+i,status:'COMPLETED',final_capture:true,amount:u.amount,seller_receivable_breakdown:{gross_amount:u.amount,paypal_fee:usd(25),platform_fees:fees,net_amount:usd(cents(u.amount)-25-(fees[0]?cents(fees[0].amount):0))}}]};}}
   return structuredClone(o);
  }
  if(path.startsWith('/v2/payments/refunds/'))return structuredClone(refunds.get(path.split('/').pop()));
  if(path.endsWith('/refund')){
   if(denyZero||Number(opt.body.payment_instruction?.platform_fees?.[0]?.amount.value)>0){const e=Error('seller_provider_request_failed');e.providerIssue='PLATFORM_FEE_NOT_ENABLED';throw e;}
   if(opt.merchantId===rejectSeller)throw Error('temporary_failure');
   posts++;const existing=[...refunds.values()].find(r=>r.custom_id===opt.requestId);if(existing)return structuredClone(existing);
   const capture=path.split('/')[4],unit=[...orders.values()].flatMap(o=>o.purchase_units).find(u=>u.payments?.captures.some(c=>c.id===capture));assert.ok(unit);
   assert.equal(opt.merchantId,unit.payee.merchant_id);assert.deepEqual(opt.body.payment_instruction,{platform_fees:[{amount:usd(0)}]});
   const response={id:'REFUND'+posts,custom_id:opt.body.custom_id,status:'COMPLETED',amount:opt.body.amount,seller_payable_breakdown:{platform_fees:[{amount:usd(returnedFee)}],net_amount:usd(cents(opt.body.amount)-returnedFee)},links:[{rel:'up',method:'GET',href:'https://api-m.sandbox.paypal.com/v2/payments/captures/'+capture}]};
   refunds.set(response.id,response);unit.payments.captures[0].status='PARTIALLY_REFUNDED';unit.payments.refunds=[{id:response.id}];
   if(lost){lost=false;throw Error('response_lost');}return structuredClone(response);
  }
  throw Error('unexpected '+path);
 }};
 const checkout=createSandboxCheckout({pool,provider,env}),ops=createSandboxOperations({pool,provider,env}),inbox=createSandboxWebhookStore({pool,provider,env});
 const stock=async()=>Number((await db.query('SELECT catalog FROM beauty_catalog_state')).rows[0].catalog.products[0].stock);
 async function paid(multi=false,legacy=false){
  let order;
  const items=[{productId:'a',quantity:1},...(multi?[{productId:'b',quantity:1}]:[])];
  if(legacy){
   const id=randomUUID(),q=legacyQuote(cat,items);order={id,quote:q,bindings:q.sellerAllocations.map(a=>({sellerId:a.sellerId,merchantId:'SELLER'+a.sellerId})),paypal_order_id:'ORDER'+(++seq)};
   const remote={id:order.paypal_order_id,intent:'CAPTURE',purchase_units:sandboxPurchaseUnits(order,'PARTNER1'),status:'APPROVED'};orders.set(remote.id,remote);
   await db.query("INSERT INTO beauty_sandbox_orders(id,buyer_id,request_key,basket_hash,partner_client_id,partner_id,status,quote,bindings,paypal_order_id) VALUES($1::uuid,$2::uuid,$3::uuid,'legacy','APP1','PARTNER1','paypal_created',$4::jsonb,$5::jsonb,$6)",[id,buyer,randomUUID(),JSON.stringify(q),JSON.stringify(order.bindings),remote.id]);
  }else{order=await checkout.reserve(buyer,randomUUID(),items);order=await checkout.prepare(buyer,order.id);orders.get(order.paypal_order_id).status='APPROVED';}
  return checkout.capture(buyer,order.id);
 }
 try{
  await db.exec('CREATE TABLE app_users(id uuid PRIMARY KEY);CREATE TABLE beauty_catalog_state(id integer PRIMARY KEY,revision integer NOT NULL DEFAULT 0,catalog jsonb NOT NULL);');await db.query('INSERT INTO app_users(id) VALUES($1::uuid)',[buyer]);
  for(const f of ['beauty-sandbox-checkout.sql','beauty-seller-payment-accounts.sql','beauty-sandbox-operations.sql'])await db.exec(await readFile(new URL('../scripts/migrations/'+f,import.meta.url),'utf8'));
  await db.query('INSERT INTO beauty_catalog_state(id,catalog) VALUES(1,$1::jsonb)',[JSON.stringify(cat)]);
  for(const id of ['a','b']){const tracking=randomUUID();merchantByTracking.set(tracking,'SELLER'+id);await db.query("INSERT INTO beauty_seller_payment_accounts(seller_id,environment,partner_client_id,partner_id,tracking_id,merchant_id,created_by) VALUES($1,'sandbox','APP1','PARTNER1',$2::uuid,$3,$4::uuid)",[id,tracking,'SELLER'+id,buyer]);}
  await t.test('$12.50 capture refunds $10 without any platform-fee return; restock remains explicit',async()=>{
   const o=await paid(),before=await stock(),count=posts;assert.equal(o.status,'paid');assert.equal(o.quote.totalBeforeTaxShippingCents,1250);
   const [a,b]=await Promise.all([ops.requestRefund(buyer,o.id),ops.requestRefund(buyer,o.id)]);assert.equal(a.refund_status,'completed');assert.equal(b.refund_status,'completed');assert.equal(posts,count+1);
   const rows=(await db.query('SELECT * FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[o.id])).rows;assert.equal(Number(rows[0].amount_cents),1000);assert.equal(Number(rows[0].platform_fee_cents),0);assert.equal(await stock(),before);
   await ops.restock(buyer,o.id);await ops.restock(buyer,o.id);assert.equal(await stock(),before+1);
  });
  await t.test('lost product-refund response is recovered without a second POST',async()=>{
   const o=await paid(),before=posts;lost=true;assert.equal((await ops.requestRefund(buyer,o.id)).refund_status,'pending');assert.equal((await ops.processRefund(buyer,o.id,false)).refund_status,'completed');assert.equal(posts,before+1);
  });
  await t.test('multi-seller product refund remains pending until all product proceeds are verified',async()=>{
   const o=await paid(true);rejectSeller='SELLERb';const before=posts;assert.equal((await ops.requestRefund(buyer,o.id)).refund_status,'pending');assert.equal(posts,before+1);rejectSeller=null;
   assert.equal((await ops.processRefund(buyer,o.id,true)).refund_status,'completed');assert.equal(posts,before+2);
   const rows=(await db.query('SELECT * FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[o.id])).rows;assert.equal(rows.reduce((n,r)=>n+Number(r.amount_cents),0),1500);assert.ok(rows.every(r=>Number(r.platform_fee_cents)===0));
  });
  await t.test('zero-contribution capability rejection stays held without an omitted-instruction fallback',async()=>{
   const o=await paid(),before=posts,beforeStock=await stock();denyZero=true;
   try{
    assert.equal((await ops.requestRefund(buyer,o.id)).refund_status,'review_required');assert.equal(posts,before);
    const row=(await db.query('SELECT * FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[o.id])).rows[0];
    assert.equal(Number(row.platform_fee_cents),0);assert.equal(row.provider_refund_id,null);
    await ops.processRefund(buyer,o.id,true);assert.equal(posts,before);
    assert.equal((await db.query('SELECT request_id FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[o.id])).rows[0].request_id,row.request_id);
    await assert.rejects(ops.restock(buyer,o.id));assert.equal(await stock(),beforeStock);
   }finally{denyZero=false;}
  });
  await t.test('completed $10 refund with $2 fee reversal stays held and rechecks use GET only',async()=>{
   const o=await paid(),before=posts,beforeStock=await stock();returnedFee=200;
   try{
    assert.equal((await ops.requestRefund(buyer,o.id)).refund_status,'review_required');assert.equal(posts,before+1);
    const row=(await db.query('SELECT * FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[o.id])).rows[0];assert.ok(row.provider_refund_id);
    assert.equal((await ops.processRefund(buyer,o.id,true)).refund_status,'review_required');assert.equal(posts,before+1);
    await assert.rejects(ops.restock(buyer,o.id));assert.equal(await stock(),beforeStock);
   }finally{returnedFee=0;}
  });
  await t.test('historical fee-return rejection stays historical and does not fall back to the new policy',async()=>{
   const o=await paid(false,true);assert.equal(o.quote.totalBeforeTaxShippingCents,1150);assert.equal((await ops.requestRefund(buyer,o.id)).refund_status,'review_required');
   const row=(await db.query('SELECT * FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[o.id])).rows[0];assert.equal(Number(row.amount_cents),1150);assert.equal(Number(row.platform_fee_cents),170);const key=row.request_id;
   await ops.processRefund(buyer,o.id,true);assert.equal((await db.query('SELECT request_id FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[o.id])).rows[0].request_id,key);
  });
  await t.test('known product-refund webhook reconciles without issuing another refund',async()=>{
   const o=await paid();lost=true;await ops.requestRefund(buyer,o.id);const before=posts;
   const row=(await db.query('SELECT * FROM beauty_sandbox_refunds WHERE order_id=$1::uuid',[o.id])).rows[0],ref=[...refunds.values()].find(r=>r.custom_id===row.request_id);
   const event={id:'WH-FLAT-REFUND',event_type:'PAYMENT.CAPTURE.REFUNDED',resource:{id:ref.id,custom_id:row.request_id,supplementary_data:{related_ids:{capture_id:row.capture_id,order_id:o.paypal_order_id}}}};
   assert.equal((await inbox.receive(event)).status,'processed');await inbox.receive(event);assert.equal(posts,before);assert.equal((await checkout.read(buyer,o.id)).refund_status,'completed');
  });
 }finally{await db.close();}
});
