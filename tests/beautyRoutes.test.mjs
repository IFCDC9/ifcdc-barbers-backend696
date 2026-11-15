import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, copyFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import express from 'express';
// Isolate server boot/dependencies; exercise the actual router with injected auth and DB.
test('HTTP catalog routes enforce authentication, current Founder role and conflicts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beauty-route-'));
 let server;
 try {
  await writeFile(join(dir,'package.json'),'{"type":"module"}');
  await mkdir(join(dir,'client/src/lib'),{recursive:true});
  for(const file of ['beautyCustomerSandboxRoutes.js','beautySandboxOperations.js','beautySandboxRefundContract.js','beautySandboxWebhooks.js','beautySandboxCheckoutRoutes.js','beautySandboxCheckout.js','beautySandboxPaymentContract.js','beautySellerPayments.js','beautyRoutes.js','beautyCatalogService.js','beautyOrderService.js','beautyOrderDrafts.js','client/src/lib/beautyOrderPricing.js','client/src/lib/beautyCatalog.js'])
   await copyFile(new URL('../'+file,import.meta.url),join(dir,file));
  await writeFile(join(dir,'db.js'),'export const getDbPool = () => {throw Error("unexpected live database access")};export const dbQuery = () => {throw Error("unexpected live database access")};');
  await writeFile(join(dir,'authRoutes.js'),'export const resolveAuthPayload = () => null;');
  await writeFile(join(dir,'authPlatformJwt.js'),'export const isJwtGlobalSuperScope = u => u?.isSuperAdmin === true;');
  const require=createRequire(import.meta.url);
  const expressDir=dirname(require.resolve('express/package.json'));
  await mkdir(join(dir,'node_modules'));await symlink(expressDir,join(dir,'node_modules/express'));
  const {createBeautyRouter}=await import(pathToFileURL(join(dir,'beautyRoutes.js')));
  let role='super_admin', queries=0;
  const query=async sql=>{
   queries++;
   if(sql.includes('FROM app_users'))return {rows:[{role,account_status:'active'}]};
   if(sql.includes('SELECT revision, catalog'))return {rows:[{revision:0,catalog:{sellers:[],products:[]}}]};
   return {rows:[]};
  };
  const app=express();
  app.use(createBeautyRouter({query,resolveToken:t=>t==='founder'?{id:'user-id',isSuperAdmin:true}:t==='manager'?{id:'manager'}:null}));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}`;
  const request=(path,token,init={})=>fetch(url+path,{...init,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...init.headers}});
  let res=await request('/api/beauty/catalog');assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.deepEqual((await res.json()).products,[]);
  assert.equal((await request('/api/beauty/orders')).status,401);
  assert.equal((await request('/api/beauty/orders','manager')).status,200);
  assert.equal((await request('/api/beauty/orders/not-a-uuid','manager')).status,404);
  assert.equal((await request('/api/beauty/admin/sandbox-checkout','manager')).status,403);
  assert.equal((await request('/api/beauty/admin/sandbox-checkout/webhooks','manager')).status,403);
  assert.equal((await request('/api/beauty/paypal/sandbox-webhook',null,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'FAKE'})})).status,503);
  assert.equal((await request('/api/beauty/admin/sandbox-checkout')).status,401);
  assert.equal((await request('/api/beauty/admin/sandbox-checkout','founder')).status,503);
  const before=queries;
  assert.equal((await request('/api/beauty/admin/catalog')).status,401);
  assert.equal((await request('/api/beauty/admin/seller-payments/config','manager')).status,403);
  assert.equal((await request('/api/beauty/admin/catalog','manager')).status,403);assert.equal(queries,before);
  assert.equal((await request('/api/beauty/admin/catalog','founder')).status,200);
  const paymentConfig=await request('/api/beauty/admin/seller-payments/config','founder');assert.equal(paymentConfig.status,200);const pc=await paymentConfig.json();assert.equal(pc.checkoutEnabled,false);assert.equal('secret' in pc,false);
  assert.equal((await request('/api/beauty/admin/seller-payments/missing/start','founder',{method:'POST'})).status,404);
  assert.equal((await request('/api/beauty/admin/seller-payments/missing/refresh','manager',{method:'POST'})).status,403);
  role='user';assert.equal((await request('/api/beauty/admin/catalog','founder')).status,403);
  role='super_admin';
  assert.equal((await request('/api/beauty/admin/catalog','founder',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,sellers:[],products:[]})})).status,409);
  assert.equal((await request('/api/beauty/admin/catalog','founder',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,sellers:[],products:[{}]})})).status,400);
 } finally {if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('Create seller setup link maps PayPal referral diagnostics without weakening Founder auth',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beauty-seller-route-'));
 let server;
 try {
  await writeFile(join(dir,'package.json'),'{"type":"module"}');
  await mkdir(join(dir,'client/src/lib'),{recursive:true});
  for(const file of ['beautyCustomerSandboxRoutes.js','beautySandboxOperations.js','beautySandboxRefundContract.js','beautySandboxWebhooks.js','beautySandboxCheckoutRoutes.js','beautySandboxCheckout.js','beautySandboxPaymentContract.js','beautySellerPayments.js','beautyRoutes.js','beautyCatalogService.js','beautyOrderService.js','beautyOrderDrafts.js','client/src/lib/beautyOrderPricing.js','client/src/lib/beautyCatalog.js'])
   await copyFile(new URL('../'+file,import.meta.url),join(dir,file));
  await writeFile(join(dir,'db.js'),'export const getDbPool = () => {throw Error("unexpected live database access")};export const dbQuery = () => {throw Error("unexpected live database access")};');
  await writeFile(join(dir,'authRoutes.js'),'export const resolveAuthPayload = () => null;');
  await writeFile(join(dir,'authPlatformJwt.js'),'export const isJwtGlobalSuperScope = u => u?.isSuperAdmin === true;');
  const require=createRequire(import.meta.url);
  const expressDir=dirname(require.resolve('express/package.json'));
  await mkdir(join(dir,'node_modules'));await symlink(expressDir,join(dir,'node_modules/express'));
  const {createBeautyRouter}=await import(pathToFileURL(join(dir,'beautyRoutes.js')));
  const seller={id:'seller-1',name:'Seller',status:'approved'};
  const query=async sql=>{
   if(sql.includes('FROM app_users'))return {rows:[{role:'super_admin',account_status:'active'}]};
   if(sql.includes('SELECT revision, catalog'))return {rows:[{revision:1,catalog:{sellers:[seller],products:[]}}]};
   if(sql.includes('INSERT INTO beauty_seller_payment_accounts'))return {rows:[{seller_id:seller.id,status:'pending'}]};
   return {rows:[]};
  };
  const start=async()=>{const e=new Error('seller_provider_request_failed');e.code='seller_provider_request_failed';e.operation='partner_referral';e.httpStatus=422;e.issue='PLATFORM_FEE_NOT_ENABLED';e.debugId='abcdef12';e.secret='must-not-leak';throw e;};
  const app=express();
  app.use(createBeautyRouter({query,resolveToken:t=>t==='founder'?{id:'user-id',isSuperAdmin:true}:null,sellerPaymentProvider:{config:{environment:'sandbox',enabled:true,configured:true,missing:[],clientId:'app',secret:'secret',partnerId:'P',bnCode:'B'},start}}));
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url=`http://127.0.0.1:${server.address().port}`;
  const path='/api/beauty/admin/seller-payments/seller-1/start';
  assert.equal((await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  const denied=await fetch(url+path,{method:'POST',headers:{Authorization:'Bearer other','Content-Type':'application/json'},body:'{}'});
  assert.equal(denied.status,401);
  const res=await fetch(url+path,{method:'POST',headers:{Authorization:'Bearer founder','Content-Type':'application/json'},body:'{}'});
  assert.equal(res.status,503);
  const body=await res.json();
  assert.equal(body.error,'seller_provider_request_failed');assert.equal(body.stage,'partner_referral');
  assert.equal(body.httpStatus,422);assert.equal(body.issue,'PLATFORM_FEE_NOT_ENABLED');assert.equal(body.debugId,'abcdef12');
  assert.equal('secret' in body,false);assert.equal(JSON.stringify(body).includes('must-not-leak'),false);
 } finally {if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
