import test from 'node:test';
import assert from 'node:assert/strict';
import {sandboxPurchaseUnits,verifySandboxOrder,safeSandboxApprovalLink,usd,cents} from '../beautySandboxPaymentContract.js';
import {assertSandboxCheckout} from '../beautySandboxCheckout.js';
const order=()=>({id:'order-uuid',paypal_order_id:'PAYPAL1',bindings:[{sellerId:'a',merchantId:'SELLER1'},{sellerId:'b',merchantId:'SELLER2'}],quote:{pricingPolicy:'seller_commission_v1',commissionPayer:'seller',platformFeeCents:150,totalBeforeTaxShippingCents:1650,sellerAllocations:[{sellerId:'a',grossCents:1000,commissionCents:20},{sellerId:'b',grossCents:500,commissionCents:10}]}});
function remote(o,captured=true){
 const units=sandboxPurchaseUnits(o,'PARTNER1');
 if(captured)for(const [i,u] of units.entries())u.payments={captures:[{id:'CAP'+i,status:'COMPLETED',final_capture:true,amount:usd(cents(u.amount)),seller_receivable_breakdown:{gross_amount:usd(cents(u.amount)),paypal_fee:usd(50),platform_fees:u.payment_instruction.platform_fees,net_amount:usd(cents(u.amount)-50-cents(u.payment_instruction.platform_fees[0].amount))}}]};
 return {id:o.paypal_order_id,intent:'CAPTURE',status:captured?'COMPLETED':'APPROVED',purchase_units:units};
}
test('one fixed fee across sellers; every purchase unit has an explicit seller and platform fee',()=>{
 const o=order(),u=sandboxPurchaseUnits(o,'PARTNER1');
 assert.equal(u.reduce((n,u)=>n+cents(u.amount),0),1650);
 assert.equal(cents(u[0].payment_instruction.platform_fees[0].amount),170);
 assert.equal(cents(u[1].payment_instruction.platform_fees[0].amount),10);
 assert.equal(u[0].payee.merchant_id,'SELLER1');assert.equal(u[1].payee.merchant_id,'SELLER2');
 assert.throws(()=>sandboxPurchaseUnits({...o,quote:{...o.quote,commissionPayer:'buyer'}},'PARTNER1'));
});
test('sandbox cannot be enabled with live credentials',()=>{
 assert.throws(()=>assertSandboxCheckout({config:{configured:true,environment:'live'}},{BEAUTY_SANDBOX_CHECKOUT_ENABLED:'1'}));
 assert.throws(()=>assertSandboxCheckout({config:{configured:true,environment:'sandbox'}},{}));
 assert.doesNotThrow(()=>assertSandboxCheckout({config:{configured:true,environment:'sandbox'}},{BEAUTY_SANDBOX_CHECKOUT_ENABLED:'1'}));
});
test('exact completed captures reconcile fees and seller net amounts',()=>{
 const o=order(),r=remote(o),cs=verifySandboxOrder(r,o,'PARTNER1',{captured:true});
 assert.equal(cs.length,2);assert.equal(cs.reduce((n,c)=>n+c.platformFeeCents,0),180);
 assert.equal(cs.reduce((n,c)=>n+c.netCents+c.processingFeeCents+c.platformFeeCents,0),1650);
});
test('wrong amount, currency, payee, invoice, order id or platform commission cannot become paid',()=>{
 const o=order();
 for(const mutate of [r=>r.id='OTHER',r=>r.purchase_units[0].amount.value='0.01',r=>r.purchase_units[0].payee.merchant_id='OTHER',r=>r.purchase_units[0].invoice_id='OTHER',r=>r.purchase_units[0].payments.captures[0].amount.currency_code='EUR',r=>r.purchase_units[0].payments.captures[0].seller_receivable_breakdown.platform_fees[0].amount.value='0.01']){
 const r=remote(o);mutate(r);assert.throws(()=>verifySandboxOrder(r,o,'PARTNER1',{captured:true}));
 }
});
test('partial, pending, duplicate and missing captures cannot become paid',()=>{
 const o=order();for(const mutate of [r=>r.purchase_units.pop(),r=>r.purchase_units[0].payments.captures[0].status='PENDING',r=>r.purchase_units[0].payments.captures=[],r=>r.purchase_units[1].payments.captures[0].id='CAP0',r=>r.purchase_units[0].payments.captures[0].final_capture=false]){
 const r=remote(o);mutate(r);assert.throws(()=>verifySandboxOrder(r,o,'PARTNER1',{captured:true}));
 }
});
test('fees must match before capture and redirects must remain on sandbox PayPal',()=>{
 const o=order(),r=remote(o,false);assert.doesNotThrow(()=>verifySandboxOrder(r,o,'PARTNER1'));
 r.purchase_units[0].payment_instruction.platform_fees[0].amount.value='0.01';assert.throws(()=>verifySandboxOrder(r,o,'PARTNER1'));
 assert.equal(safeSandboxApprovalLink({links:[{rel:'approve',href:'https://www.sandbox.paypal.com/checkoutnow?token=TEST'}]}),'https://www.sandbox.paypal.com/checkoutnow?token=TEST');
 for(const href of ['https://www.paypal.com/checkout','https://evil.example','javascript:alert(1)'])assert.throws(()=>safeSandboxApprovalLink({links:[{rel:'approve',href}]}));
});
test('money parsing does not use floating point rounding',()=>{
 assert.equal(cents(usd(123456)),123456);assert.throws(()=>cents({currency_code:'USD',value:'1.005'}));assert.throws(()=>usd(Number.MAX_SAFE_INTEGER+1));
});
