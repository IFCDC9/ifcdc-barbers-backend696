import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBeautyCatalog, filterBeautyProducts, changeBeautyBag } from '../client/src/lib/beautyCatalog.js';
const p={id:'one',name:'Clipper',brand:'Example',seller:'Sample seller',category:'Clippers & trimmers',priceCents:10001,stock:2,fulfillment:['shipping'],independentBrand:true};
test('catalog rejects non-JSON fallback payloads and duplicate IDs',()=>{assert.throws(()=>readBeautyCatalog({_nonJson:true}));assert.throws(()=>readBeautyCatalog({products:[p,p]}));});
test('catalog validates inventory, cents and pickup locations',()=>{for(const v of [{stock:-1},{priceCents:1.2},{fulfillment:['pickup']},{fulfillment:['other']}])assert.throws(()=>readBeautyCatalog({products:[{...p,...v}]}));assert.equal(readBeautyCatalog({products:[{...p,fulfillment:['pickup'],pickupLocation:'Sample location'}]}).length,1);});
test('catalog strips private supplier and commission fields',()=>{const [publicProduct]=readBeautyCatalog({products:[{...p,wholesaleCostCents:1,commissionBps:2000}]});assert.equal(publicProduct.wholesaleCostCents,undefined);assert.equal(publicProduct.commissionBps,undefined);});
test('search and fulfillment filters combine with independent brand filter',()=>{assert.equal(filterBeautyProducts([p],{query:' EXAMPLE ',independentOnly:true,fulfillment:'shipping'}).length,1);assert.equal(filterBeautyProducts([p],{fulfillment:'pickup'}).length,0);assert.equal(filterBeautyProducts([p],{category:'Hair care'}).length,0);});
test('bag respects stock, removes zero quantities and preserves input',()=>{const original={one:1};assert.deepEqual(changeBeautyBag(original,p,5),{one:2});assert.deepEqual(original,{one:1});assert.deepEqual(changeBeautyBag(original,p,-2),{});assert.deepEqual(changeBeautyBag({}, {...p,stock:0}, 1),{});});

 test('store labels use readable defaults for full or short missing keys', async () => {
  const { beautyText } = await import('../client/src/lib/beautyCatalog.js');
  assert.equal(beautyText(k => k, 'title', 'Beauty supply'), 'Beauty supply');
  assert.equal(beautyText(() => 'title', 'title', 'Beauty supply'), 'Beauty supply');
  assert.equal(beautyText(() => 'Belleza', 'title', 'Beauty supply'), 'Belleza');
 });
 test('product images allow HTTPS and reject unsafe URL schemes', () => {
  const product = {id:'photo',name:'Oil',brand:'Brand',seller:'Seller',category:'Hair care',priceCents:1500,stock:1,fulfillment:['shipping']};
  assert.equal(readBeautyCatalog({products:[{...product,imageUrl:'https://example.com/oil.jpg'}]})[0].imageUrl,'https://example.com/oil.jpg');
  for(const imageUrl of ['javascript:alert(1)','http://example.com/a.jpg','data:image/svg+xml,hello','https://user:pass@example.com/a.jpg']) assert.throws(()=>readBeautyCatalog({products:[{...product,imageUrl}]}));
 });
