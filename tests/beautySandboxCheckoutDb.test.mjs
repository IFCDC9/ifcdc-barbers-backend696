import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createSandboxCheckout} from '../beautySandboxCheckout.js';
import {usd,cents} from '../beautySandboxPaymentContract.js';
// Optional embedded PostgreSQL integration checks; not a production dependency.
const runDb=process.env.BEAUTY_CHECKOUT_DB_TESTS==='1';
test('sandbox checkout PostgreSQL transactions and recovery',{skip:!runDb},async t=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();
 let tail=Promise.resolve();
 const pool={async connect(){const previous=tail;let unlock;tail=new Promise(r=>{unlock=r;});await previous;return {query:(...a)=>db.query(...a),release:unlock};},async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
 const buyer='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 const cat={sellers:[{id:'seller',name:'Seller',status:'approved'}],products:[{id:'product',sellerId:'seller',name:'Test product',brand:'IFCDC',category:'Hair care',priceCents:1000,stock:10,status:'published',fulfillment:['pickup'],pickupLocation:'Sandbox test location'}]};
 let requests=0,captureRequests=0,createTimeout=false,captureTimeout=false,pendingCapture=false,authorized=true;
 const remotes=new Map(),createKeys=new Map();
 const provider={config:{configured:true,environment:'sandbox',clientId:'partner-client',partnerId:'PARTNER1'},
  verify:async()=>({status:authorized?'account_authorized':'pending',merchantId:'SELLER1'}),
  request:async(path,options={})=>{
   if(path==='/v2/checkout/orders'&&options.method==='POST'){
    let r=createKeys.get(options.requestId);
    if(!r){r={...structuredClone(options.body),id:'PAYPAL'+(++requests),status:'CREATED',links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token=PAYPAL'+requests}]};remotes.set(r.id,r);createKeys.set(options.requestId,r);}
    if(createTimeout){createTimeout=false;throw Error('simulated_create_timeout');}return structuredClone(r);
   }
   const id=path.split('/')[4],r=remotes.get(id);if(!r)return null;
   if(path.endsWith('/capture')){
    captureRequests++;r.status=pendingCapture?'APPROVED':'COMPLETED';
    if(!pendingCapture)for(const [i,u] of r.purchase_units.entries())u.payments={captures:[{id:'CAP'+r.id+i,status:'COMPLETED',final_capture:true,amount:usd(cents(u.amount)),seller_receivable_breakdown:{gross_amount:usd(cents(u.amount)),paypal_fee:usd(25),platform_fees:u.payment_instruction.platform_fees,net_amount:usd(cents(u.amount)-25-cents(u.payment_instruction.platform_fees[0].amount))}}]};
    if(captureTimeout)throw Error('simulated_capture_timeout');
   }
   return structuredClone(r);
  }};
 const service=createSandboxCheckout({pool,provider,env:{BEAUTY_SANDBOX_CHECKOUT_ENABLED:'1'}});
 const items=[{productId:'product',quantity:1}],stock=async()=>Number((await db.query('SELECT catalog FROM beauty_catalog_state')).rows[0].catalog.products[0].stock);
 const approve=row=>{remotes.get(row.paypal_order_id).status='APPROVED';};
 try{
  await db.exec('CREATE TABLE app_users(id uuid PRIMARY KEY);CREATE TABLE beauty_catalog_state(id integer PRIMARY KEY,revision integer NOT NULL DEFAULT 0,catalog jsonb NOT NULL);');
  await db.query('INSERT INTO app_users(id) VALUES($1::uuid),($2::uuid)',[buyer,other]);
  await db.exec(await readFile(new URL('../scripts/migrations/beauty-sandbox-checkout.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../scripts/migrations/beauty-seller-payment-accounts.sql',import.meta.url),'utf8'));
  await db.query('INSERT INTO beauty_catalog_state(id,catalog) VALUES(1,$1::jsonb)',[JSON.stringify(cat)]);
  await db.query(`INSERT INTO beauty_seller_payment_accounts(seller_id,environment,partner_client_id,partner_id,tracking_id,merchant_id,created_by) VALUES('seller','sandbox','partner-client','PARTNER1',$1::uuid,'SELLER1',$2::uuid)`,[randomUUID(),buyer]);
  await t.test('reservation retries are idempotent, stock is deducted once, and cancellation restores once',async()=>{
   const key=randomUUID(),r=await service.reserve(buyer,key,items);assert.equal(await stock(),9);
   const retry=await service.reserve(buyer,key,items);assert.equal(retry.id,r.id);assert.equal(await stock(),9);
   await assert.rejects(service.reserve(buyer,key,[{productId:'product',quantity:2}]),/conflict/);
   await service.cancel(buyer,r.id);await service.cancel(buyer,r.id);assert.equal(await stock(),10);
  });
  await t.test('declined seller authorization rolls back reservations and failed create recovers the same PayPal order',async()=>{
   authorized=false;await assert.rejects(service.reserve(buyer,randomUUID(),items),/seller_not_authorized/);assert.equal(await stock(),10);authorized=true;
   const r=await service.reserve(buyer,randomUUID(),items);createTimeout=true;const before=requests;
   await assert.rejects(service.prepare(buyer,r.id),/simulated_create_timeout/);assert.equal(await stock(),9);
   const ready=await service.prepare(buyer,r.id);assert.equal(requests,before+1);assert.equal(ready.status,'paypal_created');
   await service.cancel(buyer,r.id);assert.equal(await stock(),10);
  });
  await t.test('captures verify payment and fees once, including response loss and repeated clicks',async()=>{
   const r=await service.reserve(buyer,randomUUID(),items),ready=await service.prepare(buyer,r.id);
   await assert.rejects(service.capture(buyer,r.id),/paypal_approval_required/);approve(ready);captureTimeout=true;
   const before=captureRequests,paid=await service.capture(buyer,r.id);assert.equal(paid.status,'paid');
   assert.equal((await service.capture(buyer,r.id)).status,'paid');assert.equal(captureRequests,before+1);
   const ledger=(await db.query('SELECT details FROM beauty_sandbox_captures WHERE order_id=$1::uuid',[r.id])).rows;
   assert.equal(ledger.length,1);assert.equal(ledger[0].details.platformFeeCents,250);assert.equal(ledger[0].details.netCents,975);
   await assert.rejects(service.cancel(buyer,r.id),/capture_must_be_reconciled/);assert.equal(await stock(),9);captureTimeout=false;
  });
  await t.test('unknown captures preserve stock and recheck never submits another capture',async()=>{
   const r=await service.reserve(buyer,randomUUID(),items),ready=await service.prepare(buyer,r.id);approve(ready);pendingCapture=true;
   const before=captureRequests,result=await service.capture(buyer,r.id);assert.equal(result.status,'review_required');assert.equal(await stock(),8);
   await service.reconcile(buyer,r.id);assert.equal(captureRequests,before+1);await assert.rejects(service.cancel(buyer,r.id),/capture_must_be_reconciled/);pendingCapture=false;
   assert.equal((await service.retryCapture(buyer,r.id)).status,'paid');assert.equal(captureRequests,before+2);assert.equal(await stock(),8);
  });
  await t.test('owner isolation and request keys survive concurrent reservation attempts',async()=>{
   const key=randomUUID(),[a,b]=await Promise.all([service.reserve(buyer,key,items),service.reserve(buyer,key,items)]);assert.equal(a.id,b.id);assert.equal(await stock(),7);
   await assert.rejects(service.prepare(other,a.id),/not_found/);await assert.rejects(service.cancel(other,a.id),/not_found/);
   await service.cancel(buyer,a.id);assert.equal(await stock(),8);
  });
  await t.test('expired and cancelled orders cannot be charged; stock remains held until release',async()=>{
   const r=await service.reserve(buyer,randomUUID(),items);await db.query("UPDATE beauty_sandbox_orders SET expires_at=now()-interval '1 minute' WHERE id=$1::uuid",[r.id]);
   await assert.rejects(service.prepare(buyer,r.id),/expired/);assert.equal(await stock(),7);
   await service.cancel(buyer,r.id);assert.equal(await stock(),8);
   const cancelled=await service.capture(buyer,r.id);assert.equal(cancelled.status,'cancelled');
  });
  await t.test('an externally completed payment prevents cancellation from releasing stock',async()=>{
   const r=await service.reserve(buyer,randomUUID(),items),ready=await service.prepare(buyer,r.id);
   const before=await stock();approve(ready);
   await provider.request('/v2/checkout/orders/'+ready.paypal_order_id+'/capture',{method:'POST'});
   const result=await service.cancel(buyer,r.id);assert.equal(result.status,'paid');assert.equal(await stock(),before);
   await assert.rejects(service.reserve(buyer,randomUUID(),[{productId:'product',quantity:before+1}]),/Invalid basket/);
   assert.equal(await stock(),before);
  });
  await t.test('revoked seller permission and withdrawn products block capture without losing the reservation',async()=>{
   const r=await service.reserve(buyer,randomUUID(),items),ready=await service.prepare(buyer,r.id);approve(ready);
   authorized=false;await assert.rejects(service.capture(buyer,r.id),/seller_not_authorized/);authorized=true;
   const current=(await db.query('SELECT catalog FROM beauty_catalog_state')).rows[0].catalog;
   current.products[0].status='draft';await db.query('UPDATE beauty_catalog_state SET catalog=$1::jsonb',[JSON.stringify(current)]);
   const before=captureRequests;await assert.rejects(service.capture(buyer,r.id),/seller_not_authorized/);assert.equal(captureRequests,before);
   current.products[0].status='published';await db.query('UPDATE beauty_catalog_state SET catalog=$1::jsonb',[JSON.stringify(current)]);
   await service.cancel(buyer,r.id);
  });
  await t.test('concurrent capture clicks submit a single capture and produce one ledger record',async()=>{
   const r=await service.reserve(buyer,randomUUID(),items),ready=await service.prepare(buyer,r.id);approve(ready);
   const before=captureRequests;await Promise.all([service.capture(buyer,r.id),service.capture(buyer,r.id)]);
   const final=await service.reconcile(buyer,r.id);assert.equal(final.status,'paid');assert.equal(captureRequests,before+1);
   assert.equal((await db.query('SELECT * FROM beauty_sandbox_captures WHERE order_id=$1::uuid',[r.id])).rows.length,1);
  });
 }finally{await db.close();}
});
