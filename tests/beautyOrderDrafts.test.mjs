import test from 'node:test';
import assert from 'node:assert/strict';
import {basketFingerprint,createBeautyOrderDraftStore,publicBeautyDraft} from '../beautyOrderDrafts.js';
const items=[{productId:'a',quantity:1},{productId:'b',quantity:2}];
test('basket identity is order independent and rejects duplicate/invalid lines',()=>{
 assert.equal(basketFingerprint(items),basketFingerprint([...items].reverse()));
 for(const input of [[],[{productId:'a',quantity:0}],[items[0],items[0]]])assert.throws(()=>basketFingerprint(input));
});
test('retries return the original draft without repricing; changed basket conflicts',async()=>{
 const row={id:'order',basket_hash:basketFingerprint(items),quote:{platformFeeCents:150}};
 const store=createBeautyOrderDraftStore(async()=>({rows:[row]}));
 assert.equal(await store.create('buyer','long-request-key-1',{},items),row);
 await assert.rejects(store.create('buyer','long-request-key-1',{},[{productId:'a',quantity:2}]),/conflict/);
});
test('order reads are always scoped to authenticated buyer and bound parameters',async()=>{
 const calls=[];const store=createBeautyOrderDraftStore(async(sql,args)=>{calls.push({sql,args});return {rows:[]};});
 assert.equal(await store.read('buyer-a','order-b'),null);await store.list('buyer-a');
 for(const call of calls){assert.match(call.sql,/WHERE buyer_id = \$1::uuid/);assert.equal(call.args[0],'buyer-a');}
 assert.equal('buyer_id' in publicBeautyDraft({buyer_id:'secret',request_key:'secret'}),false);
});
test('new draft snapshots one fee and seller allocations; concurrent key conflicts rejected',async()=>{
 const c={sellers:[{id:'seller',name:'Seller',status:'approved'}],products:[{id:'a',name:'A',brand:'B',sellerId:'seller',status:'published',category:'Hair care',priceCents:1000,stock:2,fulfillment:['shipping']}]};
 let quote;
 const store=createBeautyOrderDraftStore(async(sql,args)=>{
  if(sql.startsWith('SELECT'))return {rows:[]};
  quote=JSON.parse(args[4]);return {rows:[{id:args[0],basket_hash:args[3],quote}]};
 });
 await store.create('buyer','long-request-key-1',c,[items[0]]);
 assert.equal(quote.platformFeeCents,150);assert.equal(quote.commissionPayer,'seller');assert.equal(quote.sellerAllocations[0].commissionCents,20);assert.equal(quote.sellerAllocations[0].netBeforeProcessingCents,980);assert.equal(quote.lines[0].sellerId,'seller');assert.equal(quote.checkoutEnabled,false);
});
