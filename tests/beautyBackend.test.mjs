import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBeautyCatalog, publicBeautyCatalog, createBeautyCatalogStore } from '../beautyCatalogService.js';
const catalog = () => ({ sellers:[{id:'seller1',name:'Brand owner',status:'approved'}], products:[{
 id:'clipper',name:'Clipper',brand:'Test',sellerId:'seller1',category:'Clippers & trimmers',
 priceCents:12000,stock:3,fulfillment:['shipping'],status:'published',revenueModel:'commission',
 commissionBps:1500,wholesaleCostCents:6000,independentBrand:true,
}] });
test('public response strips costs, terms and unpublished inventory', () => {
 const c=catalog();c.products.push({...c.products[0],id:'draft',status:'draft'});
 const result=publicBeautyCatalog(validateBeautyCatalog(c));
 assert.equal(result.products.length,1);assert.equal(result.checkoutEnabled,false);
 for(const field of ['wholesaleCostCents','commissionBps','sellerId','revenueModel','status'])
  assert.equal(field in result.products[0],false);
});
test('unapproved sellers cannot publish; suspended seller is excluded publicly', () => {
 const c=catalog();c.sellers[0].status='pending';assert.throws(()=>validateBeautyCatalog(c));
 c.sellers[0].status='suspended';assert.equal(publicBeautyCatalog(c).products.length,0);
});
test('publication requires negotiated commission; zero is explicit and valid', () => {
 const c=catalog();delete c.products[0].commissionBps;assert.throws(()=>validateBeautyCatalog(c));
 c.products[0].commissionBps=0;assert.equal(validateBeautyCatalog(c).products[0].commissionBps,0);
});
test('rejects duplicate ids, unknown sellers, unsafe quantities and missing pickup location', () => {
 for(const change of [c=>c.products.push({...c.products[0]}), c=>c.products[0].sellerId='unknown',
  c=>c.products[0].stock=-1,c=>c.products[0].priceCents=Infinity,
  c=>c.products[0].fulfillment=['pickup'],c=>c.products[0].commissionBps=10001]) {
  const c=catalog();change(c);assert.throws(()=>validateBeautyCatalog(c));
 }
});
test('save uses revision comparison and audit atomically, with bound parameters',async()=>{
 let call;
 const store=createBeautyCatalogStore(async(sql,args)=>{call={sql,args};return {rows:[{revision:3}]};});
 const result=await store.save(catalog(),2,'founder-id');assert.equal(result.revision,3);
 assert.match(call.sql,/WHERE id = 1 AND revision = \$2/);
 assert.match(call.sql,/INSERT INTO beauty_catalog_audit/);assert.equal(call.args[2],'founder-id');
 assert.equal(JSON.parse(call.args[0]).products[0].commissionBps,1500);
});
test('stale edit returns conflict and invalid revision never queries database',async()=>{
 let calls=0;const store=createBeautyCatalogStore(async()=>{calls++;return {rows:[]};});
 assert.equal(await store.save(catalog(),2,'founder-id'),null);
 await assert.rejects(store.save(catalog(),-1,'founder-id'));assert.equal(calls,1);
});
test('missing schema fails rather than reporting a fake empty catalog',async()=>{
 await assert.rejects(createBeautyCatalogStore(async()=>({rows:[]})).read());
});
