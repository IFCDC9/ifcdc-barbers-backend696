import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createBeautyCustomerSandboxRouter,customerSandboxEligible,customerSandboxOrder} from '../beautyCustomerSandboxRoutes.js';
const buyer='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333';
const provider={config:{configured:true,environment:'sandbox'}};
const env={BEAUTY_SANDBOX_CHECKOUT_ENABLED:'1',BEAUTY_CUSTOMER_SANDBOX_ENABLED:'1',BEAUTY_CUSTOMER_SANDBOX_BUYER_IDS:buyer};
const order={id,status:'paid',buyer_id:buyer,bindings:[{merchantId:'PRIVATE'}],paypal_order_id:'PRIVATE',quote:{lines:[{productId:'p',name:'Product',quantity:1,unitPriceCents:1000,pickupLocation:'Test location',sellerId:'private'}],subtotalCents:1000,platformFeeCents:150,totalBeforeTaxShippingCents:1150,sellerAllocations:[{merchantId:'PRIVATE'}]}};
test('customer sandbox cannot be enabled by wildcard, client flags, or live credentials',()=>{
 assert.equal(customerSandboxEligible(buyer,provider,env),true);
 assert.equal(customerSandboxEligible(other,provider,env),false);
 for(const change of [{BEAUTY_CUSTOMER_SANDBOX_ENABLED:'0'},{BEAUTY_CUSTOMER_SANDBOX_BUYER_IDS:'*'},{BEAUTY_SANDBOX_CHECKOUT_ENABLED:'0'}])assert.equal(customerSandboxEligible(buyer,provider,{...env,...change}),false);
 assert.equal(customerSandboxEligible(buyer,{config:{configured:true,environment:'live'}},env),false);
 assert.equal(customerSandboxEligible(buyer,provider,{}),false);
});
test('customer order views exclude seller proceeds, merchant bindings and PayPal identifiers',()=>{
 const output=customerSandboxOrder({...order,approval_url:'https://sandbox.paypal.com/approval'});
 assert.equal(output.quote.totalCents,1150);assert.equal(output.approvalUrl,null);
 assert.ok(!JSON.stringify(output).includes('PRIVATE'));assert.equal(output.buyer_id,undefined);assert.equal(output.quote.sellerAllocations,undefined);
 assert.equal(output.quote.lines[0].sellerId,undefined);
});
test('HTTP trial checks current account, locks identity to token, and limits customer actions',async()=>{
 const seen=[];let accountStatus='active',server;
 const service={list:async who=>{seen.push(['list',who]);return who===buyer?[order]:[];},read:async(who,orderId)=>{if(who!==buyer)throw Error('sandbox_order_not_found');seen.push(['read',who,orderId]);return order;},reserve:async(who,key,items)=>{seen.push(['reserve',who,key,items]);return order;},capture:async(who,orderId)=>{seen.push(['capture',who,orderId]);return order;},reconcile:async who=>{seen.push(['reconcile',who]);return order;}};
 const app=express();app.use('/trial',createBeautyCustomerSandboxRouter({provider,env,resolveToken:async t=>t==='buyer'?{id:buyer}:t==='other'?{id:other}:null,query:async()=>({rows:[{account_status:accountStatus}]}),getPool:()=>({}),createService:options=>{assert.equal(options.customerReturn,true);assert.equal(options.maxActiveOrders,3);return service;}}));
 try{
 server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const base=`http://127.0.0.1:${server.address().port}/trial`;
 const request=(path,token='buyer',body)=>fetch(base+path,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await request('/orders',null)).status,401);
 accountStatus='suspended';assert.equal((await request('/orders')).status,403);accountStatus='active';
 assert.equal((await (await request('/config')).json()).eligible,true);assert.equal((await (await request('/config','other')).json()).eligible,false);
 assert.equal((await request('/orders','other',{})).status,403);
 assert.equal((await request('/orders/'+id,'other')).status,404);
 const res=await request('/orders','buyer',{buyerId:other,requestKey:'key',items:[{productId:'p',quantity:1}],priceCents:1});assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.equal(seen.at(-1)[1],buyer);assert.equal(seen.at(-1).length,4);
 const before=seen.length;for(const action of ['refund','ready','collected','restock','constructor'])assert.equal((await request('/orders/'+id+'/'+action,'buyer',{})).status,404);assert.equal(seen.length,before);
 assert.equal((await request('/orders/'+id+'/capture','buyer',{})).status,200);assert.equal(seen.at(-1)[1],buyer);
 env.BEAUTY_CUSTOMER_SANDBOX_ENABLED='0';assert.equal((await request('/orders/'+id+'/capture','buyer',{})).status,403);assert.equal((await request('/orders')).status,200);assert.equal((await request('/orders/'+id+'/reconcile','buyer',{})).status,200);
 }finally{env.BEAUTY_CUSTOMER_SANDBOX_ENABLED='1';if(server)await new Promise(r=>server.close(r));}
});
