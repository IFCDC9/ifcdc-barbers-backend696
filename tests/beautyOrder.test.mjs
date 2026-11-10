import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteBeautyOrder } from '../beautyOrderService.js';
import { beautyBagTotals } from '../client/src/lib/beautyOrderPricing.js';
const product = (id,sellerId) => ({id,sellerId,name:id,brand:'Brand',category:'Hair care',priceCents:1000,stock:4,fulfillment:['shipping'],status:'published'});
const catalog={sellers:[{id:'a',name:'A',status:'approved'},{id:'b',name:'B',status:'approved'}],products:[product('one','a'),product('two','b')]};
test('multiple sellers and quantities produce exactly one fee; client amounts ignored',()=>{
 const q=quoteBeautyOrder(catalog,[{productId:'one',quantity:2,priceCents:1,platformFeeCents:0},{productId:'two',quantity:1}]);
 assert.equal(q.subtotalCents,3000);assert.equal(q.platformFeeCents,250);assert.equal(q.totalBeforeTaxShippingCents,3250);assert.equal(q.checkoutEnabled,false);
});
test('empty display has no fee; empty and invalid quotes cannot proceed',()=>{
 assert.equal(beautyBagTotals(0,0).platformFeeCents,0);
 for(const items of [[],[{productId:'one',quantity:5}],[{productId:'one',quantity:0}],[{productId:'one',quantity:1.5}],[{productId:'missing',quantity:1}],[{productId:'one',quantity:1},{productId:'one',quantity:1}]])assert.throws(()=>quoteBeautyOrder(catalog,items));
});
test('draft or suspended seller products cannot be quoted',()=>{
 const c=structuredClone(catalog);c.sellers[0].status='suspended';assert.throws(()=>quoteBeautyOrder(c,[{productId:'one',quantity:1}]));
 c.sellers[0].status='approved';c.products[0].status='draft';assert.throws(()=>quoteBeautyOrder(c,[{productId:'one',quantity:1}]));
});
test('unsafe money totals are rejected',()=>assert.throws(()=>beautyBagTotals(Number.MAX_SAFE_INTEGER,1)));
test('flat buyer fee balances a $100 order with no seller commission',()=>{
 const c=structuredClone(catalog);c.products[0].priceCents=10000;
 const q=quoteBeautyOrder(c,[{productId:'one',quantity:1,commissionCents:0,sellerId:'fake'}]);
 assert.equal(q.commissionPayer,'none');assert.equal(q.commissionCents,0);
 assert.equal(q.totalBeforeTaxShippingCents,10250);assert.equal(q.sellerNetCents,10000);
 assert.equal(q.platformRevenueCents,250);
 assert.deepEqual(q.sellerAllocations,[{sellerId:'a',grossCents:10000,commissionCents:0,netBeforeProcessingCents:10000}]);
});
test('multiple sellers have zero commission, independent of basket order',()=>{
 const c=structuredClone(catalog);c.products.forEach(p=>p.priceCents=25);
 const items=[{productId:'one',quantity:1},{productId:'two',quantity:1}];
 const q=quoteBeautyOrder(c,items), reversed=quoteBeautyOrder(c,[...items].reverse());
 assert.equal(q.platformFeeCents,250);assert.equal(q.commissionCents,0);
 assert.equal(q.sellerAllocations.length,2);
 assert.deepEqual(q.sellerAllocations,reversed.sellerAllocations);
 assert.equal(q.sellerAllocations.reduce((n,a)=>n+a.commissionCents,0),0);
 assert.equal(q.sellerAllocations.reduce((n,a)=>n+a.netBeforeProcessingCents,0)+q.platformRevenueCents,q.totalBeforeTaxShippingCents);
 assert.equal(q.sellerAllocations[0].commissionCents,0);
});
test('low-priced products never produce negative seller proceeds',()=>{
 const c=structuredClone(catalog);c.products.forEach(p=>p.priceCents=1);
 const q=quoteBeautyOrder(c,[{productId:'one',quantity:1},{productId:'two',quantity:1}]);
 assert.equal(q.commissionCents,0);assert.equal(q.totalBeforeTaxShippingCents,252);
 assert.ok(q.sellerAllocations.every(a=>a.netBeforeProcessingCents===1));
});
