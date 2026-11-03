import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalToInteger, productFromBeautyForm, changeBeautySellerStatus } from '../client/src/lib/beautyAdmin.js';
const sellers=[{id:'s1',name:'Independent brand',status:'approved'}];
const form=()=>({name:'Beard oil',brand:'Brand',sellerId:'s1',category:'Beard & shaving',price:'19.95',stock:'4',shipping:true,pickup:false,pickupLocation:'',independentBrand:true,status:'published',revenueModel:'commission',cost:'',commission:'12.50'});
test('decimal money and percentage values are converted exactly',()=>{
 assert.equal(decimalToInteger('19.95'),1995);assert.equal(decimalToInteger('0.29'),29);assert.equal(decimalToInteger('12.5'),1250);
 for(const v of ['-1','1.005','Infinity','1e3','', '999999999999999999999'])assert.throws(()=>decimalToInteger(v));
});
test('product edit preserves id and does not assume a commission',()=>{
 const f=form();const p=productFromBeautyForm(f,sellers,'p1');assert.equal(p.id,'p1');assert.equal(p.commissionBps,1250);assert.equal(p.wholesaleCostCents,null);
 f.commission='';assert.throws(()=>productFromBeautyForm(f,sellers,'p1'));
 f.status='draft';assert.equal(productFromBeautyForm(f,sellers,'p1').commissionBps,null);
 f.commission='100.01';assert.throws(()=>productFromBeautyForm(f,sellers,'p1'));
});
test('publication and fulfillment require approval and a pickup address',()=>{
 const f=form();assert.throws(()=>productFromBeautyForm(f,[{...sellers[0],status:'pending'}],'p1'));
 f.pickup=true;assert.throws(()=>productFromBeautyForm(f,sellers,'p1'));f.pickupLocation='Public shop address';assert.deepEqual(productFromBeautyForm(f,sellers,'p1').fulfillment,['shipping','pickup']);
 f.stock='1.5';assert.throws(()=>productFromBeautyForm(f,sellers,'p1'));
});
test('suspending seller drafts its published products and preserves other records',()=>{
 const c={revision:4,sellers:[...sellers],products:[{id:'p1',sellerId:'s1',status:'published'},{id:'p2',sellerId:'s2',status:'published'}]};
 const next=changeBeautySellerStatus(c,'s1','suspended');assert.equal(next.products[0].status,'draft');assert.equal(next.products[1].status,'published');assert.equal(c.products[0].status,'published');assert.equal(next.revision,4);
});
